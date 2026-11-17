import type { ServerResponse } from 'node:http';
import { Client } from 'pg';
import { EVENTS_CHANNEL, type EventNotification } from '../db';

/**
 * Realtime bus: one Postgres LISTEN connection per API process, fanned out to
 * SSE subscribers. No separate message queue is needed, and there can be many API replicas.
 */
export class EventHub {
  private readonly orderSubs = new Map<string, Set<ServerResponse>>();
  private readonly staffSubs = new Set<ServerResponse>();
  private client: Client | undefined;
  private stopped = false;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(
    private readonly databaseUrl: string,
    private readonly log: { info: (msg: string) => void; error: (msg: string) => void },
  ) {}

  async start(): Promise<void> {
    await this.connect();
    this.heartbeat = setInterval(() => this.broadcastRaw(': ping\n\n'), 20_000);
    this.heartbeat.unref();
  }

  private async connect(): Promise<void> {
    const client = new Client({ connectionString: this.databaseUrl });
    const reconnect = (why: string) => {
      if (this.stopped || this.client !== client) return;
      this.client = undefined;
      this.log.error(`[hub] LISTEN connection lost (${why}), reconnecting`);
      setTimeout(() => {
        this.connect().catch((err) => reconnect((err as Error).message));
      }, 1000).unref();
    };
    this.client = client;
    client.on('error', (err) => reconnect(err.message));
    client.on('end', () => reconnect('end'));
    client.on('notification', (msg) => {
      if (!msg.payload) return;
      try {
        this.dispatch(JSON.parse(msg.payload) as EventNotification);
      } catch (err) {
        this.log.error(`[hub] bad notification: ${(err as Error).message}`);
      }
    });
    try {
      await client.connect();
      await client.query(`listen ${EVENTS_CHANNEL}`);
      // Events may have been missed during the outage: ask everyone to refetch their state.
      this.broadcastRaw(`event: resync\ndata: {}\n\n`);
    } catch (err) {
      reconnect((err as Error).message);
    }
  }

  private dispatch(n: EventNotification): void {
    const frame = `event: order\ndata: ${JSON.stringify(n)}\n\n`;
    for (const res of this.orderSubs.get(n.orderId) ?? []) res.write(frame);
    for (const res of this.staffSubs) res.write(frame);
  }

  private broadcastRaw(frame: string): void {
    for (const subs of this.orderSubs.values()) for (const res of subs) res.write(frame);
    for (const res of this.staffSubs) res.write(frame);
  }

  subscribe(res: ServerResponse, orderId?: string): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    let subs: Set<ServerResponse>;
    if (orderId) {
      subs = this.orderSubs.get(orderId) ?? new Set();
      this.orderSubs.set(orderId, subs);
    } else {
      subs = this.staffSubs;
    }
    subs.add(res);
    res.on('close', () => {
      subs.delete(res);
      if (orderId && subs.size === 0) this.orderSubs.delete(orderId);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const subs of this.orderSubs.values()) for (const res of subs) res.end();
    for (const res of this.staffSubs) res.end();
    await this.client?.end().catch(() => undefined);
  }
}
