// Side panel: sign-in, profile + photo, and the shopping list with try-on.
import type { ShopSession, ViewedItem } from './types.js';

declare const __API_URL__: string;
const API = __API_URL__;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STYLES = ['Classic', 'Minimalist', 'Streetwear', 'Business formal', 'Smart casual', 'Ethnic', 'Athleisure', 'Bohemian', 'Party'];
const TONES = ['#f6e0cf', '#efd0b5', '#e3b994', '#d4a276', '#c08a5d', '#a8704a', '#8d5a3a', '#71452c', '#563322', '#3b2318'];

function status(id: string, msg: string, kind: '' | 'ok' | 'err' = ''): void {
  const el = $(id); el.textContent = msg; el.className = `status ${kind}`;
}

// ---------- auth ----------
type Auth = { kind: 'google' } | { kind: 'code'; code: string };
let auth: Auth | null = null;

async function googleToken(interactive: boolean): Promise<string | null> {
  try {
    // Chrome's sign-in window can be closed or never appear; don't wait forever.
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), interactive ? 120_000 : 15_000));
    const r = await Promise.race([chrome.identity.getAuthToken({ interactive }), timeout]);
    return r?.token ?? null;
  } catch {
    return null;
  }
}

async function api<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let token: string | null = null;
  if (auth?.kind === 'code') headers['x-access-code'] = auth.code;
  if (auth?.kind === 'google') {
    token = await googleToken(false);
    if (!token) throw new Error('Please sign in again.');
    headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (res.status === 401 && token && !retried) {
    await chrome.identity.removeCachedAuthToken({ token });
    return api(path, init, true);
  }
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

interface Me { email: string; profile: Record<string, unknown> | null; hasPhoto: boolean; remainingToday: number; maxGarments?: number }
let maxGarments = 3;

async function enter(): Promise<void> {
  const me = await api<Me>('/v1/me');
  maxGarments = me.maxGarments ?? 3;
  void renderItems();
  $('who').textContent = me.email;
  $('signin').classList.add('hidden');
  $('app').classList.remove('hidden');
  fillProfile(me);
  if (!me.hasPhoto || !me.profile) showTab('profile');
}

$('google').onclick = async () => {
  status('signinStatus', 'Opening Google sign-in…');
  const token = await googleToken(true);
  if (!token) return status('signinStatus', 'Google sign-in did not complete. If it keeps failing, use the access code below.', 'err');
  auth = { kind: 'google' };
  await chrome.storage.local.set({ auth });
  enter().catch((e: Error) => status('signinStatus', e.message, 'err'));
};
$('showCode').onclick = () => $('codeBox').classList.toggle('hidden');
$('useCode').onclick = async () => {
  auth = { kind: 'code', code: $<HTMLInputElement>('code').value.trim() };
  try { await enter(); await chrome.storage.local.set({ auth }); } catch (e) { auth = null; status('signinStatus', (e as Error).message, 'err'); }
};
$('signout').onclick = async () => {
  if (auth?.kind === 'google') {
    const t = await googleToken(false);
    if (t) await chrome.identity.removeCachedAuthToken({ token: t });
  }
  auth = null;
  await chrome.storage.local.remove('auth');
  location.reload();
};

// ---------- tabs ----------
function showTab(t: 'shop' | 'profile'): void {
  $('shop').classList.toggle('hidden', t !== 'shop');
  $('profile').classList.toggle('hidden', t !== 'profile');
  $('tabShop').classList.toggle('on', t === 'shop');
  $('tabProfile').classList.toggle('on', t === 'profile');
}
$('tabShop').onclick = () => showTab('shop');
$('tabProfile').onclick = () => showTab('profile');

// ---------- images ----------
/** Fetches (extension pages may read the shop's image CDN) and shrinks to at most 1024 px JPEG. */
async function toJpegDataUrl(src: Blob | string, max = 1024): Promise<string> {
  const blob = typeof src === 'string' ? await (await fetch(src)).blob() : src;
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88);
}

// ---------- profile ----------
const chosenStyles = new Set<string>();
let tone: number | undefined;
STYLES.forEach((s) => {
  const b = document.createElement('button'); b.className = 'chip'; b.textContent = s;
  b.onclick = () => { if (chosenStyles.has(s)) chosenStyles.delete(s); else chosenStyles.add(s); b.classList.toggle('on'); };
  $('styles').appendChild(b);
});
TONES.forEach((c, i) => {
  const d = document.createElement('div'); d.className = 'tone'; d.style.background = c; d.title = `Tone ${i + 1}`;
  d.onclick = () => { tone = i + 1; document.querySelectorAll('.tone').forEach((x, j) => x.classList.toggle('on', j === i)); };
  $('tones').appendChild(d);
});

