export type OrderStatus =
  | 'created'
  | 'awaiting_payment'
  | 'paid'
  | 'preparing'
  | 'ready'
  | 'out_for_delivery'
  | 'completed'
  | 'cancelled';

export type Fulfillment = 'delivery' | 'pickup';
export type Size = 'normal' | 'large';
export interface LatLng {
  lat: number;
  lng: number;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  category: 'pizza' | 'drink';
  priceCents: number;
  priceLargeCents: number | null;
  removable: { id: string; name: string }[];
}

export interface Menu {
  restaurant: LatLng & { name: string };
  deliveryFeeCents: number;
  deliveryRadiusKm: number;
  paymentProvider: 'sim' | 'stripe';
  products: Product[];
}

export interface OrderItem {
  productId: string;
  size: Size;
  quantity: number;
  without: string[];
  withoutNames?: string[];
  name?: string;
  unitPriceCents?: number;
  lineTotalCents?: number;
}

export interface Order {
  id: string;
  status: OrderStatus;
  fulfillment: Fulfillment;
  customerName: string;
  phone: string;
  address: string | null;
  location: LatLng | null;
  items: OrderItem[];
  priced: boolean;
  deliveryFeeCents: number | null;
  totalCents: number | null;
  driver: { id: string; location: LatLng | null; updatedAt: string | null } | null;
  payment: { status: string; provider: 'sim' | 'stripe'; checkoutUrl: string | null } | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  restaurant?: LatLng & { name: string };
  timeline?: { type: string; at: string }[];
}

export interface OrderEvent {
  orderId: string;
  type: string;
  lat?: number;
  lng?: number;
}

export interface Proposal {
  id: string;
  accessToken: string;
  status: 'open' | 'confirmed' | 'superseded' | 'expired';
  fulfillment: Fulfillment;
  items: OrderItem[];
  deliveryFeeCents: number;
  totalCents: number;
  customerName: string | null;
  phone: string | null;
  address: string | null;
  expiresAt: string;
  orderId: string | null;
}

export interface ChatMessage {
  role: 'user' | 'agent';
  content: string;
}

export interface Conversation {
  id: string;
  messages: ChatMessage[];
  proposal: Proposal | null;
  orders: { id: string; accessToken: string; status: OrderStatus }[];
}
