function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = Number(env(name, String(fallback)));
  if (!Number.isFinite(v)) throw new Error(`${name} must be a number`);
  return v;
}

const DEV_STAFF_TOKEN = 'dev-staff-token';

export interface Config {
  databaseUrl: string;
  temporalAddress: string;
  temporalNamespace: string;
  temporalApiKey: string;
  taskQueue: string;
  port: number;
  host: string;
  publicUrl: string;
  staffToken: string;
  paymentProvider: 'sim' | 'stripe';
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  simPaymentFailRate: number;
  restaurant: { name: string; lat: number; lng: number };
  deliveryRadiusKm: number;
  deliveryFeeCents: number;
  workerMaxConcurrentActivities: number;
  workerMaxConcurrentWorkflowTasks: number;
}

export function loadConfig(): Config {
  const paymentProvider = env('PAYMENT_PROVIDER', 'sim');
  if (paymentProvider !== 'sim' && paymentProvider !== 'stripe') {
    throw new Error("PAYMENT_PROVIDER must be 'sim' or 'stripe'");
  }
  const staffToken = env('STAFF_TOKEN', DEV_STAFF_TOKEN);
  if (process.env.NODE_ENV === 'production' && staffToken === DEV_STAFF_TOKEN) {
    throw new Error('STAFF_TOKEN must be set in production');
  }
  const cfg: Config = {
    databaseUrl: env('DATABASE_URL', 'postgres://pizza:pizza@localhost:5432/pizza'),
    temporalAddress: env('TEMPORAL_ADDRESS', 'localhost:7233'),
    temporalNamespace: env('TEMPORAL_NAMESPACE', 'default'),
    temporalApiKey: env('TEMPORAL_API_KEY', ''),
    taskQueue: env('TEMPORAL_TASK_QUEUE', 'orders'),
    port: num('PORT', 3000),
    host: env('HOST', '0.0.0.0'),
    publicUrl: env('PUBLIC_URL', 'http://localhost:5173').replace(/\/$/, ''),
    staffToken,
    paymentProvider,
    stripeSecretKey: env('STRIPE_SECRET_KEY', ''),
    stripeWebhookSecret: env('STRIPE_WEBHOOK_SECRET', ''),
    simPaymentFailRate: num('SIM_PAYMENT_FAIL_RATE', 0),
    restaurant: {
      name: env('RESTAURANT_NAME', 'Pizzeria Kultainen Näyte'),
      lat: num('RESTAURANT_LAT', 60.1699),
      lng: num('RESTAURANT_LNG', 24.9384),
    },
    deliveryRadiusKm: num('DELIVERY_RADIUS_KM', 8),
    deliveryFeeCents: num('DELIVERY_FEE_CENTS', 390),
    workerMaxConcurrentActivities: num('WORKER_MAX_CONCURRENT_ACTIVITIES', 100),
    workerMaxConcurrentWorkflowTasks: num('WORKER_MAX_CONCURRENT_WORKFLOW_TASKS', 100),
  };
  if (cfg.paymentProvider === 'stripe' && (!cfg.stripeSecretKey || !cfg.stripeWebhookSecret)) {
    throw new Error('PAYMENT_PROVIDER=stripe requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET');
  }
  return cfg;
}
