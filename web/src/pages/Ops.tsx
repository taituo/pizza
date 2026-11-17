import { STATUS_LABEL } from '../api';
import { MapView, type MapMarker } from '../components/MapView';
import { minutesSince, StaffGate, useStaffOrders } from '../staff';
import type { OrderStatus } from '../types';

const FLOW: OrderStatus[] = ['awaiting_payment', 'paid', 'preparing', 'ready', 'out_for_delivery'];

export function Ops() {
  return (
    <StaffGate title="Tilannekuva">
      <OpsView />
    </StaffGate>
  );
}

/** Operaattorin näkymä: koko toimitusketju yhdellä silmäyksellä ja kaikki kuljetukset kartalla. */
function OpsView() {
  const { orders, restaurant, error, reload, act, actionError } = useStaffOrders();

  if (error && !orders) {
    return (
      <main className="page">
        <div className="notice error" role="alert">
          <p>Tilannekuvaa ei saatu ladattua. {error}</p>
          <button className="btn" onClick={reload}>
            Yritä uudelleen
          </button>
        </div>
      </main>
    );
  }
  if (!orders || !restaurant) return <main className="page muted">Ladataan tilannekuvaa…</main>;

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
        <h1>Tilannekuva</h1>
        <p className="muted">{orders.length} aktiivista tilausta</p>
      </header>
      {actionError && (
        <p className="notice error" role="alert">
          {actionError}
        </p>
      )}
      <ul className="pipeline" aria-label="Tilaukset vaiheittain">
        {FLOW.map((s) => (
          <li key={s}>
            <strong>{orders.filter((o) => o.status === s).length}</strong>
            <span>{STATUS_LABEL[s]}</span>
          </li>
        ))}
      </ul>

      <MapView label="Kaikki kuljetukset kartalla" center={restaurant} markers={markers} height={420} />

      <section className="card">
        <h2>Jumissa yli 15 min</h2>
        {slow.length === 0 ? (
          <p className="muted small">Kaikki etenee ajallaan.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Tilaus</th>
                <th>Vaihe</th>
                <th>Kesto</th>
                <th>Asiakas</th>
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
                        if (window.confirm(`Perutaanko tilaus #${o.id.slice(0, 6)}? Asiakkaan maksu palautetaan.`)) {
                          void act(`/api/staff/orders/${o.id}/cancel`);
                        }
                      }}
                    >
                      Peru ja hyvitä
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
