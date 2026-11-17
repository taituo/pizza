import { describe, expect, it } from 'vitest';
import { haversineKm, ingredientNeeds, OrderValidationError, priceOrder } from '../src/domain/pricing';
import type { Catalog } from '../src/domain/types';

const catalog: Catalog = new Map([
  [
    'pepperoni',
    {
      id: 'pepperoni',
      name: 'Pepperoni',
      description: '',
      category: 'pizza',
      priceCents: 1290,
      priceLargeCents: 1690,
      active: true,
      ingredients: [
        { id: 'dough', name: 'Taikina', qty: 1, removable: false },
        { id: 'pepperoni', name: 'Pepperoni', qty: 2, removable: true },
        { id: 'onion', name: 'Sipuli', qty: 1, removable: true },
      ],
    },
  ],
  [
    'cola',
    {
      id: 'cola',
      name: 'Cola',
      description: '',
      category: 'drink',
      priceCents: 290,
      priceLargeCents: null,
      active: true,
      ingredients: [{ id: 'cola', name: 'Cola', qty: 1, removable: false }],
    },
  ],
  [
    'retired',
    { id: 'retired', name: 'Poistunut', description: '', category: 'pizza', priceCents: 1000, priceLargeCents: null, active: false, ingredients: [] },
  ],
]);

describe('priceOrder', () => {
  it('prices from the server catalog and adds the delivery fee', () => {
    const priced = priceOrder(
      [
        { productId: 'pepperoni', size: 'large', quantity: 2, without: ['onion'] },
        { productId: 'cola', size: 'normal', quantity: 1, without: [] },
      ],
      catalog,
      'delivery',
      390,
    );
    expect(priced.subtotalCents).toBe(2 * 1690 + 290);
    expect(priced.deliveryFeeCents).toBe(390);
    expect(priced.totalCents).toBe(2 * 1690 + 290 + 390);
    expect(priced.items[0]).toMatchObject({ name: 'Pepperoni', unitPriceCents: 1690, lineTotalCents: 3380 });
  });

  it('charges no delivery fee for pickup', () => {
    const priced = priceOrder([{ productId: 'cola', size: 'normal', quantity: 3, without: [] }], catalog, 'pickup', 390);
    expect(priced.totalCents).toBe(870);
  });

  it.each([
    ['unknown product', [{ productId: 'nope', size: 'normal', quantity: 1, without: [] }]],
    ['inactive product', [{ productId: 'retired', size: 'normal', quantity: 1, without: [] }]],
    ['size not sold', [{ productId: 'cola', size: 'large', quantity: 1, without: [] }]],
    ['zero quantity', [{ productId: 'cola', size: 'normal', quantity: 0, without: [] }]],
    ['fractional quantity', [{ productId: 'cola', size: 'normal', quantity: 1.5, without: [] }]],
    ['removing a base ingredient', [{ productId: 'pepperoni', size: 'normal', quantity: 1, without: ['dough'] }]],
    ['empty order', []],
  ] as const)('rejects %s', (_name, items) => {
    expect(() => priceOrder(items as never, catalog, 'pickup', 0)).toThrow(OrderValidationError);
  });
});

describe('ingredientNeeds', () => {
  it('sums ingredients, skips removed ones and scales large pizzas', () => {
    const needs = ingredientNeeds(
      [
        { productId: 'pepperoni', size: 'normal', quantity: 2, without: ['onion'] },
        { productId: 'pepperoni', size: 'large', quantity: 1, without: [] },
      ],
      catalog,
    );
    // normal: 2 × (1 dough, 2 pepperoni); large: ceil(1.5)=2 dough, 3 pepperoni, 2 onion
    expect(needs).toEqual({ dough: 4, pepperoni: 7, onion: 2 });
  });
});

describe('haversineKm', () => {
  it('measures Helsinki–Espoo centre at roughly 15 km', () => {
    const km = haversineKm({ lat: 60.1699, lng: 24.9384 }, { lat: 60.2055, lng: 24.6559 });
    expect(km).toBeGreaterThan(14);
    expect(km).toBeLessThan(17);
  });
});
