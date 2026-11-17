import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import type { Config } from './config';
import {
  cancelRequestedSignal,
  driverAssignedSignal,
  handedOverSignal,
  kitchenDecisionSignal,
  kitchenReadySignal,
  paymentResultSignal,
  type OrderWorkflowInput,
} from './domain/signals';
import { workflowIdForOrder, type Fulfillment } from './domain/types';

/** The order workflow has already finished or does not exist: the signal could not be delivered. */
export class OrderNotActiveError extends Error {
  constructor(orderId: string) {
    super(`Order workflow ${orderId} is not running`);
    this.name = 'OrderNotActiveError';
  }
}

/**
 * The only interface through which the API (and later agents and channel adapters) touches
 * order workflows. Outside this file the API knows nothing about Temporal.
 */
export interface OrderRuntime {
  start(orderId: string, fulfillment: Fulfillment): Promise<void>;
  paymentResult(orderId: string, status: 'succeeded' | 'failed'): Promise<void>;
  kitchenDecision(orderId: string, accepted: boolean): Promise<void>;
  kitchenReady(orderId: string): Promise<void>;
  driverAssigned(orderId: string, driverId: string): Promise<void>;
  handedOver(orderId: string): Promise<void>;
  cancel(orderId: string, reason: 'customer_cancelled' | 'operator_cancelled'): Promise<void>;
  close(): Promise<void>;
}

export async function connectTemporal(cfg: Config): Promise<Connection> {
  return Connection.connect({
    address: cfg.temporalAddress,
    ...(cfg.temporalApiKey ? { apiKey: cfg.temporalApiKey, tls: true } : {}),
  });
}

export async function createTemporalRuntime(cfg: Config): Promise<OrderRuntime> {
  const connection = await connectTemporal(cfg);
  const client = new Client({ connection, namespace: cfg.temporalNamespace });

  const handle = (orderId: string) => client.workflow.getHandle(workflowIdForOrder(orderId));
  const deliver = async (orderId: string, send: () => Promise<void>): Promise<void> => {
    try {
      await send();
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) throw new OrderNotActiveError(orderId);
      throw err;
    }
  };

  return {
    async start(orderId, fulfillment) {
      const input: OrderWorkflowInput = { orderId, fulfillment };
      await client.workflow.start('orderWorkflow', {
        taskQueue: cfg.taskQueue,
        workflowId: workflowIdForOrder(orderId),
        args: [input],
      });
    },
    paymentResult: (id, status) => deliver(id, () => handle(id).signal(paymentResultSignal, { status })),
    kitchenDecision: (id, accepted) => deliver(id, () => handle(id).signal(kitchenDecisionSignal, { accepted })),
    kitchenReady: (id) => deliver(id, () => handle(id).signal(kitchenReadySignal)),
    driverAssigned: (id, driverId) => deliver(id, () => handle(id).signal(driverAssignedSignal, { driverId })),
    handedOver: (id) => deliver(id, () => handle(id).signal(handedOverSignal)),
    cancel: (id, reason) => deliver(id, () => handle(id).signal(cancelRequestedSignal, { reason })),
    async close() {
      await connection.close();
    },
  };
}