function fillProfile(me: Me): void {
  const p = me.profile ?? {};
  ((p.styles as string[] | undefined) ?? []).forEach((s) => {
    chosenStyles.add(s);
    Array.from($('styles').children).find((b) => b.textContent === s)?.classList.add('on');
  });
  if (p.heightCm) $<HTMLInputElement>('height').value = String(p.heightCm);
  if (p.weightKg) $<HTMLInputElement>('weight').value = String(p.weightKg);
  if (p.fit) $<HTMLSelectElement>('fit').value = String(p.fit);
  if (p.undertone) $<HTMLSelectElement>('undertone').value = String(p.undertone);
  if (typeof p.skinTone === 'number') (document.querySelectorAll('.tone')[p.skinTone - 1] as HTMLElement | undefined)?.click();
  status('photoStatus', me.hasPhoto ? 'Photo saved. Choose a new file to replace it.' : 'Add a full-length photo: standing, facing the camera, plain background.', me.hasPhoto ? 'ok' : '');
}

$<HTMLInputElement>('photo').onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try {
    status('photoStatus', 'Saving…');
    const dataUrl = await toJpegDataUrl(f);
    $<HTMLImageElement>('photoPreview').src = dataUrl;
    $('photoPreview').classList.remove('hidden');
    await api('/v1/me/photo', { method: 'PUT', body: JSON.stringify({ photo: dataUrl }) });
    status('photoStatus', 'Photo saved.', 'ok');
  } catch (err) { status('photoStatus', (err as Error).message, 'err'); }
};

$('saveProfile').onclick = async () => {
  const height = Number($<HTMLInputElement>('height').value);
  const weight = Number($<HTMLInputElement>('weight').value);
  const undertone = $<HTMLSelectElement>('undertone').value;
  const profile: Record<string, unknown> = { styles: [...chosenStyles], fit: $<HTMLSelectElement>('fit').value, heightCm: height };
  if (weight) profile.weightKg = weight;
  if (tone) profile.skinTone = tone;
  if (undertone) profile.undertone = undertone;
  if (!height) return status('profileStatus', 'Height is required.', 'err');
  try { await api('/v1/me/profile', { method: 'PUT', body: JSON.stringify(profile) }); status('profileStatus', 'Saved.', 'ok'); }
  catch (err) { status('profileStatus', (err as Error).message, 'err'); }
};

// ---------- shop ----------
const selected = new Set<string>();
const keyOf = (i: ViewedItem) => `${i.marketplace}:${i.externalId}`;

async function getSession(): Promise<ShopSession> {
  const { session } = (await chrome.storage.local.get('session')) as { session?: ShopSession };
  return session ?? { active: false, occasion: 'casual', prompt: '' };
}
async function saveSession(s: ShopSession): Promise<void> { await chrome.storage.local.set({ session: s }); }

async function renderSession(): Promise<void> {
  const s = await getSession();
  $<HTMLSelectElement>('occasion').value = s.occasion;
  $<HTMLInputElement>('prompt').value = s.prompt;
  $('trackLabel').textContent = s.active ? 'Collecting items you view' : 'Collecting is off';
  $('track').textContent = s.active ? 'Stop' : 'Start';
}
$('track').onclick = async () => {
  const s = await getSession();
  await saveSession({ ...s, active: !s.active, occasion: $<HTMLSelectElement>('occasion').value, prompt: $<HTMLInputElement>('prompt').value });
  await renderSession();
};
$('occasion').onchange = async () => saveSession({ ...(await getSession()), occasion: $<HTMLSelectElement>('occasion').value });
$('prompt').onchange = async () => saveSession({ ...(await getSession()), prompt: $<HTMLInputElement>('prompt').value });

