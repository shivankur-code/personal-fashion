// API request and response shapes shared by the backend, the Chrome extension and the mobile apps.
// Rule: this package must stay platform-free (no Node, browser, Chrome or React Native APIs).
import { z } from 'zod';

export const Id = z.string().uuid();

export const Occasion = z.enum([
  'wedding', 'office', 'date', 'party', 'casual', 'interview', 'festival', 'travel', 'custom',
]);
export type Occasion = z.infer<typeof Occasion>;

export const GarmentSlot = z.enum(['top', 'bottom', 'one_piece', 'outerwear', 'footwear', 'accessory']);
export type GarmentSlot = z.infer<typeof GarmentSlot>;

export const Marketplace = z.enum(['amazon_in', 'amazon_com']);
export type Marketplace = z.infer<typeof Marketplace>;

// Profile. Metric units only; clients convert for display.
export const Profile = z.object({
  styles: z.array(z.string().min(1).max(40)).max(10).default([]),
  dislikedStyles: z.array(z.string().min(1).max(40)).max(10).default([]),
  neverWear: z.array(z.string().min(1).max(60)).max(20).default([]),
  heightCm: z.number().int().min(90).max(250),
  weightKg: z.number().min(25).max(300).optional(),
  fit: z.enum(['slim', 'regular', 'relaxed']).default('regular'),
  skinTone: z.number().int().min(1).max(10).optional(), // swatch index, chosen by the user
  undertone: z.enum(['warm', 'cool', 'neutral']).optional(),
  palette: z.string().max(40).optional(), // e.g. "cool_winter", confirmed by the user
  city: z.string().max(80).optional(),
});
export type Profile = z.infer<typeof Profile>;

export const ProductSnapshot = z.object({
  marketplace: Marketplace,
  externalId: z.string().min(1).max(64), // e.g. ASIN
  variant: z.string().max(120).optional(),
  url: z.string().url().max(2048),
  title: z.string().min(1).max(400),
  brand: z.string().max(120).optional(),
  price: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  imageUrls: z.array(z.string().url().max(2048)).min(1).max(12),
});
export type ProductSnapshot = z.infer<typeof ProductSnapshot>;

export const SignalKind = z.enum(['opened', 'dwell', 'gallery', 'variant', 'hover', 'add_to_cart']);
export type SignalKind = z.infer<typeof SignalKind>;

export const BrowseEvent = z.object({
  kind: SignalKind,
  at: z.string().datetime(),
  product: ProductSnapshot,
});
export type BrowseEvent = z.infer<typeof BrowseEvent>;

// Events are batched by the extension: at most 50 per request (API also caps the body at 64 KB).
export const EventBatch = z.object({ events: z.array(BrowseEvent).min(1).max(50) });
export type EventBatch = z.infer<typeof EventBatch>;

export const CreateSession = z.object({
  marketplace: Marketplace,
  occasion: Occasion,
  prompt: z.string().max(500).optional(),
});
export type CreateSession = z.infer<typeof CreateSession>;

export const JobStatus = z.enum([
  'queued', 'gathering', 'planning', 'rendering', 'checking', 'done', 'failed', 'cancelled',
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const Generation = z.object({
  id: Id,
  status: JobStatus,
  resultUrls: z.array(z.string().url()).default([]),
  explanation: z.string().optional(),
  error: z.string().optional(),
});
export type Generation = z.infer<typeof Generation>;

export const Health = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  database: z.enum(['ok', 'down', 'not_configured']),
});
export type Health = z.infer<typeof Health>;
