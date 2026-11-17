import { useEffect, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { ProposalCard } from '../components/ProposalCard';
import type { LatLng, Proposal as ProposalData } from '../types';

type Loaded = ProposalData & {
  orderAccessToken: string | null;
  restaurant: LatLng & { name: string };
  deliveryRadiusKm: number;
};

/**
 * A proposal opened from a link. Agents on channels without a screen of their own (a phone call,
 * WhatsApp, email) send this link: the customer confirms and pays here.
 */
export function Proposal() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [proposal, setProposal] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Loaded>(`/api/proposals/${id}`, { proposalToken: token })
      .then(setProposal)
      .catch((e: ApiError) => setError(e.status === 404 ? 'This link is not valid. Check that it is complete.' : e.message));
  }, [id, token]);

  if (error) {
    return (
      <main className="page narrow">
        <p className="notice error" role="alert">
          {error}
        </p>
        <Link to="/">← Menu</Link>
      </main>
    );
  }
  if (!proposal) return <main className="page narrow muted">Loading your order…</main>;
  if (proposal.status === 'confirmed' && proposal.orderId && proposal.orderAccessToken) {
    return <Navigate replace to={`/order/${proposal.orderId}?token=${encodeURIComponent(proposal.orderAccessToken)}`} />;
  }
  if (proposal.status !== 'open') {
    return (
      <main className="page narrow">
        <h1>This order is no longer open</h1>
        <p className="muted">
          {proposal.status === 'expired' ? 'It was not confirmed in time.' : 'It was replaced by a newer one.'} Ask for a new one, or
          order from the menu.
        </p>
        <Link to="/">← Menu</Link>
      </main>
    );
  }
  return (
    <main className="page narrow">
      <h1>Confirm your order</h1>
      <ProposalCard proposal={proposal} restaurant={proposal.restaurant} deliveryRadiusKm={proposal.deliveryRadiusKm} />
    </main>
  );
}
