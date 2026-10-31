// Runs the extractor in real Chromium (Playwright) against saved-page-style fixtures.
import { chromium, type Browser } from 'playwright';
import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let browser: Browser;
let bundle: string;

beforeAll(async () => {
  bundle = buildSync({
    entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
    bundle: true, write: false, format: 'iife', globalName: 'SA',
  }).outputFiles[0]!.text;
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); });

async function extract(html: string, href: string) {
  const page = await browser.newPage();
  await page.setContent(html);
  await page.addScriptTag({ content: bundle });
  const out = await page.evaluate((h) => (window as unknown as { SA: { extractProduct: (d: Document, h: string) => unknown } }).SA.extractProduct(document, h), href);
  await page.close();
  return out;
}

describe('site adapters', () => {
  it('Amazon product page: title, largest image, brand, price, ASIN', async () => {
    const html = `<span id="productTitle"> Men's Linen Blazer, Navy </span>
      <a id="bylineInfo">Visit the Allen Solly Store</a>
      <span class="a-price"><span class="a-offscreen">₹2,999.00</span></span>
      <img id="landingImage" src="https://m.media-amazon.com/images/I/small.jpg"
        data-a-dynamic-image='{"https://m.media-amazon.com/images/I/a._SX300_.jpg":[300,400],"https://m.media-amazon.com/images/I/a._SX1200_.jpg":[1200,1600]}'>`;
    expect(await extract(html, 'https://www.amazon.in/Allen-Solly-Blazer/dp/B0ABCDEFGH/ref=sr_1_1?x=1')).toEqual({
      marketplace: 'amazon', url: 'https://www.amazon.in/Allen-Solly-Blazer/dp/B0ABCDEFGH/ref=sr_1_1',
      externalId: 'B0ABCDEFGH', title: "Men's Linen Blazer, Navy", brand: 'Allen Solly', price: 2999, currency: 'INR',
      imageUrl: 'https://m.media-amazon.com/images/I/a._SX1200_.jpg',
    });
  });

  it('Amazon search page is not a product', async () => {
    const html = '<meta property="og:title" content="Amazon.in : blazer"><meta property="og:image" content="https://x/y.jpg">';
    expect(await extract(html, 'https://www.amazon.in/s?k=blazer')).toBeNull();
  });

  it('JSON-LD product on any site (e.g. Myntra)', async () => {
    const ld = { '@context': 'https://schema.org', '@type': 'Product', name: 'Floral A-Line Dress', brand: { name: 'W' },
      image: ['https://assets.myntassets.com/a.jpg'], offers: { price: '1499', priceCurrency: 'INR' } };
    const html = `<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
    expect(await extract(html, 'https://www.myntra.com/dresses/w/w-floral-dress/12345678/buy')).toMatchObject({
      marketplace: 'myntra', externalId: '12345678', title: 'Floral A-Line Dress', brand: 'W', price: 1499, currency: 'INR',
      imageUrl: 'https://assets.myntassets.com/a.jpg',
    });
  });

  it('falls back to Open Graph tags', async () => {
    const html = '<meta property="og:title" content="Leather Belt"><meta property="og:image" content="/img/belt.jpg">';
    expect(await extract(html, 'https://shop.example.com/p/belt')).toMatchObject({
      marketplace: 'other', title: 'Leather Belt', imageUrl: 'https://shop.example.com/img/belt.jpg',
    });
  });

  it('ignores broken JSON-LD and pages without products', async () => {
    expect(await extract('<script type="application/ld+json">{oops</script><p>hi</p>', 'https://www.flipkart.com/')).toBeNull();
  });
});
