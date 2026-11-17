/**
 * The agent's side of the API against a real Postgres (runs when TEST_DATABASE_URL is set).
 * The key claims: an agent can only propose, the server sets the price, and an order exists
 * only after the customer confirms, exactly once.
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app';
import { EventHub } from '../src/api/hub';
import { loadConfig, type Config } from '../src/config';
import { createPool } from '../src/db';
import { migrate } from '../src/migrate';
import type { AgentTurnResult, ChatMessage, ConversationRuntime, OrderRuntime } from '../src/runtime';

const databaseUrl = process.env.TEST_DATABASE_URL;

const noopRuntime = (started: string[]): OrderRuntime => ({
  start: async (id) => void started.push(id),
  paymentResult: async () => undefined,
  kitchenDecision: async () => undefined,
  kitchenReady: async () => undefined,
  driverAssigned: async () => undefined,
  handedOver: async () => undefined,
  cancel: async () => undefined,
  close: async () => undefined,
});

/** Stands in for the agent workers: answers with whatever the test queued, or fails. */
class FakeAgent implements ConversationRuntime {
  calls: { conversationId: string; text: string; history: ChatMessage[]; harness?: string | null }[] = [];
  next: Partial<AgentTurnResult> | Error = {};
  act?: (conversationId: string) => Promise<void>;
  async send(conversationId: string, text: string, history: ChatMessage[], harness?: string | null) {
    this.calls.push({ conversationId, text, history, harness });
    if (this.next instanceof Error) throw this.next;
    await this.act?.(conversationId);
    return {
      reply: 'ok',
      proposal_id: null,
      harness: 'fake',
      model: 'fake-model',
      outcome: 'replied' as const,
      tool_calls: 1,
      blocked_tool_calls: 0,
      input_tokens: 10,
      output_tokens: 5,
      duration_ms: 3,
      ...this.next,
    };
  }
}

