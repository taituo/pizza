// Tämä tiedosto ei saa tuoda mitään epädeterminististä: workflow-koodi käyttää sitä.

export const ORDER_STATUSES = [
  'created',
  'awaiting_payment',
  'paid',
  'preparing',
  'ready',
  'out_for_delivery',
  'completed',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type Fulfillment = 'delivery' | 'pickup';
export type Size = 'normal' | 'large';

export interface OrderItemRequest {
  productId: string;
  size: Size;
  quantity: number;
  /** Ainesosat, jotka asiakas haluaa jättää pois. */
  without: string[];
}

export interface PricedItem extends OrderItemRequest {
  name: string;
  /** Poisjätettyjen ainesosien nimet näyttöä varten. */
  withoutNames: string[];
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface CatalogProduct {
  id: string;
  name: string;
  description: string;
  category: 'pizza' | 'drink';
  priceCents: number;
  priceLargeCents: number | null;
  active: boolean;
  ingredients: { id: string; name: string; qty: number; removable: boolean }[];
}

export type Catalog = Map<string, CatalogProduct>;

export interface PricedOrder {
  items: PricedItem[];
  subtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
}

export type CancelReason =
  | 'invalid_order'
  | 'out_of_stock'
  | 'payment_failed'
  | 'payment_timeout'
  | 'customer_cancelled'
  | 'kitchen_rejected'
  | 'kitchen_timeout'
  | 'delivery_timeout'
  | 'not_collected'
  | 'operator_cancelled'
  | 'internal_error';

export function workflowIdForOrder(orderId: string): string {
  return `order-${orderId}`;
}
