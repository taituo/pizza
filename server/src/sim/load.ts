/**
 * Load test: creates N orders and reports how the workflows progress.
 *
 *   npm run load -- --orders 10000 --concurrency 50
 *   npm run load -- --orders 200 --pay --wait        (with the simulator: workflows run to the end)
 *
 * Without --pay the orders stay waiting for payment: this is the "10,000 waiting workflows" case,
 * where no worker is held. --restock fills the stock before the run.
 */
import { envOr, sleep, StaffClient } from './client';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const api = new StaffClient(envOr('API_URL', 'http://localhost:3000'), envOr('STAFF_TOKEN', 'dev-staff-token'));
const TOTAL = Number(arg('orders', '100'));
const CONCURRENCY = Number(arg('concurrency', '20'));
const TIMEOUT_S = Number(arg('timeout', '600'));
const PAY = flag('pay');
const WAIT = flag('wait');
const RESTOCK = flag('restock');

const PIZZAS = ['margherita', 'pepperoni', 'diavola', 'hawaii', 'funghi', 'quattro'];
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

function randomOrder(restaurant: { lat: number; lng: number }): Record<string, unknown> {
  const delivery = Math.random() < 0.7;
  return {
    customerName: `Load test ${Math.floor(Math.random() * 1e6)}`,
    phone: '0401234567',
    fulfillment: delivery ? 'delivery' : 'pickup',
    channel: 'web',
    ...(delivery
      ? {
          address: 'Testikatu 1, Helsinki',
          lat: restaurant.lat + (Math.random() - 0.5) * 0.06,
          lng: restaurant.lng + (Math.random() - 0.5) * 0.12,
        }
      : {}),
    items: [
      { productId: pick(PIZZAS), size: Math.random() < 0.3 ? 'large' : 'normal', quantity: 1 + Math.floor(Math.random() * 2), without: [] },
      ...(Math.random() < 0.5 ? [{ productId: pick(['cola', 'water']), size: 'normal', quantity: 1, without: [] }] : []),
    ],
  };
}

async function main(): Promise<void> {
  const menu = (await (await fetch(`${api.apiUrl}/api/menu`)).json()) as { restaurant: { lat: number; lng: number } };
  if (RESTOCK) {
    const { ingredients } = await api.request<{ ingredients: { id: string }[] }>('GET', '/api/staff/ingredients');
    for (const ing of ingredients) {
      await api.request('POST', `/api/staff/ingredients/${ing.id}/restock`, { amount: TOTAL * 10 });
    }
    console.log(`[load] stock filled (${ingredients.length} ingredients)`);
  }

  const before = (await api.stats()).byStatus;
  const started = Date.now();
  let next = 0;
  let created = 0;
  let failed = 0;
  const ids: string[] = [];

  const worker = async (): Promise<void> => {
    while (next < TOTAL) {
      next++;
      try {
        const res = await fetch(`${api.apiUrl}/api/orders`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(randomOrder(menu.restaurant)),
        });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        ids.push(((await res.json()) as { id: string }).id);
        created++;
      } catch (err) {
        failed++;
        if (failed <= 5) console.error(`[load] creating an order failed: ${(err as Error).message}`);
      }
      if ((created + failed) % 500 === 0) console.log(`[load] ${created + failed}/${TOTAL} sent`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const createSeconds = (Date.now() - started) / 1000;
  console.log(
    `[load] created ${created} orders (${failed} errors) in ${createSeconds.toFixed(1)} s ` +
      `= ${(created / createSeconds).toFixed(0)} orders/s`,
  );

  const delta = async (): Promise<Record<string, number>> => {
    const now = (await api.stats()).byStatus;
    const d: Record<string, number> = {};
    for (const k of new Set([...Object.keys(now), ...Object.keys(before)])) {
      const v = (now[k] ?? 0) - (before[k] ?? 0);
      if (v !== 0) d[k] = v;
    }
    return d;
  };

  // Stage 1: every workflow has processed validation, reservation and opening the payment.
  const deadline = Date.now() + TIMEOUT_S * 1000;
  let d = await delta();
  while ((d.created ?? 0) > 0 && Date.now() < deadline) {
    await sleep(1000);
    d = await delta();
  }
  console.log(
    `[load] all workflows are waiting for payment or have moved on: ${((Date.now() - started) / 1000).toFixed(1)} s`,
    d,
  );

  if (PAY) {
    let i = 0;
    let payFailed = 0;
    const payer = async (): Promise<void> => {
      while (i < ids.length) {
        const id = ids[i++]!;
        try {
          await api.request('POST', `/api/orders/${id}/pay`);
        } catch {
          payFailed++;
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, payer));
    console.log(`[load] paid ${ids.length - payFailed} orders (${payFailed} not payable)`);
  }

  if (WAIT) {
    const finished = (x: Record<string, number>): number => (x.completed ?? 0) + (x.cancelled ?? 0);
    while (finished(d) < created && Date.now() < deadline) {
      await sleep(2000);
      d = await delta();
      console.log('[load]', d);
    }
    const ok = finished(d) >= created;
    console.log(
      ok
        ? `[load] all ${created} workflows finished: ${((Date.now() - started) / 1000).toFixed(1)} s`
        : `[load] timeout: ${finished(d)}/${created} workflows finished`,
    );
    if (!ok || failed > 0) process.exit(1);
  } else if (failed > 0 || (d.created ?? 0) > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
