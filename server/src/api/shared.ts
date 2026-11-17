import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const UUID = z.uuid();

export const CHANNELS = ['web', 'app', 'agent', 'phone', 'whatsapp', 'email'] as const;

export const OrderItems = z
  .array(
    z.object({
      productId: z.string().min(1).max(50),
      size: z.enum(['normal', 'large']).default('normal'),
      quantity: z.number().int().min(1).max(20),
      without: z.array(z.string().min(1).max(50)).max(20).default([]),
    }),
  )
  .min(1)
  .max(30);

export const CreateOrder = z
  .object({
    customerName: z.string().trim().min(1).max(100),
    phone: z.string().trim().min(5).max(30),
    fulfillment: z.enum(['delivery', 'pickup']),
    address: z.string().trim().min(3).max(300).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    channel: z.enum(CHANNELS).default('web'),
    items: OrderItems,
  })
  .refine((o) => o.fulfillment === 'pickup' || (o.address && o.lat !== undefined && o.lng !== undefined), {
    message: 'Delivery requires an address and a location',
  });

export type NewOrder = z.infer<typeof CreateOrder>;

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
