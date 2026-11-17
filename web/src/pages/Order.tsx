import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, CANCEL_LABEL, money, time, useEvents } from '../api';
import { MapView, type MapMarker } from '../components/MapView';
import type { Order as OrderT, OrderStatus } from '../types';

const STEPS: { status: OrderStatus; delivery: string; pickup: string | null }[] = [
  { status: 'awaiting_payment', delivery: 'Maksu', pickup: 'Maksu' },
  { status: 'paid', delivery: 'Keittiö vahvistaa', pickup: 'Keittiö vahvistaa' },
  { status: 'preparing', delivery: 'Valmistuksessa', pickup: 'Valmistuksessa' },
  { status: 'ready', delivery: 'Odottaa kuljettajaa', pickup: 'Noudettavissa' },
  { status: 'out_for_delivery', delivery: 'Matkalla', pickup: null },
  { status: 'completed', delivery: 'Perillä', pickup: 'Noudettu' },
];

const HEADLINE: Record<OrderStatus, (o: OrderT) => string> = {
  created: () => 'Tarkistamme tilaustasi…',
  awaiting_payment: () => 'Tilaus odottaa maksuasi',
  paid: () => 'Maksu saatu. Keittiö vahvistaa tilauksen hetken kuluttua.',
  preparing: () => 'Pizzasi on uunissa',
  ready: (o) => (o.fulfillment === 'pickup' ? 'Tilauksesi on valmis noudettavaksi' : 'Valmis! Odotetaan kuljettajaa.'),
  out_for_delivery: () => 'Kuljettaja on matkalla luoksesi',
  completed: (o) => (o.fulfillment === 'pickup' ? 'Noudettu. Hyvää ruokahalua!' : 'Toimitettu. Hyvää ruokahalua!'),
  cancelled: () => 'Tilaus on peruttu',
};

