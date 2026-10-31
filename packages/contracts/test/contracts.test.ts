import { describe, expect, it } from 'vitest';
import { EventBatch, Profile } from '../src/index.js';

const product = {
  marketplace: 'amazon_in',
  externalId: 'B0TEST1234',
  url: 'https://www.amazon.in/dp/B0TEST1234',
  title: 'Linen shirt',
  imageUrls: ['https://m.media-amazon.com/images/I/test.jpg'],
};

describe('contracts', () => {
  it('accepts a minimal profile and fills defaults', () => {
    const p = Profile.parse({ heightCm: 175 });
    expect(p.fit).toBe('regular');
    expect(p.styles).toEqual([]);
  });

  it('rejects an impossible height', () => {
    expect(Profile.safeParse({ heightCm: 20 }).success).toBe(false);
  });

  it('caps event batches at 50', () => {
    const one = { kind: 'opened', at: new Date().toISOString(), product };
    expect(EventBatch.safeParse({ events: Array(50).fill(one) }).success).toBe(true);
    expect(EventBatch.safeParse({ events: Array(51).fill(one) }).success).toBe(false);
  });
});
