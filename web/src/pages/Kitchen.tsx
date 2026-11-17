import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { minutesSince, StaffGate, useStaffOrders, useStaffToken } from '../staff';
import type { Order } from '../types';

interface Ingredient {
  id: string;
  name: string;
  stock: number;
}

export function Kitchen() {
  return (
    <StaffGate title="Kitchen">
      <KitchenBoard />
    </StaffGate>
  );
}

function KitchenBoard() {
  const { orders, error, reload, act, actionError } = useStaffOrders();

  if (error && !orders) {
    return (
      <main className="page">
        <div className="notice error" role="alert">
          <p>Could not load orders. {error}</p>
          <button className="btn" onClick={reload}>
            Try again
          </button>
        </div>
      </main>
    );
  }
  if (!orders) return <main className="page muted">Loading orders…</main>;

  const incoming = orders.filter((o) => o.status === 'paid');
  const preparing = orders.filter((o) => o.status === 'preparing');
  const ready = orders.filter((o) => o.status === 'ready' || o.status === 'out_for_delivery');
  const unpaid = orders.filter((o) => o.status === 'awaiting_payment' || o.status === 'created').length;

  return (
    <main className="page">
      <header className="board-head">
        <h1>Kitchen</h1>
        <p className="muted">
          {orders.length - unpaid} in progress · {unpaid} awaiting customer payment
        </p>
      </header>
      {actionError && (
        <p className="notice error" role="alert">
          {actionError}
        </p>
      )}
      <div className="board">
        <Column title="New" empty="No new orders." orders={incoming}>
          {(o) => (
            <>
              <button className="btn primary" onClick={() => act(`/api/staff/orders/${o.id}/kitchen`, { action: 'accept' })}>
                Accept
              </button>
              <button className="btn quiet" onClick={() => act(`/api/staff/orders/${o.id}/kitchen`, { action: 'reject' })}>
                Reject
              </button>
            </>
          )}
        </Column>
        <Column title="Preparing" empty="The oven is empty." orders={preparing}>
          {(o) => (
            <button className="btn primary" onClick={() => act(`/api/staff/orders/${o.id}/kitchen`, { action: 'ready' })}>
              Ready
            </button>
          )}
        </Column>
        <Column title="Ready" empty="Nothing waiting for handover." orders={ready}>
          {(o) =>
            o.fulfillment === 'pickup' ? (
              <button className="btn primary" onClick={() => act(`/api/staff/orders/${o.id}/delivery`, { action: 'handover' })}>
                Handed to customer
              </button>
            ) : (
              <span className="small muted">
                {o.status === 'out_for_delivery' ? `Out for delivery (${o.driver?.id})` : 'Waiting for a driver'}
              </span>
            )
          }
        </Column>
      </div>
      <Stock />
    </main>
  );
}

function Column({
  title,
  empty,
  orders,
  children,
}: {
  title: string;
  empty: string;
  orders: Order[];
  children: (o: Order) => ReactNode;
}) {
  return (
    <section className="column" aria-label={title}>
      <h2>
        {title} <span className="count">{orders.length}</span>
      </h2>
      {orders.length === 0 && <p className="muted small">{empty}</p>}
      {orders.map((o) => (
        <article className="card ticket" key={o.id}>
          <div className="ticket-head">
            <strong>#{o.id.slice(0, 6)}</strong>
            <span className={`tag ${o.fulfillment}`}>{o.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}</span>
            <span className="small muted">{minutesSince(o.updatedAt)} min</span>
          </div>
          <ul className="ticket-items">
            {o.items.map((item, i) => (
              <li key={i}>
                <strong>{item.quantity} ×</strong> {item.name ?? item.productId}
                {item.size === 'large' && ' (large)'}
                {item.without.length > 0 && <em> – without: {(item.withoutNames ?? item.without).join(', ')}</em>}
              </li>
            ))}
          </ul>
          <p className="small muted">{o.customerName}</p>
          <div className="actions">{children(o)}</div>
        </article>
      ))}
    </section>
  );
}

function Stock() {
  const token = useStaffToken();
  const [items, setItems] = useState<Ingredient[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ ingredients: Ingredient[] }>('/api/staff/ingredients', { staffToken: token })
      .then((d) => {
        setItems(d.ingredients);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [token]);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 15_000);
    return () => window.clearInterval(t);
  }, [load]);

  const restock = async (id: string) => {
    try {
      await api(`/api/staff/ingredients/${id}/restock`, { body: { amount: 100 }, staffToken: token });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="card stock">
      <h2>Stock</h2>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {!items ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul>
          {items.map((i) => (
            <li key={i.id} className={i.stock < 20 ? 'low' : ''}>
              <span>{i.name}</span>
              <strong>{i.stock}</strong>
              <button className="btn quiet small" onClick={() => restock(i.id)} aria-label={`Add 100: ${i.name}`}>
                +100
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
