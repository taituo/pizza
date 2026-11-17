import { useEffect, useRef, useState } from 'react';
import { api, store } from '../api';
import { MapView, type MapMarker } from '../components/MapView';
import { StaffGate, useStaffOrders, useStaffToken } from '../staff';

const local = store('local');

export function Driver() {
  return (
    <StaffGate title="Driver">
      <DriverView />
    </StaffGate>
  );
}

function DriverView() {
  const token = useStaffToken();
  const { orders, restaurant, error, reload, act, actionError } = useStaffOrders();
  const [driverId, setDriverId] = useState(() => local.get('driverId') ?? '');
  const [nameInput, setNameInput] = useState('');
  const [sharing, setSharing] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  const mine = orders?.filter((o) => o.status === 'out_for_delivery' && o.driver?.id === driverId) ?? [];
  const available = orders?.filter((o) => o.status === 'ready' && o.fulfillment === 'delivery' && !o.driver) ?? [];
  const mineIds = mine.map((o) => o.id).join(',');
  const lastSent = useRef(0);

  // Share the phone's location for each of my deliveries, at most once every three seconds.
  useEffect(() => {
    if (!sharing || !mineIds) return;
    if (!('geolocation' in navigator)) {
      setGeoError('This device does not support location sharing.');
      setSharing(false);
      return;
    }
    const ids = mineIds.split(',');
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        setGeoError(null);
        if (Date.now() - lastSent.current < 3000) return;
        lastSent.current = Date.now();
        for (const id of ids) {
          api(`/api/staff/orders/${id}/location`, {
            body: { lat: pos.coords.latitude, lng: pos.coords.longitude },
            staffToken: token,
          }).catch(() => undefined); // the next location replaces a failed one
        }
      },
      (err) => {
        setGeoError(
          err.code === err.PERMISSION_DENIED
            ? 'Location sharing is blocked. Allow it in the browser settings so the customer can see you on the map.'
            : 'Could not get a location. Retrying…',
        );
        if (err.code === err.PERMISSION_DENIED) setSharing(false);
      },
      { enableHighAccuracy: true, maximumAge: 2000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [sharing, mineIds, token]);

  if (!driverId) {
    return (
      <main className="page narrow">
        <h1>Driver</h1>
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            const id = nameInput.trim();
            if (!id) return;
            local.set('driverId', id);
            setDriverId(id);
          }}
        >
          <label className="field">
            Your name or ID
            <input value={nameInput} onChange={(e) => setNameInput(e.target.value)} required maxLength={60} autoFocus />
          </label>
          <button className="btn primary">Start shift</button>
        </form>
      </main>
    );
  }

  if (error && !orders) {
    return (
      <main className="page narrow">
        <div className="notice error" role="alert">
          <p>Could not load deliveries. {error}</p>
          <button className="btn" onClick={reload}>
            Try again
          </button>
        </div>
      </main>
    );
  }
  if (!orders || !restaurant) return <main className="page narrow muted">Loading deliveries…</main>;

  const markers: MapMarker[] = [{ id: 'r', kind: 'restaurant', label: restaurant.name, ...restaurant }];
  for (const o of [...mine, ...available]) {
    if (o.location) markers.push({ id: o.id, kind: 'customer', label: o.address ?? 'Delivery location', ...o.location });
  }

  return (
    <main className="page narrow">
      <header className="board-head">
        <h1>Deliveries</h1>
        <p className="muted">
          {driverId} ·{' '}
          <button
            className="link"
            onClick={() => {
              local.set('driverId', null);
              setDriverId('');
            }}
          >
            change
          </button>
        </p>
      </header>
      {(actionError || geoError) && (
        <p className="notice error" role="alert">
          {actionError ?? geoError}
        </p>
      )}

      <MapView label="Delivery destinations on the map" center={restaurant} markers={markers} height={260} />

      <section>
        <h2>
          My deliveries <span className="count">{mine.length}</span>
        </h2>
        {mine.length === 0 && <p className="muted small">No deliveries in progress.</p>}
        {mine.length > 0 && (
          <label className="toggle">
            <input type="checkbox" checked={sharing} onChange={(e) => setSharing(e.target.checked)} />
            <span>Share my location with the customer</span>
          </label>
        )}
        {mine.map((o) => (
          <article className="card ticket" key={o.id}>
            <div className="ticket-head">
              <strong>#{o.id.slice(0, 6)}</strong>
              <span>{o.customerName}</span>
              <a href={`tel:${o.phone}`}>{o.phone}</a>
            </div>
            <p>{o.address}</p>
            <div className="actions">
              <button className="btn primary" onClick={() => act(`/api/staff/orders/${o.id}/delivery`, { action: 'handover' })}>
                Delivered
              </button>
            </div>
          </article>
        ))}
      </section>

      <section>
        <h2>
          Waiting for a driver <span className="count">{available.length}</span>
        </h2>
        {available.length === 0 && <p className="muted small">No orders ready right now.</p>}
        {available.map((o) => (
          <article className="card ticket" key={o.id}>
            <div className="ticket-head">
              <strong>#{o.id.slice(0, 6)}</strong>
              <span>{o.items.reduce((n, i) => n + i.quantity, 0)} items</span>
            </div>
            <p>{o.address}</p>
            <div className="actions">
              <button className="btn primary" onClick={() => act(`/api/staff/orders/${o.id}/delivery`, { action: 'assign', driverId })}>
                Take delivery
              </button>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
