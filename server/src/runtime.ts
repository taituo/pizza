import { Client, Connection, WithStartWorkflowOperation, WorkflowNotFoundError } from '@temporalio/client';
import type { Workflow } from '@temporalio/common';
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

export interface ChatMessage {
  role: 'user' | 'agent';
  content: string;
}

/** What one agent turn produced. Field names match the Python agent worker's TurnResult. */
export interface AgentTurnResult {
  reply: string;
  proposal_id: string | null;
  harness: string;
  model: string | null;
  outcome: 'replied' | 'proposed' | 'failed';
  tool_calls: number;
  blocked_tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
}

/**
 * Conversations with the ordering agent. Each conversation is a long-lived workflow on the
 * agents task queue; which harness (Deep Agents, scripted, ...) answers is the agent worker's business.
 */
export interface ConversationRuntime {
  /**
   * Delivers a customer message and waits for the agent's reply. `history` seeds the workflow
   * when it has to be (re)started, e.g. after it closed for being idle.
   */
  send(conversationId: string, text: string, history: ChatMessage[], harness?: string | null): Promise<AgentTurnResult>;
}

export type Runtime = OrderRuntime & { conversations: ConversationRuntime };

export function workflowIdForConversation(conversationId: string): string {
  return `conversation-${conversationId}`;
}

export async function connectTemporal(cfg: Config): Promise<Connection> {
  return Connection.connect({
    address: cfg.temporalAddress,
    ...(cfg.temporalApiKey ? { apiKey: cfg.temporalApiKey, tls: true } : {}),
  });
}

export async function createTemporalRuntime(cfg: Config): Promise<Runtime> {
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
    conversations: {
      async send(conversationId, text, history, harness) {
        // Update-with-start: the first message starts the conversation workflow, later ones reach
        // the running one, and a conversation that closed for being idle starts again from `history`.
        const start = new WithStartWorkflowOperation('ConversationWorkflow', {
          taskQueue: cfg.agentTaskQueue,
          workflowId: workflowIdForConversation(conversationId),
          workflowIdConflictPolicy: 'USE_EXISTING',
          args: [{ conversation_id: conversationId, history, harness: harness ?? null }],
        });
        return client.workflow.executeUpdateWithStart<Workflow, AgentTurnResult, [string]>('send_message', {
          startWorkflowOperation: start,
          args: [text],
        });
      },
    },
    async close() {
      await connection.close();
    },
  };
}
