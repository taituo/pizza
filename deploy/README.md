# Käyttöönotto Kubernetesiin

Sama sovellus, kaksi profiilia. Sovelluksen manifestit ovat Kustomize-overlayta, Temporal asennetaan virallisella Helm-chartilla.

| | Halpa VPS (`vps-k3s`) | Pilvi (`cloud`) |
|---|---|---|
| Kubernetes | k3s, yksi solmu | EKS tai GKE |
| Postgres | yksi instanssi klusterissa (sovellus + Temporal) | hallittu, HA |
| Temporal | Helm-chart, 1 replika | Helm-chart useilla replikoilla tai Temporal Cloud |
| Skaalaus | kiinteät replikat | HPA (API 2–10, workerit 3–30) |

## 1. Salaisuudet

Salaisuuksia ei säilytetä repossa. Luo ne käsin tai omalla työkalullasi (External Secrets, SOPS):

```bash
kubectl create namespace pizza
kubectl create namespace temporal

PG_PASSWORD="$(openssl rand -hex 24)"

kubectl -n pizza create secret generic pizza-secrets \
  --from-literal=POSTGRES_PASSWORD="$PG_PASSWORD" \
  --from-literal=DATABASE_URL="postgres://pizza:$PG_PASSWORD@postgres.pizza.svc.cluster.local:5432/pizza" \
  --from-literal=STAFF_TOKEN="$(openssl rand -hex 24)"

kubectl -n temporal create secret generic temporal-db --from-literal=password="$PG_PASSWORD"
```

Stripe: lisää samaan Secretiin `STRIPE_SECRET_KEY` ja `STRIPE_WEBHOOK_SECRET` ja aseta ConfigMapissa `PAYMENT_PROVIDER=stripe`. Webhookin osoite on `https://<domain>/api/webhooks/stripe`, tapahtumat `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded` ja `checkout.session.async_payment_failed`.

Pilviprofiilissa `DATABASE_URL` osoittaa hallittuun kantaan eikä `POSTGRES_PASSWORD`-avainta tarvita.

## 2. Sovellus ja Postgres

```bash
# Aseta ensin oma domain: deploy/k8s/base/ingress.yaml ja PUBLIC_URL tiedostossa base/config.yaml
kubectl apply -k deploy/k8s/overlays/vps-k3s     # tai overlays/cloud
```

API ja workerit käynnistyvät uudelleen, kunnes Temporal on asennettu (vaihe 3). Tietokantamigraatiot ajetaan käynnistyksessä; rinnakkaiset podit on suojattu advisory-lukolla.

## 3. Temporal

```bash
helm upgrade --install temporal temporal --repo https://go.temporal.io/helm-charts --version 1.8.0 \
  --namespace temporal --create-namespace -f deploy/temporal/values-vps.yaml --timeout 900s
```

Chart luo Temporalin tietokannat samaan Postgresiin, ajaa skeemat ja luo `default`-namespacen. Temporal UI:

```bash
kubectl -n temporal port-forward svc/temporal-web 8080:8080
```

## 4. GitOps (valinnainen)

`deploy/argocd/applications.yaml` määrittelee molemmat (Temporal + sovellus) Argo CD -sovelluksina. CI julkaisee kuvat `ghcr.io/taituo/pizza-server` ja `pizza-web` tageilla `latest` ja commitin SHA. Tuotannossa kiinnitä overlayn `images`-kohtaan SHA-tagi, jolloin jokainen julkaisu on Git-commit ja palautus on `git revert`.

## Varmuuskopiot (VPS)

Yksi Postgres on yksi vikaantumispiste. Vähintään päivittäinen `pg_dumpall` klusterin ulkopuolelle:

```bash
kubectl -n pizza exec postgres-0 -- pg_dumpall -U pizza | gzip > pizza-$(date +%F).sql.gz
```

## Mitä tässä ei vielä ole

- Verkkopolitiikat ja erilliset node-poolit agenteille (tulevat vaiheessa, jossa agentit lisätään).
- Canary-julkaisut (Argo Rollouts) ja workerien skaalaus Temporalin jonon pituudella (KEDA).
- Postgresin HA VPS-profiilissa.
