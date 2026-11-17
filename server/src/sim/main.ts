/**
 * Keittiö- ja kuljettajasimulaattori. Käyttää samaa henkilökunnan API:a kuin oikeat näkymät,
 * joten se on korvattavissa oikealla keittiöllä ja oikeilla kuljettajilla koskematta ketjuun.
 *
 * Tilaton: jokainen kierros päättelee tehtävänsä tilausten tilasta ja aikaleimoista,
 * joten simulaattorin voi tappaa ja käynnistää uudelleen milloin tahansa.
 */
import { envOr, sleep, StaffClient, type SimOrder } from './client';

const api = new StaffClient(envOr('API_URL', 'http://localhost:3000'), envOr('STAFF_TOKEN', 'dev-staff-token'));
const AUTOPAY = envOr('SIM_AUTOPAY', 'false') === 'true';
const ACCEPT_MS = Number(envOr('SIM_ACCEPT_MS', '3000'));
const PREP_MS = Number(envOr('SIM_PREP_MS', '10000'));
const DRIVE_MS = Number(envOr('SIM_DRIVE_MS', '30000'));
const PICKUP_MS = Number(envOr('SIM_PICKUP_MS', '8000'));
const TICK_MS = Number(envOr('SIM_TICK_MS', '1000'));
const REJECT_RATE = Number(envOr('SIM_KITCHEN_REJECT_RATE', '0'));
const DRIVER_PREFIX = 'sim-driver-';

async function act(order: SimOrder, restaurant: { lat: number; lng: number }): Promise<void> {
  const age = Date.now() - new Date(order.updatedAt).getTime();
  const base = `/api/staff/orders/${order.id}`;
  switch (order.status) {
    case 'awaiting_payment':
      if (AUTOPAY && order.payment?.status === 'pending') await api.request('POST', `/api/orders/${order.id}/pay`);
      break;
    case 'paid':
      if (age >= ACCEPT_MS) {
        const action = Math.random() < REJECT_RATE ? 'reject' : 'accept';
        await api.request('POST', `${base}/kitchen`, { action });
      }
      break;
    case 'preparing':
      if (age >= PREP_MS) await api.request('POST', `${base}/kitchen`, { action: 'ready' });
      break;
    case 'ready':
      if (order.fulfillment === 'delivery') {
        if (!order.driver) {
          const driverId = `${DRIVER_PREFIX}${1 + Math.floor(Math.random() * 5)}`;
          await api.request('POST', `${base}/delivery`, { action: 'assign', driverId });
        }
      } else if (age >= PICKUP_MS) {
        await api.request('POST', `${base}/delivery`, { action: 'handover' });
      }
      break;
    case 'out_for_delivery': {
      if (!order.driver?.id.startsWith(DRIVER_PREFIX) || !order.location) break; // oikea kuljettaja hoitaa
      const progress = Math.min(1, age / DRIVE_MS);
      if (progress >= 1) {
        await api.request('POST', `${base}/delivery`, { action: 'handover' });
      } else {
        // Lievä kaari suoran viivan sijaan, jotta reitti näyttää kartalla ajolta.
        const bend = Math.sin(progress * Math.PI) * 0.0015;
        await api.request('POST', `${base}/location`, {
          lat: restaurant.lat + (order.location.lat - restaurant.lat) * progress + bend,
          lng: restaurant.lng + (order.location.lng - restaurant.lng) * progress - bend,
        });
      }
      break;
    }
  }
}

async function main(): Promise<void> {
  console.log(`[sim] keittiö + kuljettajat → ${api.apiUrl} (autopay=${AUTOPAY})`);
  let running = true;
  process.on('SIGTERM', () => (running = false));
  process.on('SIGINT', () => (running = false));

  while (running) {
    try {
      const { orders, restaurant } = await api.orders();
      const results = await Promise.allSettled(orders.map((o) => act(o, restaurant)));
      for (const r of results) {
        // 409 = tila ehti muuttua kierrosten välissä; se on odotettua, ei virhe.
        if (r.status === 'rejected' && (r.reason as { status?: number }).status !== 409) {
          console.error(`[sim] ${(r.reason as Error).message}`);
        }
      }
    } catch (err) {
      console.error(`[sim] ${(err as Error).message}`);
    }
    await sleep(TICK_MS);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
