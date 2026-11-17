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
    // No maximum attempts: a transient failure (database, payment provider) must not fail the order.
    // Permanent business errors are thrown from activities as nonRetryable.
  },
});

/** Internal abort: the workflow unwinds with compensations and the order ends as cancelled. */
class Abort extends Error {
  constructor(readonly reason: CancelReason) {
    super(reason);
  }
}

/**
 * Order workflow: validate → reserve stock → payment → kitchen → delivery/pickup → done.
 *
 * A deterministic process that can wait for a person or an external system for hours
 * without holding any process. The outside world (API, webhooks, kitchen, driver,
 * later agents) steers it only with signals; the workflow itself decides what is allowed.
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

  // Signals are accepted only in the stage they belong to. A signal that arrives in the
  // wrong stage (double click, late webhook) changes nothing.
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
    // The customer can cancel until the kitchen has accepted the order.
    const customerMayCancel = status === 'created' || status === 'awaiting_payment' || status === 'paid';
    if (reason === 'operator_cancelled' || customerMayCancel) cancelRequested ??= reason;
  });
  setHandler(orderStateQuery, () => ({ status, cancelReason }));

  // The workflow's own state changes BEFORE the status is written to the database. The outside
  // world sees the new status only from the database, so a signal sent because of it (e.g. a driver
  // taking an order that just became ready) always lands in a stage the workflow already accepts,
  // even if the signal and the activity completion are processed in one batch after a worker outage.
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

    // --- Payment ---
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

    // --- Kitchen ---
    const gotDecision = await condition(
      () => kitchenDecision !== undefined || cancelRequested !== undefined,
      timeouts.kitchenAcceptMs,
    );
    if (kitchenDecision !== true) {
      if (cancelRequested) throw new Abort(cancelRequested);
      throw new Abort(gotDecision ? 'kitchen_rejected' : 'kitchen_timeout');
    }
    await transition('preparing');
    stockConsumed = true; // the ingredients are used; they are no longer returned to stock

    const prepared = await condition(
      () => kitchenReady || cancelRequested !== undefined,
      timeouts.kitchenPrepareMs,
    );
    checkCancel();
    if (!prepared) throw new Abort('kitchen_timeout');
    await transition('ready');

    // --- Delivery or pickup ---
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
    // Compensations run to completion even if the whole workflow was cancelled from Temporal.
    await CancellationScope.nonCancellable(async () => {
      // A finished order that was never collected is the customer's responsibility; otherwise
      // an open payment is voided or a completed one refunded.
      if (paymentStarted && reason !== 'not_collected') await acts.cancelPayment(orderId);
      if (stockReserved && !stockConsumed) await acts.releaseStock(orderId);
      await acts.transition(orderId, 'cancelled', reason);
    });
    status = 'cancelled';
    cancelReason = reason;
    if (err instanceof Abort || isBusinessFailure(err)) return { status: 'cancelled', cancelReason: reason };
    // Cancelled from Temporal or a programming error: compensated, but surfaces in Temporal as such.
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
