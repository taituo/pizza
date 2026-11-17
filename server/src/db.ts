import { Pool, type PoolClient } from 'pg';
import type { Catalog, CatalogProduct } from './domain/types';

export interface Queryable {
  query: Pool['query'];
}

export function createPool(databaseUrl: string, max = 10): Pool {
  const pool = new Pool({ connectionString: databaseUrl, max });
  pool.on('error', (err) => {
    console.error('[db] idle client error', err.message);
  });
  return pool;
}

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export const EVENTS_CHANNEL = 'order_events';

export interface EventNotification {
  orderId: string;
  type: string;
  lat?: number;
  lng?: number;
}

/**
 * Records a business event (BI) and wakes the realtime listeners (SSE).
 * NOTIFY is delivered only at commit, so a listener never sees unfinished state.
 */
export async function recordEvent(
  q: Queryable,
  orderId: string,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await q.query('insert into order_events (order_id, type, payload) values ($1, $2, $3)', [
    orderId,
    type,
    JSON.stringify(payload),
  ]);
  await notify(q, { orderId, type });
}

export async function notify(q: Queryable, n: EventNotification): Promise<void> {
  await q.query('select pg_notify($1, $2)', [EVENTS_CHANNEL, JSON.stringify(n)]);
}

export async function loadCatalog(q: Queryable): Promise<Catalog> {
  const products = await q.query(
    `select id, name, description, category, price_cents, price_large_cents, active
       from products order by sort_order, id`,
  );
  const ingredients = await q.query(
    `select pi.product_id, pi.ingredient_id, pi.qty, pi.removable, i.name
       from product_ingredients pi join ingredients i on i.id = pi.ingredient_id
      order by pi.product_id, pi.ingredient_id`,
  );
  const catalog: Catalog = new Map();
  for (const p of products.rows) {
    const product: CatalogProduct = {
      id: p.id,
      name: p.name,
      description: p.description,
      category: p.category,
      priceCents: p.price_cents,
      priceLargeCents: p.price_large_cents,
      active: p.active,
      ingredients: [],
    };
    catalog.set(product.id, product);
  }
  for (const row of ingredients.rows) {
    catalog.get(row.product_id)?.ingredients.push({
      id: row.ingredient_id,
      name: row.name,
      qty: row.qty,
      removable: row.removable,
    });
  }
  return catalog;
}
