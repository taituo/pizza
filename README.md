# Agent-Native Commerce — Golden Sample 2026

Pizzakauppa, jonka tilaukset kulkevat pitkäkestoisina, deterministisinä Temporal-ketjuina Kubernetesissa. Tämä repo sisältää **vaiheen 1: toimiva kauppa päästä päähän**. Agentit, puhelu- ja viestikanavat sekä kehitysagentit rakennetaan tämän päälle (ks. [Tiekartta](#tiekartta)).

```
 Asiakas (web)     Keittiö     Kuljettaja     Tilannekuva        ← reaktiivinen UI (React, SSE)
       └──────────────┴────────────┴──────────────┘
                          │
                     Ohut API (Fastify)                          ← validointi, tunnistus, signaalit
                    ┌─────┴──────────────┐
                    │                    │
          Temporal: tilausketju     PostgreSQL                   ← yksi kanta: tilaukset, varasto,
     validointi → varasto → maksu      │  ▲                        maksut, tapahtumat, BI-näkymät
     → keittiö → toimitus → valmis     │  │ LISTEN/NOTIFY → SSE
                    │                  │  │
              Workerit (N kpl) ────────┘  │
              activityt: idempotentit ────┘
```

## Mitä tässä on

- **Tilausketju** ([`server/src/workflows/order.ts`](server/src/workflows/order.ts)): yksi Temporal-workflow per tilaus. Odottaa maksua, keittiötä ja kuljettajaa minuutteja tai tunteja varaamatta yhtään prosessia. Aikakatkaisut ja kompensaatiot (maksun hyvitys, varaston palautus) ovat osa ketjua.
- **Ei kaksoisveloituksia**: jokainen sivuvaikutus on idempotentti tilauksen suhteen (yksi maksurivi ja yksi varastovaraus per tilaus, tilauskohtaiset idempotency-avaimet). Workerin voi tappaa kesken ketjun.
- **Maksut**: yhteinen rajapinta, takana simuloitu maksupalvelu (oletus) tai Stripe Checkout allekirjoitetuilla webhookeilla. Hinnan laskee aina palvelin.
- **Varasto**: raaka-ainetasolla, varataan tilaukselle ja palautetaan, jos tilaus peruuntuu ennen valmistusta.
- **Toimitusseuranta kartalla**: kuljettaja jakaa sijaintinsa puhelimesta, asiakas näkee sen reaaliajassa. Sijaintivirta ei kulje ketjun läpi.
- **Näkymät**: kauppa ja tilauksen seuranta (`/`), keittiö (`/kitchen`), kuljettaja (`/driver`), operaattorin tilannekuva (`/ops`).
- **BI**: kaikki liiketoimintatapahtumat taulussa `order_events`; valmiit näkymät (`bi_sales_daily`, `bi_stage_durations`, `bi_cancellations`, `bi_product_sales`) samassa Postgresissa. Metabase käynnistyy profiililla `bi`.
- **Kubernetes**: Kustomize-overlayt halvalle VPS:lle (k3s) ja pilveen (EKS/GKE), Temporal Helm-chartilla samaan Postgresiin. Ks. [`deploy/README.md`](deploy/README.md).
- **CI/CD**: tyyppitarkistus, testit, manifestien renderöinti ja koko ketjun ajo Docker Composella niin, että workerit tapetaan kesken kuorman. Kuvat GHCR:ään, Argo CD -määrittelyt mukana.

## Käynnistys

Vaatii Dockerin.

```bash
docker compose --profile sim up --build
```

| | |
|---|---|
| Kauppa | http://localhost:8080 |
| Keittiö, kuljettaja, tilannekuva | http://localhost:8080/kitchen, `/driver`, `/ops` (tunniste `dev-staff-token`) |
| Temporal UI | http://localhost:8233 |

Profiili `sim` käynnistää keittiö- ja kuljettajasimulaattorin: tee tilaus, paina *Maksa (testimaksu)* ja seuraa, kun tilaus etenee ja kuljettaja liikkuu kartalla. Ilman profiilia hoidat keittiön ja kuljetuksen itse henkilökunnan näkymistä.

BI: `docker compose --profile bi up`, avaa http://localhost:3001 ja lisää tietokannaksi PostgreSQL `postgres:5432`, kanta, käyttäjä ja salasana `pizza`.

### Kehitys ilman kontteja sovellukselle

```bash
docker compose up postgres temporal      # vain riippuvuudet
npm install
npm run dev:api                          # http://localhost:3000
npm run dev:worker
npm run dev:web                          # http://localhost:5173
npm run sim                              # valinnainen: keittiö + kuljettajat
```

### Testit

```bash
npm test                                                             # yksikkö- ja workflow-testit
TEST_DATABASE_URL=postgres://pizza:pizza@localhost:5432/pizza npm test   # + activityt ja API oikeaa Postgresia vasten
```

Workflow-testit ajetaan oikeaa Temporal-kehityspalvelinta vasten (ladataan automaattisesti; `SKIP_TEMPORAL_TESTS=1` ohittaa).

## Demot

**Kaaos**: tee tilaus, tapa workerit ja käynnistä ne uudelleen. Ketju jatkuu siitä, mihin jäi.

```bash
docker compose kill -s SIGKILL worker && docker compose up -d worker
```

**Häiriöinen maksupalvelu**: `SIM_PAYMENT_FAIL_RATE=0.3 docker compose --profile sim up`. Temporal UI:ssa näkyvät uudelleenyritykset, tietokannassa täsmälleen yksi maksu per tilaus.

**Kuorma**:

```bash
npm run load -- --orders 10000 --concurrency 50 --restock            # 10 000 ketjua odottamaan maksua
npm run load -- --orders 500 --restock --pay --wait                  # ketjut loppuun asti (simulaattorin kanssa)
```

Ensimmäinen komento on "10 000 samanaikaista ketjua" -tilanne: ketjut odottavat maksua 15 minuuttia ja raukeavat sitten hallitusti, varasto palautuu. 10 000 ketjun läpimenoa ei ole vielä mitattu oikealla klusterilla; se on mittaus, ei arkkitehtuurin lupaus.

## Rakenne

```
server/                 yksi paketti, kolme käynnistyskomentoa (api, worker, sim)
  src/workflows/        tilausketju (deterministinen koodi)
  src/activities/       sivuvaikutukset: hinnoittelu, varasto, maksut, tilasiirtymät
  src/payments/         maksurajapinta: sim + Stripe
  src/api/              ohut API ja SSE-väylä
  src/runtime.ts        ainoa kohta, jossa API koskee Temporaliin
  src/sim/              keittiö- ja kuljettajasimulaattori, kuormageneraattori
  migrations/           skeema, ruokalista, BI-näkymät
web/                    React-käyttöliittymä
deploy/                 Kubernetes (Kustomize), Temporal (Helm values), Argo CD
```

Periaatteet, jotka kantavat seuraaviin vaiheisiin:

1. **Kanava ei määritä liiketoimintalogiikkaa.** Web-UI on vain yksi API:n asiakas. Agentti, puhelu tai WhatsApp käyttää samaa `POST /api/orders` -rajapintaa (kenttä `channel`) ja samaa ketjua.
2. **Agentti ehdottaa, ketju päättää.** Hinta, maksu ja tilauksen tila eivät ole koskaan kutsujan käsissä. Väärässä vaiheessa saapunut signaali ei tee mitään.
3. **API ei tunne Temporalia** tiedoston `runtime.ts` ulkopuolella, eikä UI tunne sitä lainkaan.

## Rajaukset tässä vaiheessa

- Ei asiakastilejä: tilausta seurataan salaisella linkillä. Henkilökunnalla on yksi jaettu tunniste, ei käyttäjäkohtaisia oikeuksia.
- Stripe-toteutus noudattaa Stripen rajapintoja, mutta sitä ei ole ajettu oikeilla avaimilla. Aja se testitilassa ennen live-käyttöä.
- Toimituspaikka valitaan kartalta; osoitehakua (geokoodausta) ei ole.
- API:ssa ei ole pyyntörajoitusta (rate limit). Lisää se ingressiin tai API:in ennen julkista käyttöä.
- Karttapohja tulee OpenStreetMapin julkisilta palvelimilta, jotka on tarkoitettu kevyeen käyttöön. Tuotannossa käytä omaa tai kaupallista karttapalvelua.
- Sijainti- ja asiakastiedot ovat henkilötietoja: säilytysajat ja tietosuojaseloste puuttuvat.

## Tiekartta

| Vaihe | Sisältö |
|---|---|
| **1 (tämä)** | Kauppa, tilausketju, maksut, varasto, karttaseuranta, BI-näkymät, Kubernetes, CI |
| 2 | Tilausagentti (Deep Agents Temporaliin käärittynä, middleware rajaa työkalut) ja chat-käyttöliittymä |
| 3 | Kanavat: puhelu (ElevenLabs + Twilio), WhatsApp, sähköposti yhteisen kanava-adapterin kautta; asiakkaan tunnistus |
| 4 | Kehitysagentit samassa klusterissa omassa node-poolissa: GitHub-issue → PR → CI → canary; BI:stä nousevat parannusehdotukset |
