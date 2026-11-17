import { useEffect, useRef, useState } from 'react';
import { api, store } from '../api';
import { MapView, type MapMarker } from '../components/MapView';
import { StaffGate, useStaffOrders, useStaffToken } from '../staff';

const local = store('local');

export function Driver() {
  return (
    <StaffGate title="Kuljettaja">
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

  // Jaa puhelimen sijainti jokaiselle omalle kuljetukselle, enintään kerran kolmessa sekunnissa.
  useEffect(() => {
    if (!sharing || !mineIds) return;
    if (!('geolocation' in navigator)) {
      setGeoError('Tämä laite ei tue sijainnin jakamista.');
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
          }).catch(() => undefined); // seuraava sijainti korvaa epäonnistuneen
        }
      },
      (err) => {
        setGeoError(
          err.code === err.PERMISSION_DENIED
            ? 'Sijainnin jakaminen on estetty. Salli se selaimen asetuksista, niin asiakas näkee sinut kartalla.'
            : 'Sijaintia ei saatu. Yritetään uudelleen…',
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
        <h1>Kuljettaja</h1>
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
            Nimesi tai tunnuksesi
            <input value={nameInput} onChange={(e) => setNameInput(e.target.value)} required maxLength={60} autoFocus />
          </label>
          <button className="btn primary">Aloita vuoro</button>
        </form>
      </main>
    );
  }

  if (error && !orders) {
    return (
      <main className="page narrow">
        <div className="notice error" role="alert">
          <p>Kuljetuksia ei saatu ladattua. {error}</p>
          <button className="btn" onClick={reload}>
            Yritä uudelleen
          </button>
        </div>
      </main>
    );
  }
  if (!orders || !restaurant) return <main className="page narrow muted">Ladataan kuljetuksia…</main>;

  const markers: MapMarker[] = [{ id: 'r', kind: 'restaurant', label: restaurant.name, ...restaurant }];
  for (const o of [...mine, ...available]) {
    if (o.location) markers.push({ id: o.id, kind: 'customer', label: o.address ?? 'Toimituspaikka', ...o.location });
  }

  return (
    <main className="page narrow">
      <header className="board-head">
        <h1>Kuljetukset</h1>
        <p className="muted">
          {driverId} ·{' '}
          <button
            className="link"
            onClick={() => {
              local.set('driverId', null);
              setDriverId('');
            }}
          >
            vaihda
          </button>
        </p>
      </header>
      {(actionError || geoError) && (
        <p className="notice error" role="alert">
          {actionError ?? geoError}
        </p>
      )}

      <MapView label="Kuljetusten kohteet kartalla" center={restaurant} markers={markers} height={260} />

      <section>
        <h2>
          Omat kuljetukset <span className="count">{mine.length}</span>
        </h2>
        {mine.length === 0 && <p className="muted small">Ei kuljetuksia kesken.</p>}
        {mine.length > 0 && (
          <label className="toggle">
            <input type="checkbox" checked={sharing} onChange={(e) => setSharing(e.target.checked)} />
            <span>Jaa sijaintini asiakkaalle</span>
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
                Toimitettu
              </button>
            </div>
          </article>
        ))}
      </section>

      <section>
        <h2>
          Odottaa kuljettajaa <span className="count">{available.length}</span>
        </h2>
        {available.length === 0 && <p className="muted small">Ei valmiita tilauksia juuri nyt.</p>}
        {available.map((o) => (
          <article className="card ticket" key={o.id}>
            <div className="ticket-head">
              <strong>#{o.id.slice(0, 6)}</strong>
              <span>{o.items.reduce((n, i) => n + i.quantity, 0)} tuotetta</span>
            </div>
            <p>{o.address}</p>
            <div className="actions">
              <button className="btn primary" onClick={() => act(`/api/staff/orders/${o.id}/delivery`, { action: 'assign', driverId })}>
                Ota kuljetus
              </button>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
