import { STATUS_LABEL } from '../api';
import { MapView, type MapMarker } from '../components/MapView';
import { minutesSince, StaffGate, useStaffOrders } from '../staff';
import type { OrderStatus } from '../types';

const FLOW: OrderStatus[] = ['awaiting_payment', 'paid', 'preparing', 'ready', 'out_for_delivery'];

export function Ops() {
  return (
    <StaffGate title="Overview">
      <OpsView />
    </StaffGate>
  );
}

/** Operator view: the whole fulfilment chain at a glance and every delivery on the map. */
function OpsView() {
  const { orders, restaurant, error, reload, act, actionError } = useStaffOrders();

  if (error && !orders) {
    return (
      <main className="page">
        <div className="notice error" role="alert">
          <p>Could not load the overview. {error}</p>
          <button className="btn" onClick={reload}>
            Try again
          </button>
        </div>
      </main>
    );
  }
  if (!orders || !restaurant) return <main className="page muted">Loading the overview…</main>;

  const markers: MapMarker[] = [{ id: 'r', kind: 'restaurant', label: restaurant.name, ...restaurant }];
  for (const o of orders) {
    if (o.status === 'out_for_delivery' && o.driver?.location) {
      markers.push({ id: `d-${o.id}`, kind: 'driver', label: `${o.driver.id} → #${o.id.slice(0, 6)}`, ...o.driver.location });
    }
    if (o.location && ['ready', 'out_for_delivery'].includes(o.status)) {
      markers.push({ id: `c-${o.id}`, kind: 'customer', label: `#${o.id.slice(0, 6)} ${o.address ?? ''}`, ...o.location });
    }
  }
  const slow = orders.filter((o) => o.status !== 'awaiting_payment' && minutesSince(o.updatedAt) >= 15);

  return (
    <main className="page">
      <header className="board-head">
        <h1>Overview</h1>
        <p className="muted">{orders.length} active orders</p>
      </header>
      {actionError && (
        <p className="notice error" role="alert">
          {actionError}
        </p>
      )}
      <ul className="pipeline" aria-label="Orders by stage">
        {FLOW.map((s) => (
          <li key={s}>
            <strong>{orders.filter((o) => o.status === s).length}</strong>
            <span>{STATUS_LABEL[s]}</span>
          </li>
        ))}
      </ul>

      <MapView label="All deliveries on the map" center={restaurant} markers={markers} height={420} />

      <section className="card">
        <h2>Stuck for over 15 min</h2>
        {slow.length === 0 ? (
          <p className="muted small">Everything is on schedule.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Stage</th>
                <th>Duration</th>
                <th>Customer</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {slow.map((o) => (
                <tr key={o.id}>
                  <td>#{o.id.slice(0, 6)}</td>
                  <td>{STATUS_LABEL[o.status]}</td>
                  <td>{minutesSince(o.updatedAt)} min</td>
                  <td>
                    {o.customerName}, <a href={`tel:${o.phone}`}>{o.phone}</a>
                  </td>
                  <td>
                    <button
                      className="btn quiet small"
                      onClick={() => {
                        if (window.confirm(`Cancel order #${o.id.slice(0, 6)}? The customer's payment will be refunded.`)) {
                          void act(`/api/staff/orders/${o.id}/cancel`);
                        }
                      }}
                    >
                      Cancel and refund
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
