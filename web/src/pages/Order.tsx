import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, CANCEL_LABEL, money, time, useEvents } from '../api';
import { MapView, type MapMarker } from '../components/MapView';
import type { Order as OrderT, OrderStatus } from '../types';

const STEPS: { status: OrderStatus; delivery: string; pickup: string | null }[] = [
  { status: 'awaiting_payment', delivery: 'Payment', pickup: 'Payment' },
  { status: 'paid', delivery: 'Kitchen confirms', pickup: 'Kitchen confirms' },
  { status: 'preparing', delivery: 'Preparing', pickup: 'Preparing' },
  { status: 'ready', delivery: 'Waiting for a driver', pickup: 'Ready for pickup' },
  { status: 'out_for_delivery', delivery: 'On the way', pickup: null },
  { status: 'completed', delivery: 'Delivered', pickup: 'Picked up' },
];

const HEADLINE: Record<OrderStatus, (o: OrderT) => string> = {
  created: () => 'Checking your order…',
  awaiting_payment: () => 'Your order is waiting for payment',
  paid: () => 'Payment received. The kitchen will confirm your order shortly.',
  preparing: () => 'Your pizza is in the oven',
  ready: (o) => (o.fulfillment === 'pickup' ? 'Your order is ready for pickup' : 'Ready! Waiting for a driver.'),
  out_for_delivery: () => 'The driver is on the way to you',
  completed: (o) => (o.fulfillment === 'pickup' ? 'Picked up. Enjoy your meal!' : 'Delivered. Enjoy your meal!'),
  cancelled: () => 'The order has been cancelled',
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
        setError(e.status === 404 ? 'Order not found. Check that the link is complete.' : e.message),
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
      // The status updates from the event stream once the order workflow has processed the request.
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
            Try again
          </button>
        </div>
        <Link to="/">← Back to the menu</Link>
      </main>
    );
  }
  if (!order) return <main className="page narrow muted">Loading order…</main>;

  const steps = STEPS.filter((s) => order.fulfillment === 'delivery' || s.pickup !== null);
  const current = steps.findIndex((s) => s.status === order.status);
  const cancelled = order.status === 'cancelled';
  const canCancel = ['created', 'awaiting_payment', 'paid'].includes(order.status);
  const refunded = order.payment?.status === 'refunded';

  const markers: MapMarker[] = [];
  if (order.restaurant) markers.push({ id: 'r', kind: 'restaurant', label: order.restaurant.name, ...order.restaurant });
  if (order.location) markers.push({ id: 'c', kind: 'customer', label: 'Delivery location', ...order.location });
  if (order.status === 'out_for_delivery' && order.driver?.location) {
    markers.push({ id: 'd', kind: 'driver', label: 'Driver', ...order.driver.location });
  }

  return (
    <main className="page narrow">
      <Link to="/">← Menu</Link>
      <header className="order-head">
        <p className="eyebrow">Order {order.id.slice(0, 8)}</p>
        <h1 aria-live="polite">{HEADLINE[order.status](order)}</h1>
        {cancelled && (
          <p className="notice">
            {CANCEL_LABEL[order.cancelReason ?? ''] ?? 'The order was cancelled.'}
            {refunded && ' Your payment has been refunded.'}
          </p>
        )}
      </header>

      {!cancelled && (
        <ol className="steps" aria-label="Order progress">
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
            <strong>Amount due {money(order.totalCents)}</strong>
            <p className="small muted">The order expires on its own if it is not paid within 15 minutes.</p>
          </div>
          {order.payment?.provider === 'stripe' && order.payment.checkoutUrl ? (
            <a className="btn primary" href={order.payment.checkoutUrl}>
              Go to payment
            </a>
          ) : (
            <button className="btn primary" onClick={() => act('pay')} disabled={busy !== null}>
              {busy === 'pay' ? 'Paying…' : 'Pay (test payment)'}
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
        <MapView label="Delivery tracking on the map" center={markers[0]!} markers={markers} height={340} />
      )}

      <section className="card">
        <h2>Order contents</h2>
        <ul className="cart-lines">
          {order.items.map((item, i) => (
            <li key={i}>
              <div>
                <strong>
                  {item.quantity} × {item.name ?? item.productId}
                  {item.size === 'large' && ' (large)'}
                </strong>
                {item.without.length > 0 && <span className="muted small">without: {(item.withoutNames ?? item.without).join(', ').toLowerCase()}</span>}
              </div>
              {item.lineTotalCents !== undefined && <span className="price">{money(item.lineTotalCents)}</span>}
            </li>
          ))}
        </ul>
        <dl className="totals">
          {order.deliveryFeeCents ? (
            <div>
              <dt>Delivery</dt>
              <dd>{money(order.deliveryFeeCents)}</dd>
            </div>
          ) : null}
          {order.totalCents !== null && (
            <div className="grand">
              <dt>Total</dt>
              <dd>{money(order.totalCents)}</dd>
            </div>
          )}
        </dl>
        <p className="small muted">
          {order.fulfillment === 'delivery' ? `Delivery: ${order.address}` : `Pickup: ${order.restaurant?.name ?? 'restaurant'}`} · ordered{' '}
          {time(order.createdAt)}
        </p>
        {canCancel && (
          <button className="btn quiet" onClick={() => act('cancel')} disabled={busy !== null}>
            {busy === 'cancel' ? 'Cancelling…' : 'Cancel order'}
          </button>
        )}
      </section>
    </main>
  );
}
