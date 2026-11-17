import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money, store } from '../api';
import type { LatLng, Proposal } from '../types';
import { MapView } from './MapView';

interface Props {
  proposal: Proposal;
  restaurant: LatLng & { name: string };
  deliveryRadiusKm: number;
}

/**
 * The agent's proposal, as the customer sees it. The agent can only suggest: the order is
 * created here, when the customer checks the details and confirms.
 */
export function ProposalCard({ proposal, restaurant, deliveryRadiusKm }: Props) {
  const navigate = useNavigate();
  const [name, setName] = useState(proposal.customerName ?? '');
  const [phone, setPhone] = useState(proposal.phone ?? '');
  const [address, setAddress] = useState(proposal.address ?? '');
  const [spot, setSpot] = useState<LatLng | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const delivery = proposal.fulfillment === 'delivery';

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (delivery && !spot) {
      setError('Mark the delivery location on the map.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const order = await api<{ id: string; accessToken: string }>(`/api/proposals/${proposal.id}/confirm`, {
        proposalToken: proposal.accessToken,
        body: { customerName: name, phone, ...(delivery ? { address, lat: spot!.lat, lng: spot!.lng } : {}) },
      });
      store('local').set('lastOrder', JSON.stringify({ id: order.id, token: order.accessToken }));
      navigate(`/order/${order.id}?token=${encodeURIComponent(order.accessToken)}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className="card proposal" onSubmit={confirm} aria-label="Order proposal">
      <p className="eyebrow">Your order, ready to confirm</p>
      <ul className="proposal-items">
        {proposal.items.map((item, i) => (
          <li key={i}>
            <span>
              {item.quantity} × {item.name}
              {item.size === 'large' && ' (large)'}
              {item.withoutNames && item.withoutNames.length > 0 && (
                <span className="muted small"> without: {item.withoutNames.join(', ').toLowerCase()}</span>
              )}
            </span>
            <span>{money(item.lineTotalCents ?? 0)}</span>
          </li>
        ))}
      </ul>
      <dl className="totals">
        {delivery && (
          <div>
            <dt>Delivery</dt>
            <dd>{money(proposal.deliveryFeeCents)}</dd>
          </div>
        )}
        <div className="grand">
          <dt>Total ({delivery ? 'delivery' : 'pickup'})</dt>
          <dd>{money(proposal.totalCents)}</dd>
        </div>
      </dl>

      <label className="field">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoComplete="name" />
      </label>
      <label className="field">
        Phone
        <input value={phone} onChange={(e) => setPhone(e.target.value)} required minLength={5} maxLength={30} type="tel" autoComplete="tel" />
      </label>
      {delivery && (
        <>
          <label className="field">
            Address and door code
            <input value={address} onChange={(e) => setAddress(e.target.value)} required minLength={3} maxLength={300} autoComplete="street-address" />
          </label>
          <p className="small muted">Tap the map at the delivery location so the driver can find you.</p>
          <MapView
            label="Choose the delivery location on the map"
            center={restaurant}
            radiusKm={deliveryRadiusKm}
            height={200}
            fit={false}
            onPick={setSpot}
            markers={[
              { id: 'r', kind: 'restaurant', label: restaurant.name, ...restaurant },
              ...(spot ? [{ id: 'c', kind: 'customer' as const, label: 'Delivery location', ...spot }] : []),
            ]}
          />
        </>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <button className="btn primary wide" type="submit" disabled={busy}>
        {busy ? 'Sending…' : 'Confirm and go to payment'}
      </button>
      <p className="small muted hint">Nothing is ordered or charged until you confirm.</p>
    </form>
  );
}