async function renderItems(): Promise<void> {
  const { items = [] } = (await chrome.storage.local.get('items')) as { items?: ViewedItem[] };
  const box = $('items'); box.textContent = '';
  $('empty').classList.toggle('hidden', items.length > 0);
  for (const it of items) {
    const k = keyOf(it);
    const card = document.createElement('div');
    card.className = `item${selected.has(k) ? ' on' : ''}`;
    card.title = `${it.brand ? `${it.brand} · ` : ''}${it.title}${it.price ? ` · ${it.currency ?? ''} ${it.price}` : ''}`;
    const img = document.createElement('img'); img.src = it.imageUrl; img.alt = it.title; img.referrerPolicy = 'no-referrer';
    const t = document.createElement('div'); t.className = 't'; t.textContent = `${it.marketplace} · ${it.title}`;
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = 'Remove';
    x.onclick = async (e) => {
      e.stopPropagation(); selected.delete(k);
      await chrome.storage.local.set({ items: items.filter((i) => keyOf(i) !== k) });
    };
    card.onclick = () => {
      if (selected.has(k)) selected.delete(k);
      else if (selected.size < maxGarments) selected.add(k);
      else return status('tryStatus', `Pick up to ${maxGarments} items.`, 'err');
      void renderItems();
    };
    card.append(img, t, x);
    box.appendChild(card);
  }
  $<HTMLButtonElement>('tryOn').disabled = selected.size === 0;
  $('tryOn').textContent = `Try on selected (${selected.size}/${maxGarments})`;
}

$('clear').onclick = async () => { selected.clear(); await chrome.storage.local.set({ items: [] }); await chrome.action.setBadgeText({ text: '' }); };

$('tryOn').onclick = async () => {
  const { items = [] } = (await chrome.storage.local.get('items')) as { items?: ViewedItem[] };
  const picks = items.filter((i) => selected.has(keyOf(i)));
  const s = await getSession();
  $<HTMLButtonElement>('tryOn').disabled = true;
  const t0 = Date.now();
  try {
    status('tryStatus', 'Preparing images…');
    // Main photo plus gallery photos: the server picks the one that shows the item best.
    // Same cap as the server: at most 12 photos in total, at most 4 per item.
    const per = Math.max(1, Math.min(4, Math.floor(12 / picks.length)));
    const garments = await Promise.all(picks.map(async (p) => {
      const urls = [p.imageUrl, ...(p.altImageUrls ?? [])].slice(0, per);
      const imgs = await Promise.all(urls.map((u, i) => toJpegDataUrl(u).catch((e: unknown) => { if (i === 0) throw e; return null; })));
      return { title: p.title, images: imgs.filter((x): x is string => x !== null) };
    }));
    status('tryStatus', 'Reading your photo and the items, then dressing you… about 30–60 seconds.');
    const r = await api<{ image: string; estimatedCostUsd: number; remainingToday: number; notes?: string[]; styling?: string; advice?: { item: number; verdict: string }[] }>('/v1/me/try-on', {
      method: 'POST',
      body: JSON.stringify({ garments, occasion: $<HTMLSelectElement>('occasion').value || s.occasion, prompt: $<HTMLInputElement>('prompt').value }),
    });
    const box = $('result'); box.textContent = '';
    const img = document.createElement('img'); img.src = r.image; img.alt = 'You wearing the selected items';
    const a = document.createElement('a'); a.href = r.image; a.download = `stylist-${Date.now()}.jpg`; a.textContent = 'Save image';
    box.append(img, a);
    const line = (text: string) => { const p = document.createElement('p'); p.className = 'status'; p.textContent = text; box.append(p); };
    if (r.styling) line(`How to wear it: ${r.styling}`);
    for (const a of r.advice ?? []) line(`${picks[a.item - 1]?.title.slice(0, 40) ?? `Item ${a.item}`}: ${a.verdict}`);
    for (const n of r.notes ?? []) line(n);
    status('tryStatus', `Done in ${((Date.now() - t0) / 1000).toFixed(1)} s · about $${r.estimatedCostUsd.toFixed(2)} · ${r.remainingToday} left today`, 'ok');
  } catch (err) {
    status('tryStatus', (err as Error).message, 'err');
  } finally {
    $<HTMLButtonElement>('tryOn').disabled = selected.size === 0;
  }
};

chrome.storage.onChanged.addListener((changes) => {
  if (changes.items) void renderItems();
  if (changes.session) void renderSession();
});

// ---------- start ----------
void (async () => {
  await renderSession();
  await renderItems();
  const saved = (await chrome.storage.local.get('auth')) as { auth?: Auth };
  if (saved.auth) {
    auth = saved.auth;
    enter().catch(() => { auth = null; });
  }
})();
