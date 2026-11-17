import type { PaymentProvider, PaymentRequest } from './types';

/**
 * Simuloitu maksupalvelu. Maksun "suoritus" tapahtuu API:n /pay-päätepisteessä.
 * failRate > 0 saa kutsut epäonnistumaan satunnaisesti, jolloin näkee Temporalin
 * uudelleenyritykset ilman, että mitään veloitetaan kahdesti.
 */
export class SimPaymentProvider implements PaymentProvider {
  readonly name = 'sim' as const;

  constructor(private readonly failRate = 0) {}

  private maybeFail(op: string): void {
    if (this.failRate > 0 && Math.random() < this.failRate) {
      throw new Error(`Simuloitu maksupalvelun häiriö (${op})`);
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
