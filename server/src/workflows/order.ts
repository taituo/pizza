import {
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  condition,
  isCancellation,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { Activities } from '../activities';
import {
  cancelRequestedSignal,
  DEFAULT_TIMEOUTS,
  driverAssignedSignal,
  handedOverSignal,
  kitchenDecisionSignal,
  kitchenReadySignal,
  orderStateQuery,
  paymentResultSignal,
  type OrderWorkflowInput,
  type OrderWorkflowResult,
} from '../domain/signals';
import type { CancelReason, OrderStatus } from '../domain/types';

const acts = proxyActivities<Activities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    // Ei enimmäisyrityksiä: ohimenevä häiriö (tietokanta, maksupalvelu) ei saa kaataa tilausta.
    // Pysyvät liiketoimintavirheet heitetään activityissä nonRetryable-tyyppisinä.
  },
});

/** Sisäinen keskeytys: ketju puretaan kompensaatioilla ja tilaus päättyy tilaan cancelled. */
class Abort extends Error {
  constructor(readonly reason: CancelReason) {
    super(reason);
  }
}

/**
 * Tilausketju: validointi → varastovaraus → maksu → keittiö → toimitus/nouto → valmis.
 *
 * Deterministinen prosessi, joka voi odottaa ihmistä tai ulkoista järjestelmää tunteja
 * ilman yhtään varattua prosessia. Ulkomaailma (API, webhookit, keittiö, kuljettaja,
 * myöhemmin agentit) ohjaa sitä vain signaaleilla; ketju itse päättää, mikä on sallittua.
 */
