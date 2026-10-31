// Google sign-in for the Chrome extension. The extension gets a Google access token through
// chrome.identity; the API checks it with Google's userinfo endpoint and caches the answer.
import { createHash } from 'node:crypto';

export interface User { id: string; email: string }

export type Verifier = (token: string) => Promise<User | null>;

export function googleVerifier(fetchImpl: typeof fetch = fetch, ttlMs = 5 * 60_000): Verifier {
  const cache = new Map<string, { user: User | null; until: number }>();
  return async (token) => {
    const key = createHash('sha256').update(token).digest('hex');
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.user;
    const res = await fetchImpl('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    let user: User | null = null;
    if (res.ok) {
      const b = (await res.json()) as { sub?: string; email?: string; email_verified?: boolean };
      if (b.sub && b.email && b.email_verified !== false) user = { id: `google:${b.sub}`, email: b.email.toLowerCase() };
    }
    cache.set(key, { user, until: Date.now() + (user ? ttlMs : 30_000) });
    if (cache.size > 1000) cache.delete(cache.keys().next().value!);
    return user;
  };
}

/** Comma-separated list; empty means nobody (fail closed). "*" allows any verified Google account. */
export function emailAllowed(email: string, allowList: string): boolean {
  const list = allowList.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes('*') || list.includes(email.toLowerCase());
}