export function Order() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [order, setOrder] = useState<OrderT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'pay' | 'cancel' | null>(null);

  const load = useCallback(() => {
    api<OrderT>(`/api/orders/${id}`, { orderToken: token })
      .then((o) => {
        setOrder(o);
        setError(null);
      })
      .catch((e: ApiError) =>
        setError(e.status === 404 ? 'Tilausta ei löytynyt. Tarkista, että linkki on kokonainen.' : e.message),
      );
  }, [id, token]);
  useEffect(load, [load]);

  useEvents(
    order ? `/api/orders/${id}/events?token=${encodeURIComponent(token)}` : null,
    (e) => {
      if (e.type === 'location' && e.lat !== undefined && e.lng !== undefined) {
        const location = { lat: e.lat, lng: e.lng };
        setOrder((o) => (o && o.driver ? { ...o, driver: { ...o.driver, location } } : o));
      } else {
        load();
      }
    },
    load,
  );

  const act = async (kind: 'pay' | 'cancel') => {
    setBusy(kind);
    setActionError(null);
    try {
      await api(`/api/orders/${id}/${kind}`, { method: 'POST', orderToken: token });
      // Tila päivittyy tapahtumavirrasta, kun tilausketju on käsitellyt pyynnön.
    } catch (e) {
      setActionError((e as Error).message);
      load();
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <main className="page narrow">
        <div className="notice error" role="alert">
          <p>{error}</p>
          <button className="btn" onClick={load}>
            Yritä uudelleen
          </button>
        </div>
        <Link to="/">← Takaisin ruokalistalle</Link>
      </main>
    );
  }
  if (!order) return <main className="page narrow muted">Haetaan tilausta…</main>;

  const steps = STEPS.filter((s) => order.fulfillment === 'delivery' || s.pickup !== null);
  const current = steps.findIndex((s) => s.status === order.status);
  const cancelled = order.status === 'cancelled';
  const canCancel = ['created', 'awaiting_payment', 'paid'].includes(order.status);
  const refunded = order.payment?.status === 'refunded';

  const markers: MapMarker[] = [];
  if (order.restaurant) markers.push({ id: 'r', kind: 'restaurant', label: order.restaurant.name, ...order.restaurant });
  if (order.location) markers.push({ id: 'c', kind: 'customer', label: 'Toimituspaikka', ...order.location });
  if (order.status === 'out_for_delivery' && order.driver?.location) {
    markers.push({ id: 'd', kind: 'driver', label: 'Kuljettaja', ...order.driver.location });
  }

  return (
    <main className="page narrow">
      <Link to="/">← Ruokalista</Link>
      <header className="order-head">
        <p className="eyebrow">Tilaus {order.id.slice(0, 8)}</p>
        <h1 aria-live="polite">{HEADLINE[order.status](order)}</h1>
        {cancelled && (
          <p className="notice">
            {CANCEL_LABEL[order.cancelReason ?? ''] ?? 'Tilaus peruttiin.'}
            {refunded && ' Maksusi on palautettu.'}
          </p>
        )}
      </header>

      {!cancelled && (
        <ol className="steps" aria-label="Tilauksen eteneminen">
          {steps.map((s, i) => (
            <li key={s.status} className={i < current ? 'done' : i === current ? 'now' : ''} aria-current={i === current ? 'step' : undefined}>
              <span className="dot" />
              {order.fulfillment === 'delivery' ? s.delivery : s.pickup}
            </li>
          ))}
        </ol>
      )}

      {order.status === 'awaiting_payment' && order.totalCents !== null && (
        <section className="card pay">
          <div>
            <strong>Maksettavaa {money(order.totalCents)}</strong>
            <p className="small muted">Tilaus raukeaa itsestään, jos sitä ei makseta 15 minuutissa.</p>
          </div>
          {order.payment?.provider === 'stripe' && order.payment.checkoutUrl ? (
            <a className="btn primary" href={order.payment.checkoutUrl}>
              Siirry maksamaan
            </a>
          ) : (
            <button className="btn primary" onClick={() => act('pay')} disabled={busy !== null}>
              {busy === 'pay' ? 'Maksetaan…' : 'Maksa (testimaksu)'}
            </button>
          )}
        </section>
      )}
      {actionError && (
        <p className="notice error" role="alert">
          {actionError}
        </p>
      )}

      {order.fulfillment === 'delivery' && markers.length > 0 && !cancelled && (
        <MapView label="Toimituksen seuranta kartalla" center={markers[0]!} markers={markers} height={340} />
      )}

      <section className="card">
        <h2>Tilauksen sisältö</h2>
        <ul className="cart-lines">
          {order.items.map((item, i) => (
            <li key={i}>
              <div>
                <strong>
                  {item.quantity} × {item.name ?? item.productId}
                  {item.size === 'large' && ' (iso)'}
                </strong>
                {item.without.length > 0 && <span className="muted small">ilman: {(item.withoutNames ?? item.without).join(', ').toLowerCase()}</span>}
              </div>
              {item.lineTotalCents !== undefined && <span className="price">{money(item.lineTotalCents)}</span>}
            </li>
          ))}
        </ul>
        <dl className="totals">
          {order.deliveryFeeCents ? (
            <div>
              <dt>Kotiinkuljetus</dt>
              <dd>{money(order.deliveryFeeCents)}</dd>
            </div>
          ) : null}
          {order.totalCents !== null && (
            <div className="grand">
              <dt>Yhteensä</dt>
              <dd>{money(order.totalCents)}</dd>
            </div>
          )}
        </dl>
        <p className="small muted">
          {order.fulfillment === 'delivery' ? `Toimitus: ${order.address}` : `Nouto: ${order.restaurant?.name ?? 'ravintola'}`} · tilattu{' '}
          {time(order.createdAt)}
        </p>
        {canCancel && (
          <button className="btn quiet" onClick={() => act('cancel')} disabled={busy !== null}>
            {busy === 'cancel' ? 'Perutaan…' : 'Peru tilaus'}
          </button>
        )}
      </section>
    </main>
  );
}
