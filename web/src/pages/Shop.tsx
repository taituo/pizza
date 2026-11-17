import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, money, store } from '../api';
import { MapView } from '../components/MapView';
import type { Fulfillment, LatLng, Menu, Product, Size } from '../types';

interface CartLine {
  key: string;
  product: Product;
  size: Size;
  without: string[];
  quantity: number;
}

const local = store('local');

function distanceKm(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function Shop() {
  const navigate = useNavigate();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [fulfillment, setFulfillment] = useState<Fulfillment>('delivery');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [spot, setSpot] = useState<LatLng | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastOrder = useMemo(() => {
    try {
      return JSON.parse(local.get('lastOrder') ?? 'null') as { id: string; token: string } | null;
    } catch {
      return null;
    }
  }, []);

  const loadMenu = () => {
    setLoadError(null);
    api<Menu>('/api/menu')
      .then(setMenu)
      .catch((e: Error) => setLoadError(e.message));
  };
  useEffect(loadMenu, []);

  const add = (product: Product, size: Size, without: string[]) => {
    const key = `${product.id}|${size}|${[...without].sort().join(',')}`;
    setCart((lines) => {
      const found = lines.find((l) => l.key === key);
      if (found) return lines.map((l) => (l.key === key ? { ...l, quantity: Math.min(20, l.quantity + 1) } : l));
      return [...lines, { key, product, size, without, quantity: 1 }];
    });
  };
  const change = (key: string, delta: number) =>
    setCart((lines) =>
      lines
        .map((l) => (l.key === key ? { ...l, quantity: Math.min(20, l.quantity + delta) } : l))
        .filter((l) => l.quantity > 0),
    );

  const unit = (l: CartLine) => (l.size === 'large' ? (l.product.priceLargeCents ?? l.product.priceCents) : l.product.priceCents);
  const subtotal = cart.reduce((sum, l) => sum + unit(l) * l.quantity, 0);
  const fee = fulfillment === 'delivery' && menu ? menu.deliveryFeeCents : 0;
  const tooFar = Boolean(menu && spot && distanceKm(menu.restaurant, spot) > menu.deliveryRadiusKm);

  const problem =
    cart.length === 0
      ? 'Lisää ensin jotain ostoskoriin.'
      : fulfillment === 'delivery' && !spot
        ? 'Merkitse toimituspaikka kartalta.'
        : tooFar
          ? `Toimituspaikka on alueemme ulkopuolella (yli ${menu?.deliveryRadiusKm} km).`
          : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await api<{ id: string; accessToken: string }>('/api/orders', {
        body: {
          customerName: name,
          phone,
          fulfillment,
          ...(fulfillment === 'delivery' ? { address, lat: spot!.lat, lng: spot!.lng } : {}),
          items: cart.map((l) => ({ productId: l.product.id, size: l.size, quantity: l.quantity, without: l.without })),
        },
      });
      local.set('lastOrder', JSON.stringify({ id: created.id, token: created.accessToken }));
      navigate(`/order/${created.id}?token=${encodeURIComponent(created.accessToken)}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  if (loadError) {
    return (
      <main className="page narrow">
        <div className="notice error" role="alert">
          <p>Ruokalistaa ei saatu ladattua. {loadError}</p>
          <button className="btn" onClick={loadMenu}>
            Yritä uudelleen
          </button>
        </div>
      </main>
    );
  }
  if (!menu) return <main className="page narrow muted">Ladataan ruokalistaa…</main>;

  const pizzas = menu.products.filter((p) => p.category === 'pizza');
  const drinks = menu.products.filter((p) => p.category === 'drink');

  return (
    <main className="page shop">
      <section>
        <header className="hero">
          <p className="eyebrow">{menu.restaurant.name}</p>
          <h1>Uunista ovelle, ja näet koko matkan.</h1>
          <p className="lede">
            Valitse pizzat, maksa ja seuraa tilaustasi keittiöstä kartalle asti. Kotiinkuljetus {money(menu.deliveryFeeCents)},{' '}
            {menu.deliveryRadiusKm} km säteellä.
          </p>
          {lastOrder && (
            <Link className="last-order" to={`/order/${lastOrder.id}?token=${encodeURIComponent(lastOrder.token)}`}>
              Jatka edellisen tilauksesi seurantaa →
            </Link>
          )}
        </header>

        <h2>Pizzat</h2>
        <div className="menu-grid">
          {pizzas.map((p) => (
            <ProductCard key={p.id} product={p} onAdd={add} />
          ))}
        </div>
        <h2>Juomat</h2>
        <div className="menu-grid">
          {drinks.map((p) => (
            <ProductCard key={p.id} product={p} onAdd={add} />
          ))}
        </div>
      </section>

      <aside className="cart" aria-label="Ostoskori ja tilaus">
        <form onSubmit={submit}>
          <h2>Tilauksesi</h2>
          {cart.length === 0 ? (
            <p className="muted">Ostoskori on tyhjä. Lisää pizza ruokalistalta.</p>
          ) : (
            <ul className="cart-lines">
              {cart.map((l) => (
                <li key={l.key}>
                  <div>
                    <strong>
                      {l.product.name}
                      {l.size === 'large' && ' (iso)'}
                    </strong>
                    {l.without.length > 0 && (
                      <span className="muted small">
                        ilman: {l.without.map((id) => l.product.removable.find((r) => r.id === id)?.name ?? id).join(', ')}
                      </span>
                    )}
                  </div>
                  <div className="qty">
                    <button type="button" onClick={() => change(l.key, -1)} aria-label={`Vähennä: ${l.product.name}`}>
                      −
                    </button>
                    <span aria-label="määrä">{l.quantity}</span>
                    <button type="button" onClick={() => change(l.key, 1)} aria-label={`Lisää: ${l.product.name}`}>
                      +
                    </button>
                  </div>
                  <span className="price">{money(unit(l) * l.quantity)}</span>
                </li>
              ))}
            </ul>
          )}

          <fieldset className="segmented">
            <legend>Toimitustapa</legend>
            <label>
              <input type="radio" name="f" checked={fulfillment === 'delivery'} onChange={() => setFulfillment('delivery')} />
              <span>Kotiinkuljetus</span>
            </label>
            <label>
              <input type="radio" name="f" checked={fulfillment === 'pickup'} onChange={() => setFulfillment('pickup')} />
              <span>Nouto</span>
            </label>
          </fieldset>

          <label className="field">
            Nimi
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoComplete="name" />
          </label>
          <label className="field">
            Puhelin
            <input value={phone} onChange={(e) => setPhone(e.target.value)} required minLength={5} maxLength={30} type="tel" autoComplete="tel" />
          </label>

          {fulfillment === 'delivery' && (
            <>
              <label className="field">
                Osoite ja ovikoodi
                <input value={address} onChange={(e) => setAddress(e.target.value)} required minLength={3} maxLength={300} autoComplete="street-address" />
              </label>
              <p className="small muted">Napauta karttaa toimituspaikan kohdalta, niin kuljettaja löytää perille.</p>
              <MapView
                label="Valitse toimituspaikka kartalta"
                center={menu.restaurant}
                radiusKm={menu.deliveryRadiusKm}
                height={220}
                fit={false}
                onPick={setSpot}
                markers={[
                  { id: 'r', kind: 'restaurant', label: menu.restaurant.name, ...menu.restaurant },
                  ...(spot ? [{ id: 'c', kind: 'customer' as const, label: 'Toimituspaikka', ...spot }] : []),
                ]}
              />
            </>
          )}

          <dl className="totals">
            <div>
              <dt>Tuotteet</dt>
              <dd>{money(subtotal)}</dd>
            </div>
            {fulfillment === 'delivery' && (
              <div>
                <dt>Kotiinkuljetus</dt>
                <dd>{money(fee)}</dd>
              </div>
            )}
            <div className="grand">
              <dt>Yhteensä</dt>
              <dd>{money(subtotal + fee)}</dd>
            </div>
          </dl>

          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <button className="btn primary wide" type="submit" disabled={Boolean(problem) || submitting}>
            {submitting ? 'Lähetetään…' : 'Tilaa ja siirry maksamaan'}
          </button>
          {problem && <p className="small muted hint">{problem}</p>}
        </form>
      </aside>
    </main>
  );
}

function ProductCard({ product, onAdd }: { product: Product; onAdd: (p: Product, s: Size, w: string[]) => void }) {
  const [size, setSize] = useState<Size>('normal');
  const [without, setWithout] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const price = size === 'large' && product.priceLargeCents ? product.priceLargeCents : product.priceCents;
  const toggle = (id: string) => setWithout((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]));

  return (
    <article className="card product">
      <div className="product-head">
        <h3>{product.name}</h3>
        <span className="price">{money(price)}</span>
      </div>
      <p className="muted">{product.description}</p>
      {product.priceLargeCents !== null && (
        <div className="chips" role="group" aria-label={`${product.name}: koko`}>
          <button type="button" className={size === 'normal' ? 'chip on' : 'chip'} aria-pressed={size === 'normal'} onClick={() => setSize('normal')}>
            Normaali
          </button>
          <button type="button" className={size === 'large' ? 'chip on' : 'chip'} aria-pressed={size === 'large'} onClick={() => setSize('large')}>
            Iso
          </button>
        </div>
      )}
      {product.removable.length > 0 && (
        <>
          <button type="button" className="link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {without.length > 0 ? `Jätetään pois: ${without.length}` : 'Jätä jotain pois'}
          </button>
          {open && (
            <div className="chips">
              {product.removable.map((r) => (
                <button
                  type="button"
                  key={r.id}
                  className={without.includes(r.id) ? 'chip off' : 'chip'}
                  aria-pressed={without.includes(r.id)}
                  onClick={() => toggle(r.id)}
                >
                  {without.includes(r.id) ? `ei ${r.name.toLowerCase()}` : r.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      <button
        type="button"
        className="btn"
        onClick={() => {
          onAdd(product, size, without);
          setWithout([]);
          setOpen(false);
        }}
      >
        Lisää koriin
      </button>
    </article>
  );
}
