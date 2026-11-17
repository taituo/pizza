import type { PricedItem } from '../domain/types';

export interface PaymentRequest {
  orderId: string;
  accessToken: string;
  amountCents: number;
  deliveryFeeCents: number;
  items: PricedItem[];
}

/**
 * Maksupalvelun rajapinta. Jokaisen toteutuksen pitää olla idempotentti tilauksen suhteen:
 * Temporal voi ajaa saman activityn uudelleen, eikä se saa johtaa toiseen veloitukseen tai hyvitykseen.
 */
export interface PaymentProvider {
  readonly name: 'sim' | 'stripe';
  start(req: PaymentRequest): Promise<{ ref: string; checkoutUrl: string | null }>;
  /** Mitätöi avoimen maksun. Palauttaa 'paid', jos asiakas ehti maksaa ennen mitätöintiä. */
  cancel(ref: string, orderId: string): Promise<'cancelled' | 'paid'>;
  refund(ref: string, orderId: string, amountCents: number): Promise<void>;
}
