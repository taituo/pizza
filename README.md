# Agent-Native Commerce — Golden Sample 2026

A pizza shop whose orders run as long-lived, deterministic Temporal workflows on Kubernetes, with an ordering agent in front of it. The agent decides how to help the customer; the workflow guarantees the order is processed correctly. Both run on the same Temporal and the same cluster.

```
 Shop (web)   Chat with the agent   Kitchen   Driver   Overview      ← reactive UI (React, SSE)
      └──────────────┴─────────────────┴─────────┴─────────┘
                               │
                        Thin API (Fastify)                           ← validation, auth, the security boundary
               ┌───────────────┼──────────────────┐
               │               │                  │
   Temporal: order workflow    │      Temporal: conversation workflow
   validate → stock → payment  │      one per chat; each turn is one activity
   → kitchen → delivery → done │                  │
               │               │                  │
        Order workers     PostgreSQL        Agent workers (Python)
        (TypeScript)      orders, stock,    harness: Deep Agents | scripted
        idempotent        payments, events, tools = API calls with an agent token:
        activities        proposals, BI     menu, propose order, order status
```

## What is here

- **Order workflow** ([`server/src/workflows/order.ts`](server/src/workflows/order.ts)): one Temporal workflow per order. It waits for payment, the kitchen and the driver for minutes or hours without holding a process. Timeouts and compensations (refund, stock release) are part of the workflow.
- **No double charges**: every side effect is idempotent per order (one payment row and one stock reservation per order, per-order idempotency keys). A worker can be killed mid-workflow.
- **Payments**: one interface, backed by a simulated provider (default) or Stripe Checkout with signed webhooks. The server always computes the price.
- **Stock**: at ingredient level, reserved for the order and returned if the order is cancelled before preparation.
- **Delivery tracking on a map**: the driver shares their location from a phone and the customer sees it live. The location stream does not go through the workflow.
- **Views**: shop and order tracking (`/`), kitchen (`/kitchen`), driver (`/driver`), operator overview (`/ops`).
- **BI**: every business event is in the `order_events` table; ready-made views (`bi_sales_daily`, `bi_stage_durations`, `bi_cancellations`, `bi_product_sales`) live in the same Postgres. Metabase starts with the `bi` profile.
- **Ordering agent** ([`agent/`](agent/)): order by chat at `/chat`. Each conversation is a Temporal workflow ([`workflows.py`](agent/pizza_agent/workflows.py)) that keeps the history, answers messages in order and survives worker crashes; each turn runs an agent harness inside one activity. See [The agent](#the-agent).
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
| Order by chat | http://localhost:8080/chat |
| Kitchen, driver, overview | http://localhost:8080/kitchen, `/driver`, `/ops` (token `dev-staff-token`) |
| Temporal UI | http://localhost:8233 |

The `sim` profile starts a kitchen and driver simulator: place an order, press *Pay (test payment)* and watch the order progress and the driver move on the map. Without the profile you run the kitchen and delivery yourself from the staff views.

The chat is answered by the scripted harness unless you give it a model:

```bash
AGENT_MODEL=anthropic:claude-sonnet-5-5 ANTHROPIC_API_KEY=... docker compose --profile sim up --build
```

BI: `docker compose --profile bi up`, open http://localhost:3001 and add a PostgreSQL database at `postgres:5432` with database, user and password `pizza`.

### Development without containers for the app

```bash
docker compose up postgres temporal      # dependencies only
npm install
npm run dev:api                          # http://localhost:3000
npm run dev:worker
npm run dev:web                          # http://localhost:5173
npm run sim                              # optional: kitchen + drivers

cd agent && python -m venv .venv && .venv/bin/pip install -r requirements.txt -e '.[dev]'
.venv/bin/python -m pizza_agent.worker   # agent worker (scripted harness unless AGENT_MODEL is set)
npm run chat -- "two large pepperoni without onion, pickup"     # talk to the agent from the terminal
```

### Tests

```bash
npm test                                                             # unit and workflow tests
TEST_DATABASE_URL=postgres://pizza:pizza@localhost:5432/pizza npm test   # + activities and API against a real Postgres
cd agent && .venv/bin/python -m pytest                                # agent: harnesses, guard, conversation workflow
```

Workflow tests run against a real Temporal dev server (downloaded automatically; `SKIP_TEMPORAL_TESTS=1` skips them). The Deep Agents tests run the real agent loop with a scripted model, so they need no API key.

## The agent

```
customer message ─► API ─► conversation workflow ─► activity: run_turn ─► harness ─► tools ─► API
                                                                                       │
customer confirms the proposal card ─► API ─► order workflow (same as the web shop) ◄──┘ proposal only
```

- **The agent proposes, the customer confirms.** The agent's only write is `propose_order`. The API prices the proposal from its own catalog and shows the customer a confirmation card; the order is created when they confirm, through the same code path as the web shop. The agent never sees a payment and cannot set a price.
- **The security boundary is the API, not the prompt.** Agent workers hold a token that is scoped to three things: read the menu, create a proposal, read the status of this conversation's orders. They have no database credentials and no staff token, and in Kubernetes a NetworkPolicy lets them reach only the API, Temporal and the model provider.
- **Middleware as defence in depth.** Deep Agents comes with a filesystem, shell execution and sub-agents. [`CommerceGuard`](agent/pizza_agent/guard.py) hides every tool except the three commerce tools from the model and refuses calls to anything else; a model-call limit stops runaway loops.
- **The harness is replaceable.** [`harness/`](agent/pizza_agent/harness/__init__.py) is a one-method interface. Two implementations ship: Deep Agents (any LangChain chat model) and a scripted one with no model at all. Same tools, same workflow, same API; staff can pick the harness per conversation (`POST /api/conversations` with `harness`), which is how the two are compared.
- **Durability is not the agent's memory.** The workflow owns the conversation: history, ordering, timeouts, retries, a fallback reply when the harness keeps failing. The harness is rebuilt for every turn, so any worker can answer the next message.
- **Measured.** Every turn is a row in `agent_runs` (harness, model, outcome, tool calls, blocked tool calls, tokens, duration). `bi_agent_daily` and `bi_conversation_funnel` show how often conversations become paid orders.

## Demos

**Two harnesses, one shop**: order at `/chat` without a model (scripted harness), then start again with `AGENT_MODEL` set (Deep Agents). The order workflow, the API and the UI are untouched; `select * from bi_agent_daily` compares the two.

**Agent chaos**: send a chat message, `docker compose kill -s SIGKILL agent`, send another, `docker compose up -d agent`. The second message is answered when the worker is back, with the conversation's history intact.

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
agent/                  agent workers (Python): conversation workflow, harnesses, tool guard
web/                    React UI
deploy/                 Kubernetes (Kustomize), Temporal (Helm values), Argo CD
```

Principles that carry through every phase:

1. **The channel does not define business logic.** The web UI is just one client of the API. An agent, a call or WhatsApp uses the same `POST /api/orders` endpoint (field `channel`) and the same workflow.
2. **The agent proposes, the workflow decides.** Price, payment and order status are never in the caller's hands. A signal that arrives in the wrong stage does nothing.
3. **The API does not know Temporal** outside `runtime.ts`, and the UI does not know it at all.

## Limits

- The Deep Agents harness is tested with a scripted model through the real agent loop, but has not been run against a live model provider here. Try it with your own key before relying on it.
- The scripted harness understands plain English orders against the menu; it is a fallback and a test double, not a language model.
- The agent does not geocode: for delivery the customer marks the spot on the confirmation card's map.
- Chat replies arrive whole, not streamed token by token.
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
| **2 (done)** | Ordering agent (Deep Agents wrapped in Temporal, middleware limits the tools) and a chat UI |
| 3 | Channels: phone (ElevenLabs + Twilio), WhatsApp, email through a shared channel adapter; customer identity |
| 4 | Development agents in the same cluster on their own node pool: GitHub issue → PR → CI → canary; improvement suggestions from BI |
