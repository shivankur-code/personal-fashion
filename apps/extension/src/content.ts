// Runs on supported shopping sites. Reads the product on the page the user is looking at
// (never other pages) and reports it once the user has stayed on it for 3 seconds.
import { extractProduct } from '@stylist/site-adapters';
import type { Message } from './types.js';

const DWELL_MS = 3000;
let lastUrl = '';
let timer: number | undefined;

function check(): void {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  if (timer !== undefined) clearTimeout(timer);
  timer = window.setTimeout(() => {
    const product = extractProduct(document, location.href);
    if (!product) return;
    const msg: Message = { type: 'product-viewed', product };
    chrome.runtime.sendMessage(msg).catch(() => undefined);
  }, DWELL_MS);
}

check();
// Shopping sites change pages without reloading; watch the address.
setInterval(check, 1000);
