import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Config } from '../config';
import { withTx } from '../db';
import { priceOrder } from '../domain/pricing';
import type { Catalog } from '../domain/types';
import type { AgentTurnResult, ChatMessage, ConversationRuntime } from '../runtime';
import { HttpError, OrderItems, safeEqual, UUID, type NewOrder } from './shared';

export interface ConversationDeps {
  cfg: Config;
  pool: Pool;
  conversations?: ConversationRuntime;
  getCatalog: () => Promise<Catalog>;
  placeOrder: (
    body: NewOrder,
    log: FastifyRequest['log'],
    conversationId?: string | null,
  ) => Promise<{ id: string; accessToken: string; estimatedTotalCents: number }>;
  isStaff: (req: FastifyRequest) => boolean;
  parseOrder: (input: unknown) => NewOrder;
}

/** Channels a conversation can arrive on. Web and app chats place orders with channel "agent". */
export const CONVERSATION_CHANNELS = ['web', 'app', 'phone', 'whatsapp', 'email'] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];

const HISTORY_LIMIT = 30;
const MAX_MESSAGES_PER_CONVERSATION = 400;
const PROPOSAL_TTL_MINUTES = 30;
const AGENT_REPLY_TIMEOUT_MS = 90_000;
const FALLBACK_REPLY =
  "Sorry, I can't help right now. You can still order from the menu, or try again in a moment.";

