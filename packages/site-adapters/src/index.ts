// Reads product data from a shopping page's DOM. Pure function of (document, url): runs in the
// Chrome content script today and in mobile WebViews later. Order: structured data first
// (JSON-LD, Open Graph), then per-site selectors, because structured data changes least often.

export type Marketplace = 'amazon' | 'myntra' | 'flipkart' | 'ajio' | 'other';

export interface Product {
  marketplace: Marketplace;
  url: string;
  externalId: string;
  title: string;
  brand?: string;
  price?: number;
  currency?: string;
  imageUrl: string;
}

export function marketplaceOf(url: URL): Marketplace {
  const h = url.hostname;
  if (/(^|\.)amazon\.(in|com|co\.uk|de|ae)$/.test(h)) return 'amazon';
  if (/(^|\.)myntra\.com$/.test(h)) return 'myntra';
  if (/(^|\.)flipkart\.com$/.test(h)) return 'flipkart';
  if (/(^|\.)ajio\.com$/.test(h)) return 'ajio';
  return 'other';
}

/** Product ID from the URL, so the same item seen twice counts once. */
export function externalIdOf(url: URL, m: Marketplace): string {
  const p = url.pathname;
  if (m === 'amazon') return /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i.exec(p)?.[1] ?? p;
  if (m === 'myntra') return /\/(\d{5,})\/buy/.exec(p)?.[1] ?? p;
  if (m === 'flipkart') return url.searchParams.get('pid') ?? /\/p\/(itm[a-z0-9]+)/i.exec(p)?.[1] ?? p;
  if (m === 'ajio') return /\/p\/([a-z0-9_]+)/i.exec(p)?.[1] ?? p;
  return url.origin + p;
}

function text(doc: Document, sel: string): string | undefined {
  const t = doc.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim();
  return t ? t : undefined;
}
function attr(doc: Document, sel: string, name: string): string | undefined {
  return doc.querySelector(sel)?.getAttribute(name)?.trim() || undefined;
}
function parsePrice(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number(s.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

interface JsonLdProduct { name?: string; image?: unknown; brand?: unknown; offers?: unknown }

function jsonLdProduct(doc: Document): JsonLdProduct | undefined {
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const data = JSON.parse(s.textContent ?? '') as unknown;
      const items = Array.isArray(data) ? data : [data, ...(((data as { '@graph'?: unknown[] })['@graph']) ?? [])];
      for (const it of items) {
        const type = (it as { '@type'?: unknown })?.['@type'];
        if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) return it as JsonLdProduct;
      }
    } catch { /* ignore broken JSON-LD */ }
  }
  return undefined;
}

function firstImage(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return firstImage(v[0]);
  if (v && typeof v === 'object' && 'url' in v) return firstImage((v as { url: unknown }).url);
  return undefined;
}

/** Amazon lists image sizes in data-a-dynamic-image; pick the largest. */
function amazonLargestImage(doc: Document): string | undefined {
  const img = doc.querySelector('#landingImage, #imgBlkFront, #main-image');
  const hires = img?.getAttribute('data-old-hires');
  if (hires) return hires;
  const dyn = img?.getAttribute('data-a-dynamic-image');
  if (dyn) {
    try {
      const sizes = JSON.parse(dyn) as Record<string, [number, number]>;
      return Object.entries(sizes).sort((a, b) => b[1][0] * b[1][1] - a[1][0] * a[1][1])[0]?.[0];
    } catch { /* fall through */ }
  }
  return img?.getAttribute('src') ?? undefined;
}

/** Returns null when the page is not a product page we can read. */
export function extractProduct(doc: Document, href: string): Product | null {
  const url = new URL(href);
  const m = marketplaceOf(url);
  const ld = jsonLdProduct(doc);
  const offers = Array.isArray(ld?.offers) ? ld?.offers[0] : ld?.offers;
  const o = (offers ?? {}) as { price?: unknown; priceCurrency?: unknown };

  let title = ld?.name?.trim();
  let imageUrl = firstImage(ld?.image);
  let brand = typeof ld?.brand === 'string' ? ld.brand : (ld?.brand as { name?: string } | undefined)?.name;
  let price = parsePrice(o.price !== undefined ? String(o.price) : undefined);
  let currency = typeof o.priceCurrency === 'string' ? o.priceCurrency : undefined;

  if (m === 'amazon') {
    title ??= text(doc, '#productTitle');
    imageUrl = amazonLargestImage(doc) ?? imageUrl;
    brand ??= text(doc, '#bylineInfo')?.replace(/^(Visit the|Brand:)\s*/i, '').replace(/\s*Store$/i, '');
    price ??= parsePrice(text(doc, '.a-price .a-offscreen'));
    if (!currency && url.hostname.endsWith('.in')) currency = 'INR';
  }
  if (m === 'myntra') {
    title ??= [text(doc, 'h1.pdp-title'), text(doc, 'h1.pdp-name')].filter(Boolean).join(' ') || undefined;
    brand ??= text(doc, 'h1.pdp-title');
    price ??= parsePrice(text(doc, '.pdp-price strong'));
  }

  title ??= attr(doc, 'meta[property="og:title"]', 'content');
  imageUrl ??= attr(doc, 'meta[property="og:image"]', 'content');

  // Amazon search and category pages have neither a title element nor product JSON-LD.
  if (!title || !imageUrl) return null;
  if (m === 'amazon' && !doc.querySelector('#productTitle') && !ld) return null;

  const product: Product = {
    marketplace: m,
    url: url.origin + url.pathname,
    externalId: externalIdOf(url, m),
    title: title.slice(0, 300),
    imageUrl: new URL(imageUrl, url).href,
  };
  if (brand) product.brand = brand.slice(0, 120);
  if (price !== undefined) product.price = price;
  if (currency) product.currency = currency;
  return product;
}
