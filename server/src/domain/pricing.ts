import type { Catalog, Fulfillment, OrderItemRequest, PricedItem, PricedOrder } from './types';

export class OrderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderValidationError';
  }
}

export const MAX_QUANTITY_PER_LINE = 20;
export const MAX_LINES = 30;

/** The server is the only source of prices: prices sent by a customer or an agent are never used. */
export function priceOrder(
  items: OrderItemRequest[],
  catalog: Catalog,
  fulfillment: Fulfillment,
  deliveryFeeCents: number,
): PricedOrder {
  if (items.length === 0) throw new OrderValidationError('The order has no items');
  if (items.length > MAX_LINES) throw new OrderValidationError('The order has too many lines');

  const priced: PricedItem[] = items.map((item) => {
    const product = catalog.get(item.productId);
    if (!product || !product.active) {
      throw new OrderValidationError(`Product is not available: ${item.productId}`);
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY_PER_LINE) {
      throw new OrderValidationError(`Invalid quantity for ${product.name}`);
    }
    let unit: number;
    if (item.size === 'large') {
      if (product.priceLargeCents === null) {
        throw new OrderValidationError(`${product.name} is not available in large`);
      }
      unit = product.priceLargeCents;
    } else if (item.size === 'normal') {
      unit = product.priceCents;
    } else {
      throw new OrderValidationError(`Invalid size for ${product.name}`);
    }
    for (const ing of item.without) {
      const found = product.ingredients.find((i) => i.id === ing);
      if (!found || !found.removable) {
        throw new OrderValidationError(`Ingredient ${ing} cannot be removed from ${product.name}`);
      }
    }
    const without = [...new Set(item.without)].sort();
    return {
      productId: product.id,
      name: product.name,
      size: item.size,
      quantity: item.quantity,
      without,
      withoutNames: without.map((id) => product.ingredients.find((i) => i.id === id)?.name ?? id),
      unitPriceCents: unit,
      lineTotalCents: unit * item.quantity,
    };
  });

  const subtotalCents = priced.reduce((sum, i) => sum + i.lineTotalCents, 0);
  const fee = fulfillment === 'delivery' ? deliveryFeeCents : 0;
  return { items: priced, subtotalCents, deliveryFeeCents: fee, totalCents: subtotalCents + fee };
}

/** Ingredient needs for the stock reservation. A large pizza uses 1.5x the amount (rounded up). */
export function ingredientNeeds(items: OrderItemRequest[], catalog: Catalog): Record<string, number> {
  const needs: Record<string, number> = {};
  for (const item of items) {
    const product = catalog.get(item.productId);
    if (!product) throw new OrderValidationError(`Product is not available: ${item.productId}`);
    for (const ing of product.ingredients) {
      if (item.without.includes(ing.id)) continue;
      const perUnit = item.size === 'large' ? Math.ceil(ing.qty * 1.5) : ing.qty;
      needs[ing.id] = (needs[ing.id] ?? 0) + perUnit * item.quantity;
    }
  }
  return needs;
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
