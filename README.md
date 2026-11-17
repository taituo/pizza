# Agent-Native Commerce — Golden Sample 2026

A pizza shop whose orders run as long-lived, deterministic Temporal workflows on Kubernetes. Agents, phone and messaging channels and development agents all use the same order API and the same workflow.

```
 Customer (web)    Kitchen     Driver      Overview              ← reactive UI (React, SSE)
       └──────────────┴────────────┴──────────────┘
                          │
                     Thin API (Fastify)                          ← validation, auth, signals
                    ┌─────┴──────────────┐
                    │                    │
          Temporal: order workflow   PostgreSQL                  ← one database: orders, stock,
     validate → stock → payment        │  ▲                        payments, events, BI views
     → kitchen → delivery → done       │  │ LISTEN/NOTIFY → SSE
                    │                  │  │
              Workers (N) ─────────────┘  │
              activities: idempotent ─────┘
```

## What is here

- **Order workflow** ([`server/src/workflows/order.ts`](server/src/workflows/order.ts)): one Temporal workflow per order. It waits for payment, the kitchen and the driver for minutes or hours without holding a process. Timeouts and compensations (refund, stock release) are part of the workflow.
- **No double charges**: every side effect is idempotent per order (one payment row and one stock reservation per order, per-order idempotency keys). A worker can be killed mid-workflow.
- **Payments**: one interface, backed by a simulated provider (default) or Stripe Checkout with signed webhooks. The server always computes the price.
- **Stock**: at ingredient level, reserved for the order and returned if the order is cancelled before preparation.
- **Delivery tracking on a map**: the driver shares their location from a phone and the customer sees it live. The location stream does not go through the workflow.
- **Views**: shop and order tracking (`/`), kitchen (`/kitchen`), driver (`/driver`), operator overview (`/ops`).
- **BI**: every business event is in the `order_events` table; ready-made views (`bi_sales_daily`, `bi_stage_durations`, `bi_cancellations`, `bi_product_sales`) live in the same Postgres. Metabase starts with the `bi` profile.
- **Kubernetes**: Kustomize overlays for a cheap VPS (k3s) and the cloud (EKS/GKE), Temporal by Helm chart on the same Postgres. See [`deploy/README.md`](deploy/README.md).
- **CI/CD**: typecheck, tests, manifest rendering and a full-chain run on Docker Compose where the workers are killed under load. Images go to GHCR; Argo CD definitions are included.

## Running it

Requires Docker.

```bash
docker compose --profile sim up --build
```

| | |
|---|---|
| Shop | http://localhost:8080 |
| Kitchen, driver, overview | http://localhost:8080/kitchen, `/driver`, `/ops` (token `dev-staff-token`) |
| Temporal UI | http://localhost:8233 |

The `sim` profile starts a kitchen and driver simulator: place an order, press *Pay (test payment)* and watch the order progress and the driver move on the map. Without the profile you run the kitchen and delivery yourself from the staff views.

BI: `docker compose --profile bi up`, open http://localhost:3001 and add a PostgreSQL database at `postgres:5432` with database, user and password `pizza`.

### Development without containers for the app

```bash
docker compose up postgres temporal      # dependencies only
npm install
npm run dev:api                          # http://localhost:3000
npm run dev:worker
npm run dev:web                          # http://localhost:5173
npm run sim                              # optional: kitchen + drivers
```

### Tests

```bash
npm test                                                             # unit and workflow tests
TEST_DATABASE_URL=postgres://pizza:pizza@localhost:5432/pizza npm test   # + activities and API against a real Postgres
```

Workflow tests run against a real Temporal dev server (downloaded automatically; `SKIP_TEMPORAL_TESTS=1` skips them).

## Demos

**Chaos**: place an order, kill the workers and start them again. The workflow continues from where it stopped.

```bash
docker compose kill -s SIGKILL worker && docker compose up -d worker
```

**Flaky payment provider**: `SIM_PAYMENT_FAIL_RATE=0.3 docker compose --profile sim up`. The retries show in the Temporal UI; the database has exactly one payment per order.

**Load**:

```bash
npm run load -- --orders 10000 --concurrency 50 --restock            # 10,000 workflows waiting for payment
npm run load -- --orders 500 --restock --pay --wait                  # workflows to completion (with the simulator)
```

The first command is the "10,000 concurrent workflows" case: the workflows wait 15 minutes for payment, then expire in a controlled way and the stock comes back. Throughput for 10,000 workflows has not been measured on a real cluster yet; it is a measurement, not a promise of the architecture.

## Layout

```
server/                 one package, three start commands (api, worker, sim)
  src/workflows/        order workflow (deterministic code)
  src/activities/       side effects: pricing, stock, payments, status transitions
  src/payments/         payment interface: sim + Stripe
  src/api/              thin API and SSE bus
  src/runtime.ts        the only place where the API touches Temporal
  src/sim/              kitchen and driver simulator, load generator
  migrations/           schema, menu, BI views
web/                    React UI
deploy/                 Kubernetes (Kustomize), Temporal (Helm values), Argo CD
```

Principles that carry through every phase:

1. **The channel does not define business logic.** The web UI is just one client of the API. An agent, a call or WhatsApp uses the same `POST /api/orders` endpoint (field `channel`) and the same workflow.
2. **The agent proposes, the workflow decides.** Price, payment and order status are never in the caller's hands. A signal that arrives in the wrong stage does nothing.
3. **The API does not know Temporal** outside `runtime.ts`, and the UI does not know it at all.

## Limits

- No customer accounts: an order is tracked with a secret link. Staff share one token; there are no per-user permissions.
- The Stripe implementation follows Stripe's APIs but has not been run with real keys. Run it in test mode before going live.
- The delivery location is picked on the map; there is no address search (geocoding).
- The API has no rate limiting. Add it at the ingress or in the API before public use.
- Map tiles come from OpenStreetMap's public servers, which are meant for light use. Use your own or a commercial tile service in production.
- Location and customer data are personal data: retention periods and a privacy notice are missing.

## Roadmap

| Phase | Content |
|---|---|
| **1 (done)** | Shop, order workflow, payments, stock, map tracking, BI views, Kubernetes, CI |
| 2 | Ordering agent (Deep Agents wrapped in Temporal, middleware limits the tools) and a chat UI |
| 3 | Channels: phone (ElevenLabs + Twilio), WhatsApp, email through a shared channel adapter; customer identity |
| 4 | Development agents in the same cluster on their own node pool: GitHub issue → PR → CI → canary; improvement suggestions from BI |
