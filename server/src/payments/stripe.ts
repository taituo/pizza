import Stripe from 'stripe';
import type { PaymentProvider, PaymentRequest } from './types';

/**
 * Stripe Checkout. Asiakas maksaa Stripen sivulla; tulos tulee allekirjoitettuna webhookina
 * (ks. api/routes.ts), joka signaloi tilausketjua. Kaikki kirjoittavat kutsut käyttävät
 * tilauskohtaista idempotency-avainta.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly publicUrl: string,
  ) {
    this.stripe = new Stripe(secretKey);
  }

  async start(req: PaymentRequest): Promise<{ ref: string; checkoutUrl: string | null }> {
    const returnUrl = `${this.publicUrl}/order/${req.orderId}?token=${encodeURIComponent(req.accessToken)}`;
    const lineItems = req.items.map((item) => ({
      quantity: item.quantity,
      price_data: {
        currency: 'eur',
        unit_amount: item.unitPriceCents,
        product_data: {
          name: item.size === 'large' ? `${item.name} (iso)` : item.name,
        },
      },
    }));
    if (req.deliveryFeeCents > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: req.deliveryFeeCents,
          product_data: { name: 'Kotiinkuljetus' },
        },
      });
    }
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        client_reference_id: req.orderId,
        metadata: { orderId: req.orderId },
        payment_intent_data: { metadata: { orderId: req.orderId } },
        line_items: lineItems,
        success_url: `${returnUrl}&paid=1`,
        cancel_url: returnUrl,
        // Stripen minimi on 30 min; tilausketjun oma maksuaikakatkaisu mitätöi session aiemmin.
        expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      },
      { idempotencyKey: `order-${req.orderId}-checkout` },
    );
    return { ref: session.id, checkoutUrl: session.url };
  }

  async cancel(ref: string): Promise<'cancelled' | 'paid'> {
    const current = await this.stripe.checkout.sessions.retrieve(ref);
    if (current.payment_status === 'paid') return 'paid';
    if (current.status === 'open') {
      try {
        await this.stripe.checkout.sessions.expire(ref);
      } catch (err) {
        // Kilpatilanne: asiakas ehti maksaa juuri ennen mitätöintiä.
        const after = await this.stripe.checkout.sessions.retrieve(ref);
        if (after.payment_status === 'paid') return 'paid';
        if (after.status === 'open') throw err;
      }
    }
    return 'cancelled';
  }

  async refund(ref: string, orderId: string): Promise<void> {
    const session = await this.stripe.checkout.sessions.retrieve(ref);
    const paymentIntent =
      typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    if (!paymentIntent) throw new Error(`Stripe session ${ref} has no payment intent to refund`);
    await this.stripe.refunds.create(
      { payment_intent: paymentIntent, metadata: { orderId } },
      { idempotencyKey: `order-${orderId}-refund` },
    );
  }

  verifyWebhook(rawBody: Buffer, signature: string, secret: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, secret);
  }
}
