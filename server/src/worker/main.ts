import { NativeConnection, Worker } from '@temporalio/worker';
import { createActivities } from '../activities';
import { loadConfig } from '../config';
import { createPool } from '../db';
import { migrate } from '../migrate';
import { createPaymentProvider } from '../payments';

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (process.env.MIGRATE_ON_START !== 'false') await migrate(cfg.databaseUrl);

  const pool = createPool(cfg.databaseUrl, 20);
  const connection = await NativeConnection.connect({
    address: cfg.temporalAddress,
    ...(cfg.temporalApiKey ? { apiKey: cfg.temporalApiKey, tls: true } : {}),
  });

  const worker = await Worker.create({
    connection,
    namespace: cfg.temporalNamespace,
    taskQueue: cfg.taskQueue,
    workflowsPath: require.resolve('../workflows'),
    activities: createActivities({ pool, payments: createPaymentProvider(cfg), cfg }),
    maxConcurrentActivityTaskExecutions: cfg.workerMaxConcurrentActivities,
    maxConcurrentWorkflowTaskExecutions: cfg.workerMaxConcurrentWorkflowTasks,
    // SIGTERM (e.g. a Kubernetes rolling update): in-flight activities get a moment to finish.
    shutdownGraceTime: '20 seconds',
  });

  console.log(`[worker] polling task queue "${cfg.taskQueue}" at ${cfg.temporalAddress}`);
  try {
    await worker.run(); // returns once the worker has shut down cleanly (SIGTERM/SIGINT)
  } finally {
    await connection.close();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
