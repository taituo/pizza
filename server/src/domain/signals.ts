import { defineQuery, defineSignal } from '@temporalio/workflow';
import type { CancelReason, Fulfillment, OrderStatus } from './types';

export const paymentResultSignal = defineSignal<[{ status: 'succeeded' | 'failed' }]>('paymentResult');
export const kitchenDecisionSignal = defineSignal<[{ accepted: boolean }]>('kitchenDecision');
export const kitchenReadySignal = defineSignal('kitchenReady');
export const driverAssignedSignal = defineSignal<[{ driverId: string }]>('driverAssigned');
export const handedOverSignal = defineSignal('handedOver');
export const cancelRequestedSignal = defineSignal<[{ reason: 'customer_cancelled' | 'operator_cancelled' }]>(
  'cancelRequested',
);

export interface OrderWorkflowState {
  status: OrderStatus;
  cancelReason?: CancelReason;
}
export const orderStateQuery = defineQuery<OrderWorkflowState>('orderState');

export interface OrderTimeouts {
  paymentMs: number;
  kitchenAcceptMs: number;
  kitchenPrepareMs: number;
  driverAssignMs: number;
  handoverMs: number;
}

export const DEFAULT_TIMEOUTS: OrderTimeouts = {
  paymentMs: 15 * 60_000,
  kitchenAcceptMs: 10 * 60_000,
  kitchenPrepareMs: 2 * 60 * 60_000,
  driverAssignMs: 2 * 60 * 60_000,
  handoverMs: 4 * 60 * 60_000,
};

export interface OrderWorkflowInput {
  orderId: string;
  fulfillment: Fulfillment;
  timeouts?: Partial<OrderTimeouts>;
}

export interface OrderWorkflowResult {
  status: 'completed' | 'cancelled';
  cancelReason?: CancelReason;
}
