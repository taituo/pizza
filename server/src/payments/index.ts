import type { Config } from '../config';
import { SimPaymentProvider } from './sim';
import { StripePaymentProvider } from './stripe';
import type { PaymentProvider } from './types';

export function createPaymentProvider(cfg: Config): PaymentProvider {
  if (cfg.paymentProvider === 'stripe') {
    return new StripePaymentProvider(cfg.stripeSecretKey, cfg.publicUrl);
  }
  return new SimPaymentProvider(cfg.simPaymentFailRate);
}

export { SimPaymentProvider, StripePaymentProvider };
export type { PaymentProvider };