export async function orderWorkflow(input: OrderWorkflowInput): Promise<OrderWorkflowResult> {
  const { orderId } = input;
  const isDelivery = input.fulfillment === 'delivery';
  const timeouts = { ...DEFAULT_TIMEOUTS, ...input.timeouts };

  let status: OrderStatus = 'created';
  let cancelReason: CancelReason | undefined;

  let payment: 'succeeded' | 'failed' | undefined;
  let kitchenDecision: boolean | undefined;
  let kitchenReady = false;
  let driverId: string | undefined;
  let handedOver = false;
  let cancelRequested: 'customer_cancelled' | 'operator_cancelled' | undefined;

  // Signaalit hyväksytään vain siinä vaiheessa, johon ne kuuluvat. Väärässä vaiheessa
  // saapunut signaali (tuplaklikkaus, myöhästynyt webhook) ei muuta mitään.
  setHandler(paymentResultSignal, ({ status: result }) => {
    if (status === 'awaiting_payment' && payment === undefined) payment = result;
  });
  setHandler(kitchenDecisionSignal, ({ accepted }) => {
    if (status === 'paid' && kitchenDecision === undefined) kitchenDecision = accepted;
  });
  setHandler(kitchenReadySignal, () => {
    if (status === 'preparing') kitchenReady = true;
  });
  setHandler(driverAssignedSignal, ({ driverId: id }) => {
    if (status === 'ready' && driverId === undefined) driverId = id;
  });
  setHandler(handedOverSignal, () => {
    if (status === 'out_for_delivery' || (status === 'ready' && !isDelivery)) handedOver = true;
  });
  setHandler(cancelRequestedSignal, ({ reason }) => {
    // Asiakas voi perua siihen asti, kun keittiö on hyväksynyt tilauksen.
    const customerMayCancel = status === 'created' || status === 'awaiting_payment' || status === 'paid';
    if (reason === 'operator_cancelled' || customerMayCancel) cancelRequested ??= reason;
  });
  setHandler(orderStateQuery, () => ({ status, cancelReason }));

  // Ketjun oma tila vaihtuu ENNEN kuin tila kirjoitetaan tietokantaan. Ulkomaailma näkee uuden
  // tilan vasta tietokannasta, joten sen perusteella lähetetty signaali (esim. kuljettaja ottaa
  // juuri valmistuneen tilauksen) osuu aina vaiheeseen, jonka ketju jo hyväksyy, vaikka signaali
  // ja activityn valmistuminen käsiteltäisiin samassa erässä workerin katkon jälkeen.
  const transition = async (next: OrderStatus): Promise<void> => {
    status = next;
    await acts.transition(orderId, next);
  };
  const checkCancel = (): void => {
    if (cancelRequested) throw new Abort(cancelRequested);
  };

  let stockReserved = false;
  let stockConsumed = false;
  let paymentStarted = false;

  try {
    await acts.validateAndPrice(orderId);
    await acts.reserveStock(orderId);
    stockReserved = true;
    checkCancel();

    // --- Maksu ---
    await acts.startPayment(orderId);
    paymentStarted = true;
    await transition('awaiting_payment');
    const gotPayment = await condition(
      () => payment !== undefined || cancelRequested !== undefined,
      timeouts.paymentMs,
    );
    if (payment !== 'succeeded') {
      if (cancelRequested) throw new Abort(cancelRequested);
      throw new Abort(gotPayment ? 'payment_failed' : 'payment_timeout');
    }
    await transition('paid');
    checkCancel();

    // --- Keittiö ---
    const gotDecision = await condition(
      () => kitchenDecision !== undefined || cancelRequested !== undefined,
      timeouts.kitchenAcceptMs,
    );
    if (kitchenDecision !== true) {
      if (cancelRequested) throw new Abort(cancelRequested);
      throw new Abort(gotDecision ? 'kitchen_rejected' : 'kitchen_timeout');
    }
    await transition('preparing');
    stockConsumed = true; // raaka-aineet on käytetty, niitä ei enää palauteta varastoon

    const prepared = await condition(
      () => kitchenReady || cancelRequested !== undefined,
      timeouts.kitchenPrepareMs,
    );
    checkCancel();
    if (!prepared) throw new Abort('kitchen_timeout');
    await transition('ready');

    // --- Toimitus tai nouto ---
    if (isDelivery) {
      const assigned = await condition(
        () => driverId !== undefined || cancelRequested !== undefined,
        timeouts.driverAssignMs,
      );
      checkCancel();
      if (!assigned) throw new Abort('delivery_timeout');
      await transition('out_for_delivery');
    }
    const done = await condition(() => handedOver || cancelRequested !== undefined, timeouts.handoverMs);
    checkCancel();
    if (!done) throw new Abort(isDelivery ? 'delivery_timeout' : 'not_collected');

    await transition('completed');
    return { status: 'completed' };
  } catch (err) {
    const reason = abortReason(err);
    // Kompensaatiot ajetaan loppuun, vaikka koko workflow olisi peruttu Temporalista käsin.
    await CancellationScope.nonCancellable(async () => {
      // Noutamatta jäänyt valmis tilaus on asiakkaan vastuulla; muissa tapauksissa
      // avoin maksu mitätöidään tai jo maksettu hyvitetään.
      if (paymentStarted && reason !== 'not_collected') await acts.cancelPayment(orderId);
      if (stockReserved && !stockConsumed) await acts.releaseStock(orderId);
      await acts.transition(orderId, 'cancelled', reason);
    });
    status = 'cancelled';
    cancelReason = reason;
    if (err instanceof Abort || isBusinessFailure(err)) return { status: 'cancelled', cancelReason: reason };
    // Temporalista peruttu ajo tai ohjelmointivirhe: kompensoitu, mutta näkyy Temporalissa sellaisenaan.
    throw err;
  }
}

function isBusinessFailure(err: unknown): boolean {
  return (
    err instanceof ActivityFailure &&
    err.cause instanceof ApplicationFailure &&
    (err.cause.type === 'InvalidOrder' || err.cause.type === 'OutOfStock')
  );
}

function abortReason(err: unknown): CancelReason {
  if (err instanceof Abort) return err.reason;
  if (err instanceof ActivityFailure && err.cause instanceof ApplicationFailure) {
    if (err.cause.type === 'OutOfStock') return 'out_of_stock';
    if (err.cause.type === 'InvalidOrder') return 'invalid_order';
  }
  return isCancellation(err) ? 'operator_cancelled' : 'internal_error';
}
