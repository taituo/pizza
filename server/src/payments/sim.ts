import type { PaymentProvider, PaymentRequest } from './types';

/**
 * Simulated payment provider. The payment is "completed" at the API's /pay endpoint.
 * failRate > 0 makes calls fail at random, which shows Temporal's retries
 * without anything being charged twice.
 */
export class SimPaymentProvider implements PaymentProvider {
  readonly name = 'sim' as const;

  constructor(private readonly failRate = 0) {}

  private maybeFail(op: string): void {
    if (this.failRate > 0 && Math.random() < this.failRate) {
      throw new Error(`Simulated payment provider outage (${op})`);
    }
  }

  async start(req: PaymentRequest): Promise<{ ref: string; checkoutUrl: null }> {
    this.maybeFail('start');
    return { ref: `sim_${req.orderId}`, checkoutUrl: null };
  }

  async cancel(): Promise<'cancelled'> {
    this.maybeFail('cancel');
    return 'cancelled';
  }

  async refund(): Promise<void> {
    this.maybeFail('refund');
  }
}
