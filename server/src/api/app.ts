import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { markPaymentSucceeded } from '../activities';
import type { Config } from '../config';
import { loadCatalog, notify, recordEvent, withTx } from '../db';
import { haversineKm, OrderValidationError, priceOrder } from '../domain/pricing';
import type { Catalog } from '../domain/types';
import type { StripePaymentProvider } from '../payments/stripe';
import { OrderNotActiveError, type OrderRuntime } from '../runtime';
import type { EventHub } from './hub';

export interface AppDeps {
  cfg: Config;
  pool: Pool;
  runtime: OrderRuntime;
  hub: EventHub;
  stripe?: StripePaymentProvider;
  logger?: boolean;
}

const UUID = z.uuid();

const CreateOrder = z
  .object({
    customerName: z.string().trim().min(1).max(100),
    phone: z.string().trim().min(5).max(30),
    fulfillment: z.enum(['delivery', 'pickup']),
    address: z.string().trim().min(3).max(300).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    channel: z.enum(['web', 'app', 'agent', 'phone']).default('web'),
    items: z
      .array(
        z.object({
          productId: z.string().min(1).max(50),
          size: z.enum(['normal', 'large']).default('normal'),
          quantity: z.number().int().min(1).max(20),
          without: z.array(z.string().min(1).max(50)).max(20).default([]),
        }),
      )
      .min(1)
      .max(30),
  })
  .refine((o) => o.fulfillment === 'pickup' || (o.address && o.lat !== undefined && o.lng !== undefined), {
    message: 'Kotiinkuljetus vaatii osoitteen ja sijainnin',
  });

