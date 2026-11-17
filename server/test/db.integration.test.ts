/**
 * Activity and API tests against a real Postgres. They run when TEST_DATABASE_URL is set
 * (always in CI). The key claim: no activity performs its side effect twice,
 * even if Temporal re-runs it.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createActivities, markPaymentSucceeded } from '../src/activities';
import { buildApp } from '../src/api/app';
import { EventHub } from '../src/api/hub';
import { loadConfig, type Config } from '../src/config';
import { createPool } from '../src/db';
import { migrate } from '../src/migrate';
import type { PaymentProvider } from '../src/payments/types';
import { OrderNotActiveError, type OrderRuntime } from '../src/runtime';

const databaseUrl = process.env.TEST_DATABASE_URL;

class CountingPayments implements PaymentProvider {
  readonly name = 'sim' as const;
  starts = 0;
  cancels = 0;
  refunds = 0;
  cancelOutcome: 'cancelled' | 'paid' = 'cancelled';
  failNextRefund = false;
  async start(req: { orderId: string }) {
    this.starts++;
    return { ref: `sim_${req.orderId}`, checkoutUrl: null };
  }
  async cancel() {
    this.cancels++;
    return this.cancelOutcome;
  }
  async refund() {
    if (this.failNextRefund) {
      this.failNextRefund = false;
      throw new Error('payment provider is down');
    }
    this.refunds++;
  }
}

class FakeRuntime implements OrderRuntime {
  signals: string[] = [];
  failStart = false;
  async start(orderId: string) {
    if (this.failStart) throw new Error('temporal down');
    this.signals.push(`start:${orderId}`);
  }
  async paymentResult(id: string, status: string) {
    this.signals.push(`payment:${status}:${id}`);
  }
  async kitchenDecision(id: string, accepted: boolean) {
    this.signals.push(`kitchen:${accepted}:${id}`);
  }
  async kitchenReady(id: string) {
    this.signals.push(`ready:${id}`);
  }
  async driverAssigned(id: string, driverId: string) {
    this.signals.push(`driver:${driverId}:${id}`);
  }
  async handedOver(id: string) {
    this.signals.push(`handover:${id}`);
  }
  async cancel(id: string, reason: string) {
    if (reason === 'operator_cancelled') throw new OrderNotActiveError(id);
    this.signals.push(`cancel:${reason}:${id}`);
  }
  async close() {}
}

describe.skipIf(!databaseUrl)('with Postgres', () => {
  let pool: Pool;
  let cfg: Config;
  let payments: CountingPayments;
  let acts: ReturnType<typeof createActivities>;

  const stock = async (id: string): Promise<number> =>
    (await pool.query('select stock from ingredients where id = $1', [id])).rows[0].stock;
  const events = async (orderId: string): Promise<string[]> =>
    (await pool.query('select type from order_events where order_id = $1 order by id', [orderId])).rows.map(
      (r) => r.type,
    );

  async function insertOrder(items: unknown[], fulfillment: 'delivery' | 'pickup' = 'pickup'): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `insert into orders (id, access_token, fulfillment, customer_name, phone, address, lat, lng, items)
       values ($1, 'tok', $2, 'Test', '0401234567', $3, $4, $5, $6)`,
      [
        id,
        fulfillment,
        fulfillment === 'delivery' ? 'Testikatu 1' : null,
        fulfillment === 'delivery' ? cfg.restaurant.lat + 0.01 : null,
        fulfillment === 'delivery' ? cfg.restaurant.lng : null,
        JSON.stringify(items),
      ],
    );
    return id;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    cfg = loadConfig();
    await migrate(cfg.databaseUrl, () => undefined);
    pool = createPool(cfg.databaseUrl);
    await pool.query(`insert into ingredients (id, name, stock) values ('test-scarce', 'Testiharvinaisuus', 1)
                      on conflict (id) do update set stock = 1`);
    await pool.query(`insert into products (id, name, category, price_cents, active)
                      values ('test-scarce-pizza', 'Scarce', 'pizza', 2000, true) on conflict do nothing`);
    await pool.query(`insert into product_ingredients (product_id, ingredient_id, qty, removable)
                      values ('test-scarce-pizza', 'test-scarce', 1, false) on conflict do nothing`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('activities', () => {
    beforeAll(() => {
      payments = new CountingPayments();
      acts = createActivities({ pool, payments, cfg });
    });

    it('prices on the server and keeps the first price on retry', async () => {
      const id = await insertOrder([{ productId: 'pepperoni', size: 'large', quantity: 2, without: ['onion'] }], 'delivery');
      expect(await acts.validateAndPrice(id)).toEqual({ totalCents: 2 * 1690 + cfg.deliveryFeeCents });
      await pool.query(`update products set price_large_cents = 9999 where id = 'pepperoni'`);
      try {
        expect(await acts.validateAndPrice(id)).toEqual({ totalCents: 2 * 1690 + cfg.deliveryFeeCents });
      } finally {
        await pool.query(`update products set price_large_cents = 1690 where id = 'pepperoni'`);
      }
    });

    it('rejects an address outside the delivery area as a non-retryable failure', async () => {
      const id = await insertOrder([{ productId: 'cola', size: 'normal', quantity: 1, without: [] }], 'delivery');
      await pool.query('update orders set lat = lat + 2 where id = $1', [id]);
      await expect(acts.validateAndPrice(id)).rejects.toMatchObject({ type: 'InvalidOrder', nonRetryable: true });
    });

    it('reserves stock exactly once however often it is retried, and releases exactly once', async () => {
      const id = await insertOrder([{ productId: 'margherita', size: 'normal', quantity: 3, without: ['basil'] }]);
      const before = { dough: await stock('dough'), mozzarella: await stock('mozzarella'), basil: await stock('basil') };
      await Promise.all([acts.reserveStock(id), acts.reserveStock(id), acts.reserveStock(id)]);
      await acts.reserveStock(id);
      expect(await stock('dough')).toBe(before.dough - 3);
      expect(await stock('mozzarella')).toBe(before.mozzarella - 6);
      expect(await stock('basil')).toBe(before.basil);

      await Promise.all([acts.releaseStock(id), acts.releaseStock(id)]);
      await acts.releaseStock(id);
      expect(await stock('dough')).toBe(before.dough);
      expect(await stock('mozzarella')).toBe(before.mozzarella);
      expect(await events(id)).toEqual(['stock.reserved', 'stock.released']);
    });

    it('never oversells: of two orders for the last unit only one gets it, and nothing is half-reserved', async () => {
      const a = await insertOrder([
        { productId: 'margherita', size: 'normal', quantity: 1, without: [] },
        { productId: 'test-scarce-pizza', size: 'normal', quantity: 1, without: [] },
      ]);
      const b = await insertOrder([
        { productId: 'margherita', size: 'normal', quantity: 1, without: [] },
        { productId: 'test-scarce-pizza', size: 'normal', quantity: 1, without: [] },
      ]);
      const doughBefore = await stock('dough');
      const results = await Promise.allSettled([acts.reserveStock(a), acts.reserveStock(b)]);
      const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(failed).toHaveLength(1);
      expect(failed[0]!.reason).toMatchObject({ type: 'OutOfStock', nonRetryable: true });
      expect(await stock('test-scarce')).toBe(0);
      expect(await stock('dough')).toBe(doughBefore - 1); // the losing order's dough came back in the rollback
    });

    it('opens one payment per order and refunds a paid order exactly once', async () => {
      const id = await insertOrder([{ productId: 'cola', size: 'normal', quantity: 2, without: [] }]);
      await acts.validateAndPrice(id);
      const startsBefore = payments.starts;
      await acts.startPayment(id);
      await acts.startPayment(id);
      expect(payments.starts).toBe(startsBefore + 1);
      expect((await pool.query('select count(*)::int as n from payments where order_id = $1', [id])).rows[0].n).toBe(1);

      expect(await markPaymentSucceeded(pool, id)).toBe(true);
      expect(await markPaymentSucceeded(pool, id)).toBe(false);

      const refundsBefore = payments.refunds;
      payments.failNextRefund = true;
      await expect(acts.refundPayment(id)).rejects.toThrow('payment provider is down'); // Temporal would retry
      expect((await pool.query('select status from payments where order_id = $1', [id])).rows[0].status).toBe('succeeded');
      await acts.refundPayment(id);
      await acts.refundPayment(id);
      await acts.cancelPayment(id);
      expect(payments.refunds).toBe(refundsBefore + 1);
      expect((await pool.query('select status from payments where order_id = $1', [id])).rows[0].status).toBe('refunded');
      expect((await events(id)).filter((e) => e.startsWith('payment.'))).toEqual([
        'payment.started',
        'payment.succeeded',
        'payment.refunded',
      ]);
    });

    it('refunds instead of cancelling when the customer paid just before the timeout', async () => {
      const id = await insertOrder([{ productId: 'water', size: 'normal', quantity: 1, without: [] }]);
      await acts.validateAndPrice(id);
      await acts.startPayment(id);
      const refundsBefore = payments.refunds;
      payments.cancelOutcome = 'paid';
      try {
        await acts.cancelPayment(id);
      } finally {
        payments.cancelOutcome = 'cancelled';
      }
      expect(payments.refunds).toBe(refundsBefore + 1);
      expect((await pool.query('select status from payments where order_id = $1', [id])).rows[0].status).toBe('refunded');
    });

    it('records each status transition once', async () => {
      const id = await insertOrder([{ productId: 'cola', size: 'normal', quantity: 1, without: [] }]);
      await acts.transition(id, 'awaiting_payment');
      await acts.transition(id, 'awaiting_payment');
      await acts.transition(id, 'cancelled', 'payment_timeout');
      await acts.transition(id, 'cancelled', 'payment_timeout');
      expect(await events(id)).toEqual(['status.awaiting_payment', 'status.cancelled']);
      const row = (await pool.query('select status, cancel_reason from orders where id = $1', [id])).rows[0];
      expect(row).toEqual({ status: 'cancelled', cancel_reason: 'payment_timeout' });
    });
  });

  describe('API', () => {
    let runtime: FakeRuntime;
    let hub: EventHub;
    let app: ReturnType<typeof buildApp>;
    const staff = { 'x-staff-token': 'dev-staff-token' };
    const order = {
      customerName: 'Maija',
      phone: '0401234567',
      fulfillment: 'pickup',
      items: [{ productId: 'margherita', quantity: 1 }],
    };

    beforeAll(async () => {
      runtime = new FakeRuntime();
      hub = new EventHub(cfg.databaseUrl, { info: () => undefined, error: () => undefined });
      await hub.start();
      app = buildApp({ cfg, pool, runtime, hub, logger: false });
      await app.ready();
    });
    afterAll(async () => {
      await hub.stop();
      await app.close();
    });

    it('serves the menu without internal fields', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/menu' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.products.find((p: { id: string }) => p.id === 'margherita')).toMatchObject({
        priceCents: 1090,
        removable: expect.arrayContaining([{ id: 'basil', name: 'Basilika' }]),
      });
    });

    it('creates an order, starts its workflow and only shows it to the token holder', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/orders', payload: order });
      expect(res.statusCode).toBe(201);
      const { id, accessToken, estimatedTotalCents } = res.json();
      expect(estimatedTotalCents).toBe(1090);
      expect(runtime.signals).toContain(`start:${id}`);

      expect((await app.inject({ method: 'GET', url: `/api/orders/${id}` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/api/orders/${id}?token=wrong` })).statusCode).toBe(404);
      const own = await app.inject({ method: 'GET', url: `/api/orders/${id}?token=${accessToken}` });
      expect(own.statusCode).toBe(200);
      expect(own.json()).toMatchObject({ id, status: 'created', timeline: [{ type: 'order.created' }] });
      expect(own.json().accessToken).toBeUndefined();
    });

    it.each([
      ['unknown product', { ...order, items: [{ productId: 'nope', quantity: 1 }] }],
      ['client-supplied nonsense quantity', { ...order, items: [{ productId: 'margherita', quantity: 500 }] }],
      ['delivery without a location', { ...order, fulfillment: 'delivery', address: 'Katu 1' }],
      [
        'delivery far outside the area',
        { ...order, fulfillment: 'delivery', address: 'Rovaniemi', lat: 66.5, lng: 25.7 },
      ],
    ])('rejects %s with 400 and starts nothing', async (_name, payload) => {
      const before = runtime.signals.length;
      const res = await app.inject({ method: 'POST', url: '/api/orders', payload });
      expect(res.statusCode).toBe(400);
      expect(runtime.signals.length).toBe(before);
    });

    it('marks the order cancelled when the workflow cannot be started', async () => {
      const count = async (): Promise<number> =>
        (
          await pool.query(
            `select count(*)::int as n from orders where status = 'cancelled' and cancel_reason = 'internal_error'`,
          )
        ).rows[0].n;
      const before = await count();
      runtime.failStart = true;
      try {
        const res = await app.inject({ method: 'POST', url: '/api/orders', payload: order });
        expect(res.statusCode).toBe(503);
      } finally {
        runtime.failStart = false;
      }
      expect(await count()).toBe(before + 1);
    });

    it('guards staff endpoints and only signals actions that fit the order status', async () => {
      const { id, accessToken } = (await app.inject({ method: 'POST', url: '/api/orders', payload: order })).json();
      const kitchen = (action: string, headers = staff) =>
        app.inject({ method: 'POST', url: `/api/staff/orders/${id}/kitchen`, payload: { action }, headers });

      expect((await kitchen('accept', {} as never)).statusCode).toBe(401);
      expect((await kitchen('accept', { 'x-staff-token': 'guess' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/api/staff/orders' })).statusCode).toBe(401);
      expect((await kitchen('accept')).statusCode).toBe(409); // not paid yet

      await pool.query(`update orders set status = 'paid' where id = $1`, [id]);
      expect((await kitchen('ready')).statusCode).toBe(409);
      expect((await kitchen('accept')).statusCode).toBe(202);
      expect(runtime.signals).toContain(`kitchen:true:${id}`);

      // The customer cannot cancel once the kitchen has started.
      await pool.query(`update orders set status = 'preparing' where id = $1`, [id]);
      const cancel = await app.inject({ method: 'POST', url: `/api/orders/${id}/cancel?token=${accessToken}` });
      expect(cancel.statusCode).toBe(409);

      // Finished workflow → 409, not 500.
      const opCancel = await app.inject({ method: 'POST', url: `/api/staff/orders/${id}/cancel`, headers: staff });
      expect(opCancel.statusCode).toBe(409);
    });

    it('lets exactly one driver claim a ready delivery and accepts positions only while it is out', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/orders',
        payload: { ...order, fulfillment: 'delivery', address: 'Testikatu 1', lat: cfg.restaurant.lat + 0.01, lng: cfg.restaurant.lng },
      });
      const { id } = created.json();
      const assign = (driverId: string) =>
        app.inject({ method: 'POST', url: `/api/staff/orders/${id}/delivery`, payload: { action: 'assign', driverId }, headers: staff });
      const position = () =>
        app.inject({ method: 'POST', url: `/api/staff/orders/${id}/location`, payload: { lat: 60.17, lng: 24.94 }, headers: staff });

      expect((await assign('d1')).statusCode).toBe(409); // not ready yet
      await pool.query(`update orders set status = 'ready' where id = $1`, [id]);
      const [a, b] = await Promise.all([assign('d1'), assign('d2')]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([202, 409]);
      expect(runtime.signals.filter((s) => s.startsWith('driver:') && s.endsWith(id))).toHaveLength(1);

      expect((await position()).statusCode).toBe(409);
      await pool.query(`update orders set status = 'out_for_delivery' where id = $1`, [id]);
      expect((await position()).statusCode).toBe(204);
      const view = (await app.inject({ method: 'GET', url: `/api/orders/${id}`, headers: staff })).json();
      expect(view.driver.location).toEqual({ lat: 60.17, lng: 24.94 });
    });

    it('simulated pay marks the payment once and re-sends the signal on retry', async () => {
      const { id, accessToken } = (await app.inject({ method: 'POST', url: '/api/orders', payload: order })).json();
      const pay = () => app.inject({ method: 'POST', url: `/api/orders/${id}/pay?token=${accessToken}` });
      expect((await pay()).statusCode).toBe(409); // the payment has not been opened yet

      const a = createActivities({ pool, payments: new CountingPayments(), cfg });
      await a.validateAndPrice(id);
      await a.startPayment(id);
      expect((await pay()).statusCode).toBe(202);
      expect((await pay()).statusCode).toBe(202);
      expect(runtime.signals.filter((s) => s === `payment:succeeded:${id}`)).toHaveLength(2);
      expect((await events(id)).filter((e) => e === 'payment.succeeded')).toHaveLength(1);

      await a.refundPayment(id);
      expect((await pay()).statusCode).toBe(409);
    });
  });
});
