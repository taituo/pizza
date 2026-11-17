import { ApplicationFailure } from '@temporalio/common';
import type { Pool } from 'pg';
import type { Config } from '../config';
import { loadCatalog, recordEvent, withTx } from '../db';
import { haversineKm, ingredientNeeds, OrderValidationError, priceOrder } from '../domain/pricing';
import type { CancelReason, OrderItemRequest, OrderStatus, PricedItem } from '../domain/types';
import type { PaymentProvider } from '../payments/types';

export interface ActivityDeps {
  pool: Pool;
  payments: PaymentProvider;
  cfg: Pick<Config, 'restaurant' | 'deliveryRadiusKm' | 'deliveryFeeCents'>;
}

/**
 * Kaikki tilausketjun sivuvaikutukset. Jokainen activity on idempotentti tilauksen suhteen,
 * koska Temporal ajaa sen uudelleen, jos workeri kaatuu tai vastaus katoaa matkalla.
 */
export function createActivities({ pool, payments, cfg }: ActivityDeps) {
  return {
    /** Hinnoittelee tilauksen palvelimen katalogista ja tarkistaa toimitusalueen. */
    async validateAndPrice(orderId: string): Promise<{ totalCents: number }> {
      const res = await pool.query(
        'select items, fulfillment, lat, lng, total_cents from orders where id = $1',
        [orderId],
      );
      const order = res.rows[0];
      if (!order) throw ApplicationFailure.nonRetryable(`Tilausta ${orderId} ei ole`, 'InvalidOrder');
      if (order.total_cents !== null) return { totalCents: order.total_cents };

      try {
        if (order.fulfillment === 'delivery') {
          if (order.lat === null || order.lng === null) {
            throw new OrderValidationError('Toimitusosoitteen sijainti puuttuu');
          }
          const km = haversineKm(cfg.restaurant, { lat: order.lat, lng: order.lng });
          if (km > cfg.deliveryRadiusKm) {
            throw new OrderValidationError(
              `Osoite on toimitusalueen ulkopuolella (${km.toFixed(1)} km, raja ${cfg.deliveryRadiusKm} km)`,
            );
          }
        }
        const catalog = await loadCatalog(pool);
        const priced = priceOrder(
          order.items as OrderItemRequest[],
          catalog,
          order.fulfillment,
          cfg.deliveryFeeCents,
        );
        await pool.query(
          `update orders set priced_items = $2, delivery_fee_cents = $3, total_cents = $4, updated_at = now()
            where id = $1 and total_cents is null`,
          [orderId, JSON.stringify(priced.items), priced.deliveryFeeCents, priced.totalCents],
        );
        return { totalCents: priced.totalCents };
      } catch (err) {
        if (err instanceof OrderValidationError) {
          throw ApplicationFailure.nonRetryable(err.message, 'InvalidOrder');
        }
        throw err;
      }
    },

    /** Varaa raaka-aineet varastosta. Yksi varausrivi per tilaus tekee tästä idempotentin. */
    async reserveStock(orderId: string): Promise<void> {
      await withTx(pool, async (tx) => {
        // Lukitsee tilauksen: saman tilauksen rinnakkainen uudelleenyritys odottaa tässä.
        const order = await tx.query('select items from orders where id = $1 for update', [orderId]);
        if (!order.rows[0]) throw ApplicationFailure.nonRetryable(`Tilausta ${orderId} ei ole`, 'InvalidOrder');
        const existing = await tx.query('select 1 from stock_reservations where order_id = $1', [orderId]);
        if (existing.rowCount) return;

        const catalog = await loadCatalog(tx);
        const needs = ingredientNeeds(order.rows[0].items as OrderItemRequest[], catalog);
        // Aina samassa järjestyksessä, jotta rinnakkaiset tilaukset eivät lukkiudu ristiin.
        for (const id of Object.keys(needs).sort()) {
          const updated = await tx.query(
            'update ingredients set stock = stock - $2 where id = $1 and stock >= $2',
            [id, needs[id]],
          );
          if (!updated.rowCount) {
            throw ApplicationFailure.nonRetryable(`Raaka-aine loppu: ${id}`, 'OutOfStock');
          }
        }
        await tx.query('insert into stock_reservations (order_id, needs) values ($1, $2)', [
          orderId,
          JSON.stringify(needs),
        ]);
        await recordEvent(tx, orderId, 'stock.reserved', { needs });
      });
    },

    /** Kompensaatio: palauttaa varatut raaka-aineet täsmälleen kerran. */
    async releaseStock(orderId: string): Promise<void> {
      await withTx(pool, async (tx) => {
        const res = await tx.query(
          'select needs from stock_reservations where order_id = $1 and released = false for update',
          [orderId],
        );
        const row = res.rows[0];
        if (!row) return;
        const needs = row.needs as Record<string, number>;
        for (const id of Object.keys(needs).sort()) {
          await tx.query('update ingredients set stock = stock + $2 where id = $1', [id, needs[id]]);
        }
        await tx.query('update stock_reservations set released = true where order_id = $1', [orderId]);
        await recordEvent(tx, orderId, 'stock.released', { needs });
      });
    },

    /** Avaa maksun maksupalvelussa. Uudelleenajo palauttaa saman maksun eikä luo toista. */
    async startPayment(orderId: string): Promise<void> {
      const existing = await pool.query('select 1 from payments where order_id = $1', [orderId]);
      if (existing.rowCount) return;

      const res = await pool.query(
        'select access_token, total_cents, delivery_fee_cents, priced_items from orders where id = $1',
        [orderId],
      );
      const order = res.rows[0];
      if (!order || order.total_cents === null) {
        throw ApplicationFailure.nonRetryable(`Tilausta ${orderId} ei ole hinnoiteltu`, 'InvalidOrder');
      }
      // Palvelukutsu on idempotentti tilauskohtaisella avaimella, joten kaatuminen tämän
      // ja alla olevan insertin välissä ei luo toista maksua.
      const started = await payments.start({
        orderId,
        accessToken: order.access_token,
        amountCents: order.total_cents,
        deliveryFeeCents: order.delivery_fee_cents ?? 0,
        items: order.priced_items as PricedItem[],
      });
      await withTx(pool, async (tx) => {
        const inserted = await tx.query(
          `insert into payments (order_id, provider, provider_ref, status, amount_cents, checkout_url)
           values ($1, $2, $3, 'pending', $4, $5)
           on conflict (order_id) do nothing`,
          [orderId, payments.name, started.ref, order.total_cents, started.checkoutUrl],
        );
        if (inserted.rowCount) {
          await recordEvent(tx, orderId, 'payment.started', {
            provider: payments.name,
            amountCents: order.total_cents,
          });
        }
      });
    },

    /**
     * Mitätöi maksamattoman maksun (aikakatkaisu tai peruutus). Jos asiakas ehti silti maksaa,
     * maksu hyvitetään heti: tilausta ei koskaan jätetä tilaan "maksettu mutta peruttu".
     */
    async cancelPayment(orderId: string): Promise<void> {
      const res = await pool.query('select provider_ref, status from payments where order_id = $1', [orderId]);
      const payment = res.rows[0];
      if (!payment) return;
      if (payment.status === 'pending') {
        const outcome = await payments.cancel(payment.provider_ref, orderId);
        if (outcome === 'cancelled') {
          await withTx(pool, async (tx) => {
            const updated = await tx.query(
              `update payments set status = 'cancelled', updated_at = now()
                where order_id = $1 and status = 'pending'`,
              [orderId],
            );
            if (updated.rowCount) await recordEvent(tx, orderId, 'payment.cancelled');
          });
        } else {
          await markPaymentSucceeded(pool, orderId);
        }
      }
      await refund(orderId);
    },

    /** Kompensaatio: hyvittää onnistuneen maksun täsmälleen kerran. */
    async refundPayment(orderId: string): Promise<void> {
      await refund(orderId);
    },

    /** Siirtää tilauksen uuteen tilaan ja julkaisee tapahtuman. Uudelleenajo ei tuota toista tapahtumaa. */
    async transition(orderId: string, status: OrderStatus, cancelReason?: CancelReason): Promise<void> {
      await withTx(pool, async (tx) => {
        const updated = await tx.query(
          `update orders
              set status = $2, cancel_reason = coalesce($3, cancel_reason), updated_at = now()
            where id = $1 and status <> $2`,
          [orderId, status, cancelReason ?? null],
        );
        if (updated.rowCount) {
          await recordEvent(tx, orderId, `status.${status}`, cancelReason ? { cancelReason } : {});
        }
      });
    },
  };

  async function refund(orderId: string): Promise<void> {
    await withTx(pool, async (tx) => {
      const res = await tx.query(
        'select provider_ref, status, amount_cents from payments where order_id = $1 for update',
        [orderId],
      );
      const payment = res.rows[0];
      if (!payment || payment.status !== 'succeeded') return;
      await payments.refund(payment.provider_ref, orderId, payment.amount_cents);
      await tx.query(`update payments set status = 'refunded', updated_at = now() where order_id = $1`, [
        orderId,
      ]);
      await recordEvent(tx, orderId, 'payment.refunded', { amountCents: payment.amount_cents });
    });
  }
}

/** Kirjaa maksun onnistuneeksi täsmälleen kerran. Palauttaa true, jos tila muuttui nyt. */
export async function markPaymentSucceeded(pool: Pool, orderId: string): Promise<boolean> {
  return withTx(pool, async (tx) => {
    const updated = await tx.query(
      `update payments set status = 'succeeded', updated_at = now()
        where order_id = $1 and status = 'pending'`,
      [orderId],
    );
    if (updated.rowCount) await recordEvent(tx, orderId, 'payment.succeeded');
    return Boolean(updated.rowCount);
  });
}

export type Activities = ReturnType<typeof createActivities>;