const KitchenAction = z.object({ action: z.enum(['accept', 'reject', 'ready']) });
const DeliveryAction = z.object({
  action: z.enum(['assign', 'handover']),
  driverId: z.string().trim().min(1).max(60).optional(),
});
const Location = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const Restock = z.object({ amount: z.number().int().min(1).max(1_000_000) });

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function buildApp({ cfg, pool, runtime, hub, stripe, logger = true }: AppDeps): FastifyInstance {
  const app = Fastify({ logger, bodyLimit: 256 * 1024 });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: err.issues.map((i) => i.message).join('; ') });
    }
    if (err instanceof OrderValidationError) return reply.code(400).send({ error: err.message });
    if (err instanceof OrderNotActiveError) return reply.code(409).send({ error: 'Tilaus ei ole enää aktiivinen' });
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'Sisäinen virhe' });
  });

  // --- apurit ---

  let catalogCache: { at: number; catalog: Catalog } | undefined;
  const getCatalog = async (): Promise<Catalog> => {
    if (!catalogCache || Date.now() - catalogCache.at > 15_000) {
      catalogCache = { at: Date.now(), catalog: await loadCatalog(pool) };
    }
    return catalogCache.catalog;
  };

  const isStaff = (req: FastifyRequest): boolean => {
    const header = req.headers['x-staff-token'];
    const query = (req.query as Record<string, unknown>).staffToken;
    const token = typeof header === 'string' ? header : typeof query === 'string' ? query : '';
    return token !== '' && safeEqual(token, cfg.staffToken);
  };
  const requireStaff = (req: FastifyRequest): void => {
    if (!isStaff(req)) throw new HttpError(401, 'Henkilökunnan tunniste puuttuu tai on väärä');
  };

  const orderId = (req: FastifyRequest): string => UUID.parse((req.params as { id: string }).id);

  /** Asiakas tunnistetaan tilauskohtaisella salaisella tunnisteella; henkilökunta omallaan. */
  const requireOrderAccess = async (req: FastifyRequest): Promise<string> => {
    const id = orderId(req);
    if (isStaff(req)) return id;
    const header = req.headers['x-order-token'];
    const query = (req.query as Record<string, unknown>).token;
    const token = typeof header === 'string' ? header : typeof query === 'string' ? query : '';
    const res = await pool.query('select access_token from orders where id = $1', [id]);
    const row = res.rows[0];
    if (!row || token === '' || !safeEqual(token, row.access_token)) {
      throw new HttpError(404, 'Tilausta ei löydy');
    }
    return id;
  };

  const orderStatus = async (id: string): Promise<{ status: string; fulfillment: string }> => {
    const res = await pool.query('select status, fulfillment from orders where id = $1', [id]);
    if (!res.rows[0]) throw new HttpError(404, 'Tilausta ei löydy');
    return res.rows[0];
  };

  const ORDER_COLUMNS = `
    o.id, o.status, o.fulfillment, o.channel, o.customer_name, o.phone, o.address, o.lat, o.lng,
    o.items, o.priced_items, o.delivery_fee_cents, o.total_cents, o.driver_id, o.driver_lat, o.driver_lng,
    o.driver_updated_at, o.cancel_reason, o.created_at, o.updated_at,
    p.status as payment_status, p.provider as payment_provider, p.checkout_url`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toOrderView = (r: any) => ({
    id: r.id,
    status: r.status,
    fulfillment: r.fulfillment,
    channel: r.channel,
    customerName: r.customer_name,
    phone: r.phone,
    address: r.address,
    location: r.lat === null ? null : { lat: r.lat, lng: r.lng },
    items: r.priced_items ?? r.items,
    priced: r.priced_items !== null,
    deliveryFeeCents: r.delivery_fee_cents,
    totalCents: r.total_cents,
    driver:
      r.driver_id === null
        ? null
        : {
            id: r.driver_id,
            location: r.driver_lat === null ? null : { lat: r.driver_lat, lng: r.driver_lng },
            updatedAt: r.driver_updated_at,
          },
    payment:
      r.payment_status === null
        ? null
        : { status: r.payment_status, provider: r.payment_provider, checkoutUrl: r.checkout_url },
    cancelReason: r.cancel_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  // --- julkinen ---

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async () => {
    await pool.query('select 1');
    return { ok: true };
  });

  app.get('/api/menu', async () => {
    const catalog = await getCatalog();
    return {
      restaurant: cfg.restaurant,
      deliveryFeeCents: cfg.deliveryFeeCents,
      deliveryRadiusKm: cfg.deliveryRadiusKm,
      paymentProvider: cfg.paymentProvider,
      products: [...catalog.values()]
        .filter((p) => p.active)
        .map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          category: p.category,
          priceCents: p.priceCents,
          priceLargeCents: p.priceLargeCents,
          removable: p.ingredients.filter((i) => i.removable).map((i) => ({ id: i.id, name: i.name })),
        })),
    };
  });

  app.post('/api/orders', async (req, reply) => {
    const body = CreateOrder.parse(req.body);

    // Nopea palaute asiakkaalle. Tilausketju hinnoittelee ja tarkistaa saman vielä itse:
    // se on tilauksen virallinen totuus, tämä vain säästää turhan ketjun käynnistyksen.
    const estimate = priceOrder(body.items, await getCatalog(), body.fulfillment, cfg.deliveryFeeCents);
    if (body.fulfillment === 'delivery') {
      const km = haversineKm(cfg.restaurant, { lat: body.lat!, lng: body.lng! });
      if (km > cfg.deliveryRadiusKm) {
        throw new HttpError(400, `Osoite on toimitusalueen ulkopuolella (${km.toFixed(1)} km)`);
      }
    }

    const id = randomUUID();
    const accessToken = randomBytes(24).toString('base64url');
    const delivery = body.fulfillment === 'delivery';
    await withTx(pool, async (tx) => {
      await tx.query(
        `insert into orders (id, access_token, fulfillment, channel, customer_name, phone, address, lat, lng, items)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          accessToken,
          body.fulfillment,
          body.channel,
          body.customerName,
          body.phone,
          delivery ? body.address : null,
          delivery ? body.lat : null,
          delivery ? body.lng : null,
          JSON.stringify(body.items),
        ],
      );
      await recordEvent(tx, id, 'order.created', { channel: body.channel, fulfillment: body.fulfillment });
    });

    try {
      await runtime.start(id, body.fulfillment);
    } catch (err) {
      req.log.error(err, 'failed to start order workflow');
      await withTx(pool, async (tx) => {
        await tx.query(
          `update orders set status = 'cancelled', cancel_reason = 'internal_error', updated_at = now() where id = $1`,
          [id],
        );
        await recordEvent(tx, id, 'status.cancelled', { cancelReason: 'internal_error' });
      });
      throw new HttpError(503, 'Tilauksia ei voida juuri nyt ottaa vastaan. Yritä hetken kuluttua uudelleen.');
    }
    return reply.code(201).send({ id, accessToken, estimatedTotalCents: estimate.totalCents });
  });

  app.get('/api/orders/:id', async (req) => {
    const id = await requireOrderAccess(req);
    const [order, events] = await Promise.all([
      pool.query(`select ${ORDER_COLUMNS} from orders o left join payments p on p.order_id = o.id where o.id = $1`, [
        id,
      ]),
      pool.query('select type, created_at from order_events where order_id = $1 order by id', [id]),
    ]);
    return {
      ...toOrderView(order.rows[0]),
      restaurant: cfg.restaurant,
      timeline: events.rows.map((e) => ({ type: e.type, at: e.created_at })),
    };
  });

  app.get('/api/orders/:id/events', async (req, reply) => {
    const id = await requireOrderAccess(req);
    reply.hijack();
    hub.subscribe(reply.raw, id);
  });

  app.post('/api/orders/:id/cancel', async (req, reply) => {
    const id = await requireOrderAccess(req);
    const { status } = await orderStatus(id);
    if (!['created', 'awaiting_payment', 'paid'].includes(status)) {
      throw new HttpError(409, 'Tilausta ei voi enää perua, koska keittiö on jo aloittanut sen');
    }
    await runtime.cancel(id, 'customer_cancelled');
    return reply.code(202).send({ ok: true });
  });

  /** Simuloitu maksu. Oikeassa maksussa (Stripe) tämän tekee allekirjoitettu webhook. */
  app.post('/api/orders/:id/pay', async (req, reply) => {
    if (cfg.paymentProvider !== 'sim') throw new HttpError(404, 'Ei käytössä');
    const id = await requireOrderAccess(req);
    const res = await pool.query('select status from payments where order_id = $1', [id]);
    const payment = res.rows[0];
    if (!payment) throw new HttpError(409, 'Maksua ei ole vielä avattu');
    if (payment.status === 'pending') await markPaymentSucceeded(pool, id);
    else if (payment.status !== 'succeeded') throw new HttpError(409, 'Maksu ei ole enää avoinna');
    // Signaali on idempotentti: jos edellinen yritys kaatui tähän väliin, uusi kutsu korjaa tilanteen.
    await runtime.paymentResult(id, 'succeeded');
    return reply.code(202).send({ ok: true });
  });

  // --- Stripe-webhook (raaka runko allekirjoituksen tarkistusta varten) ---

  if (stripe) {
    app.register(async (scope) => {
      scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
      scope.post('/api/webhooks/stripe', async (req, reply) => {
        const signature = req.headers['stripe-signature'];
        if (typeof signature !== 'string') throw new HttpError(400, 'Allekirjoitus puuttuu');
        let event;
        try {
          event = stripe.verifyWebhook(req.body as Buffer, signature, cfg.stripeWebhookSecret);
        } catch {
          throw new HttpError(400, 'Virheellinen allekirjoitus');
        }
        if (!event.type.startsWith('checkout.session.')) return reply.send({ received: true });

        const session = event.data.object as { id: string; payment_status?: string };
        const res = await pool.query('select order_id from payments where provider_ref = $1', [session.id]);
        const id: string | undefined = res.rows[0]?.order_id;
        if (!id) return reply.send({ received: true });

        const paid =
          (event.type === 'checkout.session.completed' ||
            event.type === 'checkout.session.async_payment_succeeded') &&
          session.payment_status === 'paid';
        const failed =
          event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed';
        try {
          if (paid) {
            await markPaymentSucceeded(pool, id);
            await runtime.paymentResult(id, 'succeeded');
          } else if (failed) {
            await runtime.paymentResult(id, 'failed');
          }
        } catch (err) {
          if (!(err instanceof OrderNotActiveError)) throw err; // 500 → Stripe yrittää uudelleen
          if (paid) req.log.error({ orderId: id }, 'payment succeeded for an order that is no longer active');
        }
        return reply.send({ received: true });
      });
    });
  }

  // --- henkilökunta: keittiö, kuljettajat, varasto ---

  app.get('/api/staff/events', async (req, reply) => {
    requireStaff(req);
    reply.hijack();
    hub.subscribe(reply.raw);
  });

  app.get('/api/staff/orders', async (req) => {
    requireStaff(req);
    const res = await pool.query(
      `select ${ORDER_COLUMNS} from orders o left join payments p on p.order_id = o.id
        where o.status not in ('completed', 'cancelled')
        order by o.created_at
        limit 500`,
    );
    return { restaurant: cfg.restaurant, orders: res.rows.map(toOrderView) };
  });

  app.get('/api/staff/stats', async (req) => {
    requireStaff(req);
    const res = await pool.query('select status, count(*)::int as count from orders group by status');
    const byStatus: Record<string, number> = {};
    for (const row of res.rows) byStatus[row.status] = row.count;
    return { byStatus };
  });

  app.post('/api/staff/orders/:id/kitchen', async (req, reply) => {
    requireStaff(req);
    const id = orderId(req);
    const { action } = KitchenAction.parse(req.body);
    const { status } = await orderStatus(id);
    if (action === 'ready') {
      if (status !== 'preparing') throw new HttpError(409, 'Tilaus ei ole valmistuksessa');
      await runtime.kitchenReady(id);
    } else {
      if (status !== 'paid') throw new HttpError(409, 'Tilaus ei odota keittiön hyväksyntää');
      await runtime.kitchenDecision(id, action === 'accept');
    }
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/staff/orders/:id/delivery', async (req, reply) => {
    requireStaff(req);
    const id = orderId(req);
    const body = DeliveryAction.parse(req.body);
    if (body.action === 'assign') {
      if (!body.driverId) throw new HttpError(400, 'driverId puuttuu');
      const claimed = await withTx(pool, async (tx) => {
        const res = await tx.query(
          `update orders set driver_id = $2, updated_at = now()
            where id = $1 and status = 'ready' and fulfillment = 'delivery' and driver_id is null`,
          [id, body.driverId],
        );
        if (res.rowCount) await recordEvent(tx, id, 'driver.assigned', { driverId: body.driverId });
        return Boolean(res.rowCount);
      });
      if (!claimed) {
        const existing = await pool.query('select driver_id, status from orders where id = $1', [id]);
        // Sama kuljettaja yrittää uudelleen (esim. verkkovirheen jälkeen): toimita signaali uudestaan.
        if (existing.rows[0]?.driver_id !== body.driverId || existing.rows[0]?.status !== 'ready') {
          throw new HttpError(409, 'Tilaus ei ole vapaana kuljetettavaksi');
        }
      }
      await runtime.driverAssigned(id, body.driverId);
    } else {
      const { status, fulfillment } = await orderStatus(id);
      const ok = fulfillment === 'delivery' ? status === 'out_for_delivery' : status === 'ready';
      if (!ok) throw new HttpError(409, 'Tilausta ei voi vielä luovuttaa');
      await runtime.handedOver(id);
    }
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/staff/orders/:id/cancel', async (req, reply) => {
    requireStaff(req);
    const id = orderId(req);
    await runtime.cancel(id, 'operator_cancelled');
    return reply.code(202).send({ ok: true });
  });

  /**
   * Kuljettajan sijainti. Tiheä sijaintivirta ei kulje tilausketjun läpi (se paisuttaisi
   * ketjun historiaa), vaan suoraan tietokantaan ja sieltä asiakkaan kartalle.
   */
  app.post('/api/staff/orders/:id/location', async (req, reply) => {
    requireStaff(req);
    const id = orderId(req);
    const { lat, lng } = Location.parse(req.body);
    const updated = await withTx(pool, async (tx) => {
      const res = await tx.query(
        `update orders set driver_lat = $2, driver_lng = $3, driver_updated_at = now()
          where id = $1 and status = 'out_for_delivery'
          returning driver_id`,
        [id, lat, lng],
      );
      const row = res.rows[0];
      if (!row) return false;
      await tx.query('insert into driver_positions (order_id, driver_id, lat, lng) values ($1, $2, $3, $4)', [
        id,
        row.driver_id,
        lat,
        lng,
      ]);
      await notify(tx, { orderId: id, type: 'location', lat, lng });
      return true;
    });
    if (!updated) throw new HttpError(409, 'Tilaus ei ole kuljetuksessa');
    return reply.code(204).send();
  });

  app.get('/api/staff/ingredients', async (req) => {
    requireStaff(req);
    const res = await pool.query('select id, name, stock from ingredients order by name');
    return { ingredients: res.rows };
  });

  app.post('/api/staff/ingredients/:id/restock', async (req) => {
    requireStaff(req);
    const { amount } = Restock.parse(req.body);
    const id = z.string().min(1).max(50).parse((req.params as { id: string }).id);
    const res = await pool.query('update ingredients set stock = stock + $2 where id = $1 returning id, name, stock', [
      id,
      amount,
    ]);
    if (!res.rows[0]) throw new HttpError(404, 'Raaka-ainetta ei löydy');
    return res.rows[0];
  });

  return app;
}
