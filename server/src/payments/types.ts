import type { PricedItem } from '../domain/types';

export interface PaymentRequest {
  orderId: string;
  accessToken: string;
  amountCents: number;
  deliveryFeeCents: number;
  items: PricedItem[];
}

/**
 * Payment provider interface. Every implementation must be idempotent per order:
 * Temporal may re-run the same activity, and that must not lead to a second charge or refund.
 */
export interface PaymentProvider {
  readonly name: 'sim' | 'stripe';
  start(req: PaymentRequest): Promise<{ ref: string; checkoutUrl: string | null }>;
  /** Voids an open payment. Returns 'paid' if the customer paid before the void. */
  cancel(ref: string, orderId: string): Promise<'cancelled' | 'paid'>;
  refund(ref: string, orderId: string, amountCents: number): Promise<void>;
}
