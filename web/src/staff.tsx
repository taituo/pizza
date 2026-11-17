import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, store, useEvents } from './api';
import type { LatLng, Order } from './types';

const session = store('session');
const StaffContext = createContext<string>('');
export const useStaffToken = (): string => useContext(StaffContext);

/** Henkilökunnan näkymät vaativat tunnisteen. Se säilyy vain tämän välilehden ajan. */
export function StaffGate({ title, children }: { title: string; children: ReactNode }) {
  const [token, setToken] = useState(() => session.get('staffToken') ?? '');
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setChecking(true);
    setError(null);
    try {
      await api('/api/staff/stats', { staffToken: input });
      session.set('staffToken', input);
      setToken(input);
    } catch (err) {
      setError((err as ApiError).status === 401 ? 'Tunniste ei kelpaa.' : (err as Error).message);
    } finally {
      setChecking(false);
    }
  };

  if (!token) {
    return (
      <main className="page narrow">
        <h1>{title}</h1>
        <form className="card" onSubmit={submit}>
          <label className="field">
            Henkilökunnan tunniste
            <input type="password" value={input} onChange={(e) => setInput(e.target.value)} required autoFocus />
          </label>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <button className="btn primary" disabled={checking}>
            {checking ? 'Tarkistetaan…' : 'Kirjaudu'}
          </button>
          <p className="small muted">Kehitysympäristössä tunniste on dev-staff-token.</p>
        </form>
      </main>
    );
  }
  return <StaffContext.Provider value={token}>{children}</StaffContext.Provider>;
}

/** Aktiiviset tilaukset reaaliajassa: lista haetaan uudelleen tapahtumista, sijainnit päivitetään paikallisesti. */
export function useStaffOrders(): {
  orders: Order[] | null;
  restaurant: (LatLng & { name: string }) | null;
  error: string | null;
  reload: () => void;
  act: (path: string, body?: unknown) => Promise<void>;
  actionError: string | null;
} {
  const token = useStaffToken();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [restaurant, setRestaurant] = useState<(LatLng & { name: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const pending = useRef<number | null>(null);

  const reload = useCallback(() => {
    api<{ orders: Order[]; restaurant: LatLng & { name: string } }>('/api/staff/orders', { staffToken: token })
      .then((data) => {
        setOrders(data.orders);
        setRestaurant(data.restaurant);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [token]);
  useEffect(reload, [reload]);

  // Ruuhkassa tapahtumia tulee tiheään: yksi haku riittää kattamaan monta.
  const reloadSoon = useCallback(() => {
    if (pending.current !== null) return;
    pending.current = window.setTimeout(() => {
      pending.current = null;
      reload();
    }, 250);
  }, [reload]);
  useEffect(
    () => () => {
      if (pending.current !== null) window.clearTimeout(pending.current);
    },
    [],
  );

  useEvents(
    `/api/staff/events?staffToken=${encodeURIComponent(token)}`,
    (e) => {
      if (e.type === 'location' && e.lat !== undefined && e.lng !== undefined) {
        const location = { lat: e.lat, lng: e.lng };
        setOrders(
          (list) => list?.map((o) => (o.id === e.orderId && o.driver ? { ...o, driver: { ...o.driver, location } } : o)) ?? list,
        );
      } else {
        reloadSoon();
      }
    },
    reload,
  );

  const act = useCallback(
    async (path: string, body?: unknown) => {
      setActionError(null);
      try {
        await api(path, { method: 'POST', body, staffToken: token });
      } catch (e) {
        // 409 = joku muu ehti ensin tai tila muuttui; lista päivittyy ja näyttää nykytilan.
        setActionError((e as Error).message);
        reload();
      }
    },
    [token, reload],
  );

  return { orders, restaurant, error, reload, act, actionError };
}

export function minutesSince(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}
