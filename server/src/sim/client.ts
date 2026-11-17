export interface SimOrder {
  id: string;
  status: string;
  fulfillment: 'delivery' | 'pickup';
  location: { lat: number; lng: number } | null;
  driver: { id: string } | null;
  payment: { status: string } | null;
  updatedAt: string;
}

export class StaffClient {
  constructor(
    readonly apiUrl: string,
    private readonly staffToken: string,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        'x-staff-token': this.staffToken,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(`${method} ${path} → ${res.status} ${text}`), { status: res.status });
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  orders(): Promise<{ restaurant: { lat: number; lng: number }; orders: SimOrder[] }> {
    return this.request('GET', '/api/staff/orders');
  }
  stats(): Promise<{ byStatus: Record<string, number> }> {
    return this.request('GET', '/api/staff/stats');
  }
}

export function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
