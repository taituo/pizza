import { useEffect, useRef } from 'react';
import type { OrderEvent } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    staffToken?: string;
    orderToken?: string;
    conversationToken?: string;
    proposalToken?: string;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.staffToken) headers['x-staff-token'] = opts.staffToken;
  if (opts.orderToken) headers['x-order-token'] = opts.orderToken;
  if (opts.conversationToken) headers['x-conversation-token'] = opts.conversationToken;
  if (opts.proposalToken) headers['x-proposal-token'] = opts.proposalToken;
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, 'Lost connection to the server. Check your network and try again.');
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/**
 * Subscribes to the server's event stream (SSE). The browser reconnects automatically;
 * onResync is called whenever the connection (re)opens, so missed changes are fetched.
 */
export function useEvents(url: string | null, onEvent: (e: OrderEvent) => void, onResync: () => void): void {
  const handlers = useRef({ onEvent, onResync });
  handlers.current = { onEvent, onResync };
  useEffect(() => {
    if (!url) return;
    const source = new EventSource(url);
    let opened = false;
    source.addEventListener('open', () => {
      if (opened) handlers.current.onResync();
      opened = true;
    });
    source.addEventListener('resync', () => handlers.current.onResync());
    source.addEventListener('order', (msg) => {
      try {
        handlers.current.onEvent(JSON.parse((msg as MessageEvent<string>).data) as OrderEvent);
      } catch {
        /* skip a broken message */
      }
    });
    return () => source.close();
  }, [url]);
}

const eur = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' });
export const money = (cents: number): string => eur.format(cents / 100);

export const time = (iso: string): string =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export function store(kind: 'local' | 'session') {
  const s = (): Storage | null => {
    try {
      return kind === 'local' ? window.localStorage : window.sessionStorage;
    } catch {
      return null;
    }
  };
  return {
    get(key: string): string | null {
      try {
        return s()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key: string, value: string | null): void {
      try {
        if (value === null) s()?.removeItem(key);
        else s()?.setItem(key, value);
      } catch {
        /* saving is not essential */
      }
    },
  };
}

export const STATUS_LABEL: Record<string, string> = {
  created: 'Received',
  awaiting_payment: 'Awaiting payment',
  paid: 'Waiting for kitchen',
  preparing: 'Preparing',
  ready: 'Ready',
  out_for_delivery: 'Out for delivery',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const CANCEL_LABEL: Record<string, string> = {
  invalid_order: 'There was a problem with the order and it could not be processed.',
  out_of_stock: 'Something you ordered just ran out. Nothing was charged.',
  payment_failed: 'The payment failed. Nothing was charged.',
  payment_timeout: 'The order was not paid in time, so it expired. Nothing was charged.',
  customer_cancelled: 'You cancelled the order. Any payment will be refunded.',
  kitchen_rejected: 'Unfortunately the kitchen could not take the order. Your payment will be refunded.',
  kitchen_timeout: 'The kitchen did not get to the order in time. Your payment will be refunded.',
  delivery_timeout: 'The delivery did not succeed. Your payment will be refunded.',
  not_collected: 'The order was not collected.',
  operator_cancelled: 'The restaurant cancelled the order. Your payment will be refunded.',
  internal_error: 'The order could not be processed because of a technical fault. Nothing was charged.',
};