describe.skipIf(!databaseUrl)('conversations and proposals', () => {
  let pool: Pool;
  let cfg: Config;
  let app: FastifyInstance;
  let hub: EventHub;
  let agent: FakeAgent;
  const started: string[] = [];
  const agentAuth = { 'x-agent-token': 'dev-agent-token' };

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    cfg = loadConfig();
    await migrate(cfg.databaseUrl, () => undefined);
    pool = createPool(cfg.databaseUrl);
    hub = new EventHub(cfg.databaseUrl, { info: () => undefined, error: () => undefined });
    await hub.start();
    agent = new FakeAgent();
    app = buildApp({ cfg, pool, runtime: noopRuntime(started), conversations: agent, hub, logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await hub?.stop();
    await app?.close();
    await pool?.end();
  });

  const newConversation = async () =>
    (await app.inject({ method: 'POST', url: '/api/conversations', payload: {} })).json() as {
      id: string;
      accessToken: string;
    };
  const propose = (conversationId: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/agent/proposals',
      headers: agentAuth,
      payload: {
        conversationId,
        fulfillment: 'pickup',
        items: [{ productId: 'pepperoni', size: 'large', quantity: 2, without: ['onion'] }],
        ...extra,
      },
    });
  const say = (c: { id: string; accessToken: string }, text: string) =>
    app.inject({
      method: 'POST',
      url: `/api/conversations/${c.id}/messages`,
      headers: { 'x-conversation-token': c.accessToken },
      payload: { text },
    });

  it('stores both sides of a turn, records the run and passes earlier messages as history', async () => {
    const c = await newConversation();
    agent.next = { reply: 'Hello! What would you like?' };
    const first = await say(c, 'hi');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ reply: 'Hello! What would you like?', proposal: null });

    agent.next = { reply: 'Sure.' };
    await say(c, 'a margherita');
    expect(agent.calls.at(-1)).toMatchObject({
      conversationId: c.id,
      text: 'a margherita',
      history: [
        { role: 'user', content: 'hi' },
        { role: 'agent', content: 'Hello! What would you like?' },
      ],
    });

    const view = await app.inject({ url: `/api/conversations/${c.id}?token=${c.accessToken}` });
    expect(view.json().messages.map((m: { role: string }) => m.role)).toEqual(['user', 'agent', 'user', 'agent']);
    const runs = await pool.query('select harness, model, outcome, input_tokens from agent_runs where conversation_id = $1', [c.id]);
    expect(runs.rows).toHaveLength(2);
    expect(runs.rows[0]).toEqual({ harness: 'fake', model: 'fake-model', outcome: 'replied', input_tokens: 10 });
    const bi = await pool.query(`select turns from bi_agent_daily where harness = 'fake'`);
    expect(Number(bi.rows[0].turns)).toBeGreaterThanOrEqual(2);
  });

  it('answers with a fallback and records a failed run when the agent is unavailable', async () => {
    const c = await newConversation();
    agent.next = new Error('no workers');
    const res = await say(c, 'hello?');
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('failed');
    expect(res.json().reply).toMatch(/order from the menu/);
    const runs = await pool.query('select outcome, harness from agent_runs where conversation_id = $1', [c.id]);
    expect(runs.rows).toEqual([{ outcome: 'failed', harness: 'unavailable' }]);
    agent.next = {};
  });

  it('keeps conversations private to their token holder', async () => {
    const c = await newConversation();
    expect((await app.inject({ url: `/api/conversations/${c.id}` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/conversations/${c.id}?token=wrong` })).statusCode).toBe(404);
    const other = await newConversation();
    expect((await app.inject({ url: `/api/conversations/${c.id}?token=${other.accessToken}` })).statusCode).toBe(404);
    const harness = await app.inject({ method: 'POST', url: '/api/conversations', payload: { harness: 'scripted' } });
    expect(harness.statusCode).toBe(403);
  });

  it('lets the agent propose only: server-side price, no token back, no order', async () => {
    const c = await newConversation();
    expect((await app.inject({ method: 'POST', url: '/api/agent/proposals', payload: {} })).statusCode).toBe(401);

    const res = await propose(c.id, { totalCents: 1, items: [{ productId: 'pepperoni', size: 'large', quantity: 2, without: ['onion'], unitPriceCents: 1 }] });
    expect(res.statusCode).toBe(201);
    const proposal = res.json();
    expect(proposal.totalCents).toBe(2 * 1690);
    expect(proposal.items[0]).toMatchObject({ name: 'Pepperoni', unitPriceCents: 1690, withoutNames: ['Red onion'] });
    expect(proposal.accessToken).toBeUndefined();
    expect((await pool.query('select count(*)::int as n from orders where conversation_id = $1', [c.id])).rows[0].n).toBe(0);

    // The agent token opens nothing else.
    expect((await app.inject({ url: '/api/staff/orders', headers: agentAuth })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/proposals/${proposal.id}/confirm`, headers: agentAuth, payload: {} })).statusCode).toBe(404);

    const bad = await propose(c.id, { items: [{ productId: 'calzone', quantity: 1 }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/not available/);
  });

  it('shows the customer the newest proposal and creates exactly one order on confirm', async () => {
    const c = await newConversation();
    await propose(c.id);
    // The agent proposes during its turn; the API reads the proposal from the database afterwards.
    agent.act = async (id) => void (await propose(id, { customerName: 'Maija', fulfillment: 'pickup' }));
    agent.next = { reply: 'Confirm below.', outcome: 'proposed' };
    const turn = (await say(c, '2 large pepperoni no onion')).json();
    agent.act = undefined;
    agent.next = {};
    expect(turn.proposal).toMatchObject({ status: 'open', totalCents: 3380, customerName: 'Maija' });
    const { id, accessToken } = turn.proposal;
    const statuses = await pool.query('select status from order_proposals where conversation_id = $1 order by created_at', [c.id]);
    expect(statuses.rows.map((r) => r.status)).toEqual(['superseded', 'open']);

    const confirm = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/api/proposals/${id}/confirm`, headers: { 'x-proposal-token': accessToken }, payload });

    // Missing phone number: nothing is created.
    expect((await confirm({})).statusCode).toBe(400);
    expect((await confirm({ phone: '0401234567' })).statusCode).toBe(201);
    const [a, b] = await Promise.all([confirm({ phone: '0401234567' }), confirm({ phone: '0401234567' })]);
    expect(a.json().id).toBe(b.json().id);

    const orders = await pool.query('select id, channel, customer_name, items from orders where conversation_id = $1', [c.id]);
    expect(orders.rows).toHaveLength(1);
    expect(orders.rows[0]).toMatchObject({ id: a.json().id, channel: 'agent', customer_name: 'Maija' });
    expect(started).toContain(a.json().id);

    // The customer can open the order with the token from the confirmation, and the agent can see its status.
    expect((await app.inject({ url: `/api/orders/${a.json().id}?token=${a.json().accessToken}` })).statusCode).toBe(200);
    const status = await app.inject({ url: `/api/agent/conversations/${c.id}/orders`, headers: agentAuth });
    expect(status.json().orders).toEqual([expect.objectContaining({ status: 'created', ref: a.json().id.slice(0, 8) })]);
    const funnel = await pool.query(`select with_order from bi_conversation_funnel where channel = 'web'`);
    expect(Number(funnel.rows[0].with_order)).toBeGreaterThanOrEqual(1);
  });

  it('requires a delivery location at confirmation and refuses expired or replaced proposals', async () => {
    const c = await newConversation();
    const first = (await propose(c.id, { fulfillment: 'delivery', customerName: 'Olli', phone: '0401234567', address: 'Testikatu 1' })).json();
    const firstToken = (await pool.query('select access_token from order_proposals where id = $1', [first.id])).rows[0].access_token;
    expect(first.deliveryFeeCents).toBe(cfg.deliveryFeeCents);
    const confirm = (id: string, token: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/api/proposals/${id}/confirm`, headers: { 'x-proposal-token': token }, payload });

    expect((await confirm(first.id, firstToken, {})).statusCode).toBe(400); // no map location
    const far = await confirm(first.id, firstToken, { lat: cfg.restaurant.lat + 1, lng: cfg.restaurant.lng });
    expect(far.statusCode).toBe(400);
    expect(far.json().error).toMatch(/outside the delivery area/);

    const second = (await propose(c.id)).json();
    expect((await confirm(first.id, firstToken, { lat: cfg.restaurant.lat, lng: cfg.restaurant.lng })).statusCode).toBe(409);

    await pool.query(`update order_proposals set expires_at = now() - interval '1 minute' where id = $1`, [second.id]);
    const secondToken = (await pool.query('select access_token from order_proposals where id = $1', [second.id])).rows[0].access_token;
    expect((await confirm(second.id, secondToken, { customerName: 'Olli', phone: '0401234567' })).statusCode).toBe(410);
    expect((await pool.query('select count(*)::int as n from orders where conversation_id = $1', [c.id])).rows[0].n).toBe(0);
  });
});
