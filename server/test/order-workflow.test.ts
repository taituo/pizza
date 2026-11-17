/**
 * Order workflow tests against a real Temporal server (dev server, downloaded automatically).
 * Activities are replaced with in-memory ones, so the tests target the workflow's logic:
 * ordering, compensations, timeouts and stage-specific acceptance of signals.
 *
 * TEMPORAL_CLI_PATH: use an already installed temporal binary.
 * SKIP_TEMPORAL_TESTS=1: skip (an environment where the server cannot be downloaded).
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker, type WorkflowBundle } from '@temporalio/worker';
import type { WorkflowHandle } from '@temporalio/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Activities } from '../src/activities';
import {
  cancelRequestedSignal,
  driverAssignedSignal,
  handedOverSignal,
  kitchenDecisionSignal,
  kitchenReadySignal,
  orderStateQuery,
  paymentResultSignal,
  type OrderTimeouts,
  type OrderWorkflowResult,
} from '../src/domain/signals';
import type { Fulfillment, OrderStatus } from '../src/domain/types';

const skip = process.env.SKIP_TEMPORAL_TESTS === '1';

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundle;

beforeAll(async () => {
  if (skip) return;
  const existing = process.env.TEMPORAL_CLI_PATH;
  env = await TestWorkflowEnvironment.createLocal(
    existing ? { server: { executable: { type: 'existing-path', path: existing } } } : undefined,
  );
  workflowBundle = await bundleWorkflowCode({ workflowsPath: join(__dirname, '../src/workflows/index.ts') });
});

afterAll(async () => {
  await env?.teardown();
});

interface Harness {
  calls: string[];
  overrides: Partial<Activities>;
}

function fakeActivities(h: Harness): Activities {
  const record =
    <A extends unknown[]>(name: string, label: (...args: A) => string = () => name) =>
    async (...args: A): Promise<void> => {
      h.calls.push(label(...args));
    };
  const base: Activities = {
    validateAndPrice: async () => {
      h.calls.push('validateAndPrice');
      return { totalCents: 1290 };
    },
    reserveStock: record('reserveStock'),
    releaseStock: record('releaseStock'),
    startPayment: record('startPayment'),
    cancelPayment: record('cancelPayment'),
    refundPayment: record('refundPayment'),
    transition: record('transition', (_id: string, status: OrderStatus, reason?: string) =>
      reason ? `→${status}(${reason})` : `→${status}`,
    ),
  };
  return { ...base, ...h.overrides };
}

async function run(
  opts: { fulfillment?: Fulfillment; timeouts?: Partial<OrderTimeouts>; overrides?: Partial<Activities> },
  drive: (handle: WorkflowHandle, until: (s: OrderStatus) => Promise<void>) => Promise<void>,
): Promise<{ result: OrderWorkflowResult; calls: string[] }> {
  const h: Harness = { calls: [], overrides: opts.overrides ?? {} };
  const taskQueue = `test-${randomUUID()}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle,
    activities: fakeActivities(h),
  });
  const result = await worker.runUntil(async () => {
    const orderId = randomUUID();
    const handle = await env.client.workflow.start('orderWorkflow', {
      taskQueue,
      workflowId: `order-${orderId}`,
      args: [{ orderId, fulfillment: opts.fulfillment ?? 'delivery', timeouts: opts.timeouts }],
    });
    const until = async (status: OrderStatus): Promise<void> => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const state = await handle.query(orderStateQuery);
        if (state.status === status) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${status}, at ${state.status}`);
        await new Promise((r) => setTimeout(r, 40));
      }
    };
    await drive(handle, until);
    return (await handle.result()) as OrderWorkflowResult;
  });
  return { result, calls: h.calls };
}

describe.skipIf(skip)('orderWorkflow', () => {
  it('runs a delivery order from validation to completion in order', async () => {
    const { result, calls } = await run({}, async (wf, until) => {
      await until('awaiting_payment');
      await wf.signal(paymentResultSignal, { status: 'succeeded' });
      await until('paid');
      await wf.signal(kitchenDecisionSignal, { accepted: true });
      await until('preparing');
      await wf.signal(kitchenReadySignal);
      await until('ready');
      await wf.signal(driverAssignedSignal, { driverId: 'd1' });
      await until('out_for_delivery');
      await wf.signal(handedOverSignal);
    });
    expect(result).toEqual({ status: 'completed' });
    expect(calls).toEqual([
      'validateAndPrice',
      'reserveStock',
      'startPayment',
      '→awaiting_payment',
      '→paid',
      '→preparing',
      '→ready',
      '→out_for_delivery',
      '→completed',
    ]);
  });

  it('completes a pickup order without a driver', async () => {
    const { result, calls } = await run({ fulfillment: 'pickup' }, async (wf, until) => {
      await until('awaiting_payment');
      await wf.signal(paymentResultSignal, { status: 'succeeded' });
      await until('paid');
      await wf.signal(kitchenDecisionSignal, { accepted: true });
      await until('preparing');
      await wf.signal(kitchenReadySignal);
      await until('ready');
      await wf.signal(handedOverSignal);
    });
    expect(result.status).toBe('completed');
    expect(calls).not.toContain('→out_for_delivery');
  });

  it('refunds and releases stock when the kitchen rejects a paid order', async () => {
    const { result, calls } = await run({}, async (wf, until) => {
      await until('awaiting_payment');
      await wf.signal(paymentResultSignal, { status: 'succeeded' });
      await until('paid');
      await wf.signal(kitchenDecisionSignal, { accepted: false });
    });
    expect(result).toEqual({ status: 'cancelled', cancelReason: 'kitchen_rejected' });
    expect(calls.slice(-3)).toEqual(['cancelPayment', 'releaseStock', '→cancelled(kitchen_rejected)']);
  });

  it('cancels the open payment and releases stock when nobody pays in time', async () => {
    const { result, calls } = await run({ timeouts: { paymentMs: 300 } }, async () => undefined);
    expect(result).toEqual({ status: 'cancelled', cancelReason: 'payment_timeout' });
    expect(calls.slice(-3)).toEqual(['cancelPayment', 'releaseStock', '→cancelled(payment_timeout)']);
    expect(calls).not.toContain('→paid');
  });

  it('refunds when the kitchen never responds', async () => {
    const { result } = await run({ timeouts: { kitchenAcceptMs: 300 } }, async (wf, until) => {
      await until('awaiting_payment');
      await wf.signal(paymentResultSignal, { status: 'succeeded' });
    });
    expect(result).toEqual({ status: 'cancelled', cancelReason: 'kitchen_timeout' });
  });

  it('never opens a payment when stock runs out', async () => {
    const { result, calls } = await run(
      {
        overrides: {
          reserveStock: async () => {
            throw ApplicationFailure.nonRetryable('loppu', 'OutOfStock');
          },
        },
      },
      async () => undefined,
    );
    expect(result).toEqual({ status: 'cancelled', cancelReason: 'out_of_stock' });
    expect(calls).toEqual(['validateAndPrice', '→cancelled(out_of_stock)']);
  });

  it('lets the customer cancel before the kitchen accepts, with a refund', async () => {
    const { result, calls } = await run({}, async (wf, until) => {
      await until('awaiting_payment');
      await wf.signal(paymentResultSignal, { status: 'succeeded' });
      await until('paid');
      await wf.signal(cancelRequestedSignal, { reason: 'customer_cancelled' });
    });
    expect(result).toEqual({ status: 'cancelled', cancelReason: 'customer_cancelled' });
    expect(calls).toContain('cancelPayment');
    expect(calls).toContain('releaseStock');
  });

  it('ignores a customer cancel once the kitchen has started, and keeps consumed stock on operator cancel', async () => {
    const { result, calls } = await run({}, async (wf, until) => {
      await until('awaiting_payment');
      await wf.signal(paymentResultSignal, { status: 'succeeded' });
      await until('paid');
      await wf.signal(kitchenDecisionSignal, { accepted: true });
      await until('preparing');
      await wf.signal(cancelRequestedSignal, { reason: 'customer_cancelled' });
      await wf.signal(kitchenReadySignal);
      await until('ready');
      await wf.signal(cancelRequestedSignal, { reason: 'operator_cancelled' });
    });
    expect(result).toEqual({ status: 'cancelled', cancelReason: 'operator_cancelled' });
    expect(calls).toContain('→ready');
    expect(calls).toContain('cancelPayment');
    expect(calls).not.toContain('releaseStock');
  });

  it('ignores signals that arrive in the wrong stage', async () => {
    const { result, calls } = await run({ timeouts: { kitchenAcceptMs: 400 } }, async (wf, until) => {
      await until('awaiting_payment');
      // Kitchen and driver signals before payment must not skip stages.
      await wf.signal(kitchenDecisionSignal, { accepted: true });
      await wf.signal(kitchenReadySignal);
      await wf.signal(driverAssignedSignal, { driverId: 'd1' });
      await wf.signal(handedOverSignal);
      await wf.signal(paymentResultSignal, { status: 'succeeded' });
      await wf.signal(paymentResultSignal, { status: 'failed' }); // late duplicate webhook
    });
    expect(calls).toContain('→paid');
    expect(calls).not.toContain('→preparing');
    expect(result).toEqual({ status: 'cancelled', cancelReason: 'kitchen_timeout' });
  });

  it('accepts a signal sent the instant the new status becomes visible', async () => {
    // Regression: a driver takes the order the moment "ready" shows in the database. The signal lands
    // in history before the transition completes and is processed in the same batch with it.
    const calls: string[] = [];
    const { result } = await run(
      {
        overrides: {
          transition: async (id, status) => {
            calls.push(status);
            if (status === 'ready') {
              await env.client.workflow.getHandle(`order-${id}`).signal(driverAssignedSignal, { driverId: 'd1' });
            }
            if (status === 'out_for_delivery') {
              await env.client.workflow.getHandle(`order-${id}`).signal(handedOverSignal);
            }
          },
        },
        timeouts: { driverAssignMs: 5_000, handoverMs: 5_000 },
      },
      async (wf, until) => {
        await until('awaiting_payment');
        await wf.signal(paymentResultSignal, { status: 'succeeded' });
        await until('paid');
        await wf.signal(kitchenDecisionSignal, { accepted: true });
        await until('preparing');
        await wf.signal(kitchenReadySignal);
      },
    );
    expect(result).toEqual({ status: 'completed' });
    expect(calls).toEqual(['awaiting_payment', 'paid', 'preparing', 'ready', 'out_for_delivery', 'completed']);
  });

  it('retries a failing activity instead of failing the order', async () => {
    let attempts = 0;
    const { result } = await run(
      {
        overrides: {
          startPayment: async () => {
            attempts++;
            if (attempts < 3) throw new Error('payment provider is down');
          },
        },
      },
      async (wf, until) => {
        await until('awaiting_payment');
        await wf.signal(paymentResultSignal, { status: 'failed' });
      },
    );
    expect(attempts).toBe(3);
    expect(result).toEqual({ status: 'cancelled', cancelReason: 'payment_failed' });
  });
});
