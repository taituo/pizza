import { useEffect, useRef } from 'react';
import type { OrderEvent } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; staffToken?: string; orderToken?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.staffToken) headers['x-staff-token'] = opts.staffToken;
  if (opts.orderToken) headers['x-order-token'] = opts.orderToken;
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, 'Yhteys palvelimeen katkesi. Tarkista verkkoyhteys ja yritä uudelleen.');
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, data?.error ?? `Pyyntö epäonnistui (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/**
 * Tilaa palvelimen tapahtumavirran (SSE). Selain yhdistää automaattisesti uudelleen;
 * onResync kutsutaan aina yhteyden (uudelleen)avautuessa, jotta väliin jääneet muutokset haetaan.
 */
export function useEvents(url: string | null, onEvent: (e: OrderEvent) => void, onResync: () => void): void {
  const handlers = useRef({ onEvent, onResync });
  handlers.current = { onEvent, onResync };
  useEffect(() => {
    if (!url) return;
    const source = new EventSource(url);
    let opened = false;
    source.addEventListener('open', () => {
      if (opened) handlers.current.onResync();
      opened = true;
    });
    source.addEventListener('resync', () => handlers.current.onResync());
    source.addEventListener('order', (msg) => {
      try {
        handlers.current.onEvent(JSON.parse((msg as MessageEvent<string>).data) as OrderEvent);
      } catch {
        /* ohitetaan rikkinäinen viesti */
      }
    });
    return () => source.close();
  }, [url]);
}

const eur = new Intl.NumberFormat('fi-FI', { style: 'currency', currency: 'EUR' });
export const money = (cents: number): string => eur.format(cents / 100);

export const time = (iso: string): string =>
  new Date(iso).toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' });

export function store(kind: 'local' | 'session') {
  const s = (): Storage | null => {
    try {
      return kind === 'local' ? window.localStorage : window.sessionStorage;
    } catch {
      return null;
    }
  };
  return {
    get(key: string): string | null {
      try {
        return s()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key: string, value: string | null): void {
      try {
        if (value === null) s()?.removeItem(key);
        else s()?.setItem(key, value);
      } catch {
        /* tallennus ei ole välttämätön */
      }
    },
  };
}

export const STATUS_LABEL: Record<string, string> = {
  created: 'Vastaanotettu',
  awaiting_payment: 'Odottaa maksua',
  paid: 'Odottaa keittiötä',
  preparing: 'Valmistuksessa',
  ready: 'Valmis',
  out_for_delivery: 'Kuljetuksessa',
  completed: 'Valmis',
  cancelled: 'Peruttu',
};

export const CANCEL_LABEL: Record<string, string> = {
  invalid_order: 'Tilauksessa oli virhe, eikä sitä voitu käsitellä.',
  out_of_stock: 'Jokin tilaamasi tuote ehti loppua. Mitään ei veloitettu.',
  payment_failed: 'Maksu epäonnistui. Mitään ei veloitettu.',
  payment_timeout: 'Maksua ei tehty ajoissa, joten tilaus raukesi. Mitään ei veloitettu.',
  customer_cancelled: 'Peruit tilauksen. Mahdollinen maksu palautetaan.',
  kitchen_rejected: 'Keittiö ei valitettavasti voinut ottaa tilausta vastaan. Maksu palautetaan.',
  kitchen_timeout: 'Keittiö ei ehtinyt käsitellä tilausta. Maksu palautetaan.',
  delivery_timeout: 'Toimitus ei onnistunut. Maksu palautetaan.',
  not_collected: 'Tilausta ei noudettu.',
  operator_cancelled: 'Ravintola perui tilauksen. Maksu palautetaan.',
  internal_error: 'Tilausta ei voitu käsitellä teknisen vian vuoksi. Mitään ei veloitettu.',
};