const NewConversation = z.object({
  channel: z.enum(['web', 'app']).default('web'),
  harness: z.string().trim().min(1).max(40).optional(),
});
const NewMessage = z.object({ text: z.string().trim().min(1).max(2000) });
const NewProposal = z.object({
  conversationId: UUID,
  fulfillment: z.enum(['delivery', 'pickup']),
  items: OrderItems,
  customerName: z.string().trim().min(1).max(100).nullish(),
  phone: z.string().trim().min(5).max(30).nullish(),
  address: z.string().trim().min(3).max(300).nullish(),
});
const ConfirmProposal = z.object({
  customerName: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().min(5).max(30).optional(),
  address: z.string().trim().min(3).max(300).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

const token = (): string => randomBytes(24).toString('base64url');

function presented(req: FastifyRequest, header: string): string {
  const h = req.headers[header];
  const q = (req.query as Record<string, unknown>).token;
  return typeof h === 'string' ? h : typeof q === 'string' ? q : '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const toProposalView = (r: any) => ({
  id: r.id,
  accessToken: r.access_token,
  status: r.status === 'open' && new Date(r.expires_at).getTime() < Date.now() ? 'expired' : r.status,
  fulfillment: r.fulfillment,
  items: r.priced_items,
  deliveryFeeCents: r.delivery_fee_cents,
  totalCents: r.total_cents,
  customerName: r.customer_name,
  phone: r.phone,
  address: r.address,
  expiresAt: r.expires_at,
  orderId: r.order_id,
});

/**
 * Conversations with the ordering agent, and the proposals it makes.
 *
 * The security boundary is here, not in the agent: an agent worker holds a token that lets it
 * read the menu, create a server-priced *proposal* and read the status of its own conversation's
 * orders. It cannot create an order, set a price, pay or change an order. An order only exists
 * after the customer confirms a proposal with their own token.
 */
export function registerConversationRoutes(app: FastifyInstance, deps: ConversationDeps): void {
  const { cfg, pool, conversations, getCatalog, placeOrder, isStaff, parseOrder } = deps;

  const requireAgent = (req: FastifyRequest): void => {
    const t = req.headers['x-agent-token'];
    if (typeof t !== 'string' || !safeEqual(t, cfg.agentToken)) throw new HttpError(401, 'Agent token is missing or wrong');
  };

  const conversationId = (req: FastifyRequest): string => UUID.parse((req.params as { id: string }).id);

  const requireConversation = async (req: FastifyRequest): Promise<{ id: string; channel: string; harness: string | null }> => {
    const id = conversationId(req);
    const t = presented(req, 'x-conversation-token');
    const res = await pool.query('select access_token, channel, harness from conversations where id = $1', [id]);
    const row = res.rows[0];
    if (!row || t === '' || !safeEqual(t, row.access_token)) throw new HttpError(404, 'Conversation not found');
    return { id, channel: row.channel, harness: row.harness };
  };

  const openProposal = async (id: string) => {
    const res = await pool.query(
      `select * from order_proposals
        where conversation_id = $1 and status = 'open' and expires_at > now()
        order by created_at desc limit 1`,
      [id],
    );
    return res.rows[0] ? toProposalView(res.rows[0]) : null;
  };

  // --- customer ---

  app.post('/api/conversations', async (req, reply) => {
    const body = NewConversation.parse(req.body ?? {});
    // Choosing the harness is for demos and evaluation, not for customers.
    if (body.harness && !isStaff(req)) throw new HttpError(403, 'Only staff can choose the agent harness');
    const id = randomUUID();
    const accessToken = token();
    await pool.query('insert into conversations (id, access_token, channel, harness) values ($1, $2, $3, $4)', [
      id,
      accessToken,
      body.channel,
      body.harness ?? null,
    ]);
    return reply.code(201).send({ id, accessToken });
  });

  app.get('/api/conversations/:id', async (req) => {
    const { id, channel } = await requireConversation(req);
    const [messages, orders] = await Promise.all([
      pool.query(
        'select role, content, created_at from conversation_messages where conversation_id = $1 order by id',
        [id],
      ),
      pool.query(
        'select id, access_token, status from orders where conversation_id = $1 order by created_at desc limit 20',
        [id],
      ),
    ]);
    return {
      id,
      channel,
      messages: messages.rows.map((m) => ({ role: m.role, content: m.content, at: m.created_at })),
      proposal: await openProposal(id),
      orders: orders.rows.map((o) => ({ id: o.id, accessToken: o.access_token, status: o.status })),
    };
  });

  app.post('/api/conversations/:id/messages', async (req) => {
    const conv = await requireConversation(req);
    const { text } = NewMessage.parse(req.body);
    return converse(conv, text, req.log);
  });

  /**
   * One turn: store the message, let the agent answer, store the answer and the run record.
   * Also used by the channel adapters (phone, WhatsApp, email), which is why it is a function.
   */
  async function converse(
    conv: { id: string; channel: string; harness: string | null },
    text: string,
    log: FastifyRequest['log'],
  ) {
    if (!conversations) throw new HttpError(503, 'The ordering assistant is not available');
    const prior = await pool.query(
      `select role, content from (
         select id, role, content from conversation_messages where conversation_id = $1 order by id desc limit $2
       ) recent order by id`,
      [conv.id, HISTORY_LIMIT],
    );
    const count = await pool.query('select count(*)::int as n from conversation_messages where conversation_id = $1', [
      conv.id,
    ]);
    if (count.rows[0].n >= MAX_MESSAGES_PER_CONVERSATION) {
      throw new HttpError(429, 'This conversation has become too long. Please start a new one.');
    }
    await pool.query(`insert into conversation_messages (conversation_id, role, content) values ($1, 'user', $2)`, [
      conv.id,
      text,
    ]);

    const started = Date.now();
    let turn: AgentTurnResult;
    try {
      turn = await withTimeout(
        conversations.send(conv.id, text, prior.rows as ChatMessage[], conv.harness),
        AGENT_REPLY_TIMEOUT_MS,
      );
    } catch (err) {
      log.error(err, 'agent turn failed');
      turn = {
        reply: FALLBACK_REPLY,
        proposal_id: null,
        harness: 'unavailable',
        model: null,
        outcome: 'failed',
        tool_calls: 0,
        blocked_tool_calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        duration_ms: Date.now() - started,
      };
    }

    await withTx(pool, async (tx) => {
      await tx.query(`insert into conversation_messages (conversation_id, role, content) values ($1, 'agent', $2)`, [
        conv.id,
        turn.reply,
      ]);
      await tx.query(
        `insert into agent_runs (conversation_id, channel, harness, model, outcome, tool_calls, blocked_tool_calls,
                                 input_tokens, output_tokens, duration_ms)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          conv.id,
          conv.channel,
          turn.harness,
          turn.model,
          turn.outcome,
          turn.tool_calls,
          turn.blocked_tool_calls,
          turn.input_tokens,
          turn.output_tokens,
          turn.duration_ms,
        ],
      );
      await tx.query('update conversations set updated_at = now() where id = $1', [conv.id]);
    });
    // The proposal is read from the database, not taken from the agent's word.
    return { reply: turn.reply, outcome: turn.outcome, proposal: await openProposal(conv.id) };
  }

  app.get('/api/proposals/:id', async (req) => {
    const id = conversationId(req);
    const res = await pool.query('select * from order_proposals where id = $1', [id]);
    const row = res.rows[0];
    const t = presented(req, 'x-proposal-token');
    if (!row || t === '' || !safeEqual(t, row.access_token)) throw new HttpError(404, 'Proposal not found');
    const order = row.order_id
      ? (await pool.query('select access_token from orders where id = $1', [row.order_id])).rows[0]
      : null;
    return {
      ...toProposalView(row),
      orderAccessToken: order?.access_token ?? null,
      restaurant: cfg.restaurant,
      deliveryRadiusKm: cfg.deliveryRadiusKm,
    };
  });

  /** The customer accepts the agent's proposal. This, not the agent, is what creates the order. */
  app.post('/api/proposals/:id/confirm', async (req, reply) => {
    const id = conversationId(req);
    const t = presented(req, 'x-proposal-token');
    const body = ConfirmProposal.parse(req.body ?? {});

    const result = await withTx(pool, async (tx) => {
      // The row lock makes a double click or a retried request wait and then see "confirmed".
      const res = await tx.query(
        `select p.*, c.channel as conversation_channel, o.access_token as order_access_token
           from order_proposals p
           left join conversations c on c.id = p.conversation_id
           left join orders o on o.id = p.order_id
          where p.id = $1 for update of p`,
        [id],
      );
      const p = res.rows[0];
      if (!p || t === '' || !safeEqual(t, p.access_token)) throw new HttpError(404, 'Proposal not found');
      if (p.status === 'confirmed') return { id: p.order_id as string, accessToken: p.order_access_token as string };
      if (p.status !== 'open') throw new HttpError(409, 'This proposal has been replaced by a newer one');
      if (new Date(p.expires_at).getTime() < Date.now()) {
        throw new HttpError(410, 'This proposal has expired. Ask for a new one.');
      }

      const channel = !p.conversation_channel || ['web', 'app'].includes(p.conversation_channel) ? 'agent' : p.conversation_channel;
      const order = parseOrder({
        customerName: body.customerName ?? p.customer_name ?? undefined,
        phone: body.phone ?? p.phone ?? undefined,
        fulfillment: p.fulfillment,
        address: body.address ?? p.address ?? undefined,
        lat: body.lat,
        lng: body.lng,
        channel,
        items: p.items,
      });
      const placed = await placeOrder(order, req.log, p.conversation_id);
      await tx.query(`update order_proposals set status = 'confirmed', order_id = $2 where id = $1`, [id, placed.id]);
      return { id: placed.id, accessToken: placed.accessToken };
    });
    return reply.code(201).send(result);
  });

  // --- agent workers ---

  app.post('/api/agent/proposals', async (req, reply) => {
    requireAgent(req);
    const body = NewProposal.parse(req.body);
    const conv = await pool.query('select 1 from conversations where id = $1', [body.conversationId]);
    if (!conv.rowCount) throw new HttpError(404, 'Conversation not found');

    // Priced here, from the server's catalog. Whatever the agent believes the price is does not matter.
    const priced = priceOrder(body.items, await getCatalog(), body.fulfillment, cfg.deliveryFeeCents);
    const id = randomUUID();
    const row = await withTx(pool, async (tx) => {
      await tx.query(
        `update order_proposals set status = 'superseded' where conversation_id = $1 and status = 'open'`,
        [body.conversationId],
      );
      const res = await tx.query(
        `insert into order_proposals (id, access_token, conversation_id, fulfillment, items, priced_items,
                                      delivery_fee_cents, total_cents, customer_name, phone, address, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(mins => $12))
         returning *`,
        [
          id,
          token(),
          body.conversationId,
          body.fulfillment,
          JSON.stringify(body.items),
          JSON.stringify(priced.items),
          priced.deliveryFeeCents,
          priced.totalCents,
          body.customerName ?? null,
          body.phone ?? null,
          body.address ?? null,
          PROPOSAL_TTL_MINUTES,
        ],
      );
      return res.rows[0];
    });
    // No access token in the answer: the agent cannot confirm its own proposal.
    const { accessToken: _omit, ...view } = toProposalView(row);
    return reply.code(201).send(view);
  });

  app.get('/api/agent/conversations/:id/orders', async (req) => {
    requireAgent(req);
    const id = conversationId(req);
    const res = await pool.query(
      `select id, status, fulfillment, total_cents, cancel_reason, created_at, driver_id
         from orders where conversation_id = $1 order by created_at desc limit 5`,
      [id],
    );
    return {
      orders: res.rows.map((o) => ({
        ref: (o.id as string).slice(0, 8),
        status: o.status,
        fulfillment: o.fulfillment,
        totalCents: o.total_cents,
        cancelReason: o.cancel_reason,
        createdAt: o.created_at,
        driverAssigned: o.driver_id !== null,
      })),
    };
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply from the agent within ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
