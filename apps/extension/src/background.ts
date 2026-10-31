// Service worker: keeps the list of viewed items while a shopping session is on.
// State lives in chrome.storage (the worker can be stopped at any time).
import { MAX_ITEMS, type Message, type ShopSession, type ViewedItem } from './types.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg?.type !== 'product-viewed') return;
  void (async () => {
    const { session } = (await chrome.storage.local.get('session')) as { session?: ShopSession };
    if (!session?.active) return; // only track during a session the user started
    const { items = [] } = (await chrome.storage.local.get('items')) as { items?: ViewedItem[] };
    const key = `${msg.product.marketplace}:${msg.product.externalId}`;
    const rest = items.filter((i) => `${i.marketplace}:${i.externalId}` !== key);
    const next = [{ ...msg.product, seenAt: Date.now() }, ...rest].slice(0, MAX_ITEMS);
    await chrome.storage.local.set({ items: next });
    await chrome.action.setBadgeText({ text: String(next.length) });
  })();
});
