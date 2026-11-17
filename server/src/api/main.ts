import { loadConfig } from '../config';
import { createPool } from '../db';
import { migrate } from '../migrate';
import { StripePaymentProvider } from '../payments/stripe';
import { createTemporalRuntime } from '../runtime';
import { buildApp } from './app';
import { EventHub } from './hub';

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (process.env.MIGRATE_ON_START !== 'false') await migrate(cfg.databaseUrl);

  const pool = createPool(cfg.databaseUrl, 20);
  const runtime = await createTemporalRuntime(cfg);
  const hub = new EventHub(cfg.databaseUrl, {
    info: (m) => console.log(m),
    error: (m) => console.error(m),
  });
  await hub.start();

  const stripe =
    cfg.paymentProvider === 'stripe' ? new StripePaymentProvider(cfg.stripeSecretKey, cfg.publicUrl) : undefined;
  const app = buildApp({ cfg, pool, runtime, conversations: runtime.conversations, hub, stripe });
  await app.listen({ port: cfg.port, host: cfg.host });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`);
    await hub.stop();
    await app.close();
    await runtime.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
