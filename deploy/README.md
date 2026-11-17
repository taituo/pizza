# Deploying to Kubernetes

Same application, two profiles. The application manifests are Kustomize overlays; Temporal is installed with the official Helm chart.

| | Cheap VPS (`vps-k3s`) | Cloud (`cloud`) |
|---|---|---|
| Kubernetes | k3s, one node | EKS or GKE |
| Postgres | one instance in the cluster (app + Temporal) | managed, HA |
| Temporal | Helm chart, 1 replica | Helm chart with several replicas, or Temporal Cloud |
| Scaling | fixed replicas | HPA (API 2–10, workers 3–30) |

## 1. Secrets

Secrets are not kept in the repo. Create them by hand or with your own tooling (External Secrets, SOPS):

```bash
kubectl create namespace pizza
kubectl create namespace temporal

PG_PASSWORD="$(openssl rand -hex 24)"

kubectl -n pizza create secret generic pizza-secrets \
  --from-literal=POSTGRES_PASSWORD="$PG_PASSWORD" \
  --from-literal=DATABASE_URL="postgres://pizza:$PG_PASSWORD@postgres.pizza.svc.cluster.local:5432/pizza" \
  --from-literal=STAFF_TOKEN="$(openssl rand -hex 24)" \
  --from-literal=AGENT_TOKEN="$(openssl rand -hex 24)"

kubectl -n temporal create secret generic temporal-db --from-literal=password="$PG_PASSWORD"
```

Stripe: add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` to the same Secret and set `PAYMENT_PROVIDER=stripe` in the ConfigMap. The webhook address is `https://<domain>/api/webhooks/stripe`, with events `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed`.

Ordering agent: without a model the agent workers answer with the scripted harness. For Deep Agents set `AGENT_MODEL` in the `agent-config` ConfigMap (e.g. `anthropic:claude-sonnet-5-5`) and give the provider key in its own Secret, which only the agent workers mount:

```bash
kubectl -n pizza create secret generic agent-secrets --from-literal=ANTHROPIC_API_KEY=...
```

Agent workers get `AGENT_TOKEN` and nothing else from `pizza-secrets`: no database URL, no staff token. The `agent-worker` NetworkPolicy limits them to DNS, the API, Temporal and public HTTPS. k3s enforces NetworkPolicies out of the box; on EKS enable network policy support in the VPC CNI, on GKE use Dataplane V2. In the cloud overlay the agent workers prefer nodes labelled `pizza.dev/pool=agents` and tolerate the matching taint, so they can have a node pool of their own.

In the cloud profile `DATABASE_URL` points to the managed database and the `POSTGRES_PASSWORD` key is not needed.

## 2. Application and Postgres

```bash
# First set your own domain: deploy/k8s/base/ingress.yaml and PUBLIC_URL in base/config.yaml
kubectl apply -k deploy/k8s/overlays/vps-k3s     # or overlays/cloud
```

The API and workers restart until Temporal is installed (step 3). Database migrations run at startup; concurrent pods are protected by an advisory lock.

## 3. Temporal

```bash
helm upgrade --install temporal temporal --repo https://go.temporal.io/helm-charts --version 1.8.0 \
  --namespace temporal --create-namespace -f deploy/temporal/values-vps.yaml --timeout 900s
```

The chart creates Temporal's databases in the same Postgres, runs the schemas and creates the `default` namespace. Temporal UI:

```bash
kubectl -n temporal port-forward svc/temporal-web 8080:8080
```

## 4. GitOps (optional)

`deploy/argocd/applications.yaml` defines both (Temporal + application) as Argo CD applications. CI publishes the images `ghcr.io/taituo/pizza-server` and `pizza-web` with the tags `latest` and the commit SHA. In production pin the SHA tag in the overlay's `images` section, so every release is a Git commit and a rollback is `git revert`.

## Backups (VPS)

One Postgres is a single point of failure. At minimum a daily `pg_dumpall` to somewhere outside the cluster:

```bash
kubectl -n pizza exec postgres-0 -- pg_dumpall -U pizza | gzip > pizza-$(date +%F).sql.gz
```

## Not here yet

- Postgres HA in the VPS profile.
- Worker scaling on the Temporal task queue backlog (KEDA).
