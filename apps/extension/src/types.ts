import type { Product } from '@stylist/site-adapters';

export interface ViewedItem extends Product {
  seenAt: number;
}

export interface ShopSession {
  active: boolean;
  occasion: string;
  prompt: string;
}

export type Message = { type: 'product-viewed'; product: Product };

export const MAX_ITEMS = 30;
