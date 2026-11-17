/**
 * Talk to the ordering agent from the terminal, through the same API as the web chat.
 *
 *   npm run chat -- "two large pepperoni without onion, pickup"
 *   npm run chat -- --confirm --pay --wait "a margherita and a cola, pickup"   (also confirms, pays and waits for the order to finish)
 *
 * Each argument is one message. --confirm accepts the agent's last proposal as a pickup customer;
 * --pay pays it with the simulated payment provider; --wait then follows the order to completion
 * (needs the kitchen simulator or a real kitchen).
 * Exits non-zero if the agent fails, makes no proposal when one is expected, or the order does not complete.
 */
const apiUrl = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

async function call<T>(path: string, headers: Record<string, string>, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as T & { error?: string };
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data?.error ?? ''}`);
  return data;
}

interface Turn {
  reply: string;
  outcome: string;
  proposal: { id: string; accessToken: string; totalCents: number; fulfillment: string } | null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const wait = args.includes('--wait');
  const pay = args.includes('--pay');
  const messages = args.filter((a) => !a.startsWith('--'));
  if (messages.length === 0) throw new Error('Give at least one message');

  const conv = await call<{ id: string; accessToken: string }>('/api/conversations', {}, {});
  const auth = { 'x-conversation-token': conv.accessToken };
  let last: Turn | undefined;
  for (const text of messages) {
    console.log(`you:   ${text}`);
    last = await call<Turn>(`/api/conversations/${conv.id}/messages`, auth, { text });
    console.log(`agent: ${last.reply}`);
    if (last.outcome === 'failed') throw new Error('the agent failed to answer');
  }
  if (!confirm) return;

  const proposal = last?.proposal;
  if (!proposal) throw new Error('the agent made no proposal to confirm');
  if (proposal.fulfillment !== 'pickup') throw new Error('--confirm only handles pickup (delivery needs a map location)');
  const order = await call<{ id: string; accessToken: string }>(
    `/api/proposals/${proposal.id}/confirm`,
    { 'x-proposal-token': proposal.accessToken },
    { customerName: 'Chat test', phone: '0400000000' },
  );
  console.log(`order: ${order.id} confirmed, total ${(proposal.totalCents / 100).toFixed(2)} €`);
  if (!wait && !pay) return;

  const deadline = Date.now() + Number(process.env.CHAT_WAIT_MS ?? 120_000);
  let status = '';
  while (Date.now() < deadline) {
    const o = await call<{ status: string; channel: string }>(`/api/orders/${order.id}`, { 'x-order-token': order.accessToken });
    if (o.status !== status) console.log(`order: ${(status = o.status)}`);
    if (status === 'awaiting_payment' && pay) {
      // Retried on the next round if the payment is not open yet or the simulated provider hiccups.
      await call(`/api/orders/${order.id}/pay`, { 'x-order-token': order.accessToken }, {}).catch(() => undefined);
      if (!wait) return;
    }
    if (status === 'completed') {
      const after = await call<Turn>(`/api/conversations/${conv.id}/messages`, auth, { text: 'where is my order?' });
      console.log(`agent: ${after.reply}`);
      return;
    }
    if (status === 'cancelled') throw new Error('the order was cancelled');
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`the order did not complete in time (last status: ${status})`);
}

main().catch((err) => {
  console.error(`chat: ${(err as Error).message}`);
  process.exit(1);
});
