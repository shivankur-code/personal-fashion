import type { GenerateRequest, ImageGenerator } from '@stylist/model-gateway';
import { describe, expect, it } from 'vitest';
import { emailAllowed, googleVerifier, type Verifier } from '../src/auth.js';
import { MemoryBlobStore } from '../src/blob.js';
import { userKey } from '../src/me.js';
import { buildServer } from '../src/server.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50, 7)]).toString('base64');
const me = { id: 'google:123', email: 'me@example.com' };
const verifier: Verifier = async (t) => (t === 'good-token' ? me : t === 'other-token' ? { id: 'google:9', email: 'x@y.z' } : null);

function setup(opts: { allowed?: string } = {}) {
  const blobs = new MemoryBlobStore();
  const calls: GenerateRequest[] = [];
  const generator: ImageGenerator = {
    provider: 'fake',
    async generate(req) { calls.push(req); return { image: Buffer.from([0xff, 0xd8, 9]), model: req.model, latencyMs: 1, estimatedCostUsd: 0.06, responseKeys: [] }; },
  };
  const app = buildServer({
    pool: null, version: 't', logger: false,
    tryOn: { generator, accessCode: 'code-1', dailyLimit: 2, maxGarments: 3 },
    me: { verifier, allowedEmails: opts.allowed ?? 'me@example.com', accessCode: 'code-1', blobs, generator, maxGarments: 3 },
  });
  return { app, blobs, calls };
}
const auth = { authorization: 'Bearer good-token' };

describe('signed-in routes', () => {
  it('requires a valid Google token', async () => {
    const { app } = setup();
    expect((await app.inject({ url: '/v1/me' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/me', headers: { authorization: 'Bearer bad' } })).statusCode).toBe(401);
  });

  it('rejects verified accounts that are not on the access list', async () => {
    const { app } = setup();
    const r = await app.inject({ url: '/v1/me', headers: { authorization: 'Bearer other-token' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toContain('x@y.z');
  });

  it('accepts the access code as a fallback', async () => {
    const { app } = setup();
    expect((await app.inject({ url: '/v1/me', headers: { 'x-access-code': 'code-1' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/me', headers: { 'x-access-code': 'nope' } })).statusCode).toBe(401);
  });

  it('saves the profile and photo under a hashed user key, never the email', async () => {
    const { app, blobs } = setup();
    expect((await app.inject({ method: 'PUT', url: '/v1/me/profile', headers: auth, payload: { heightCm: 20 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/v1/me/profile', headers: auth, payload: { heightCm: 178, styles: ['classic'], fit: 'slim' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/v1/me/photo', headers: auth, payload: { photo: JPEG } })).statusCode).toBe(200);
    const keys = [...blobs.items.keys()];
    expect(keys).toEqual([`exports/profiles/${userKey(me)}.json`, `photos/${userKey(me)}/person.jpg`]);
    expect(keys.join()).not.toContain('example.com');
    const r = (await app.inject({ url: '/v1/me', headers: auth })).json();
    expect(r).toMatchObject({ email: 'me@example.com', hasPhoto: true, profile: { heightCm: 178, fit: 'slim' } });
  });

  it('try-on needs the saved photo, then sends it first with the garments and the occasion', async () => {
    const { app, calls } = setup();
    const body = { garments: [JPEG, JPEG], occasion: 'office', prompt: 'smart casual' };
    expect((await app.inject({ method: 'POST', url: '/v1/me/try-on', headers: auth, payload: body })).statusCode).toBe(409);
    await app.inject({ method: 'PUT', url: '/v1/me/photo', headers: auth, payload: { photo: JPEG } });
    const r = await app.inject({ method: 'POST', url: '/v1/me/try-on', headers: auth, payload: body });
    expect(r.statusCode).toBe(200);
    expect(calls[0]!.references![0]).toBe(JPEG);
    expect(calls[0]!.references).toHaveLength(3);
    expect(calls[0]!.prompt).toContain('outfit for office, smart casual');
  });

  it('shares the daily limit with the /try page', async () => {
    const { app } = setup();
    await app.inject({ method: 'PUT', url: '/v1/me/photo', headers: auth, payload: { photo: JPEG } });
    const one = { garments: [JPEG] };
    expect((await app.inject({ method: 'POST', url: '/v1/try-on', payload: { code: 'code-1', person: JPEG, ...one } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/me/try-on', headers: auth, payload: one })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/me/try-on', headers: auth, payload: one })).statusCode).toBe(429);
  });
});

describe('Google verifier', () => {
  it('maps userinfo to a user, caches it, and refuses unverified emails', async () => {
    let calls = 0;
    const fakeFetch = (async (_u: string, init: RequestInit) => {
      calls++;
      const tok = (init.headers as Record<string, string>).authorization;
      if (tok === 'Bearer ok') return new Response(JSON.stringify({ sub: '42', email: 'A@B.com', email_verified: true }));
      if (tok === 'Bearer unverified') return new Response(JSON.stringify({ sub: '43', email: 'c@d.com', email_verified: false }));
      return new Response('nope', { status: 401 });
    }) as unknown as typeof fetch;
    const v = googleVerifier(fakeFetch);
    expect(await v('ok')).toEqual({ id: 'google:42', email: 'a@b.com' });
    expect(await v('ok')).toEqual({ id: 'google:42', email: 'a@b.com' });
    expect(calls).toBe(1);
    expect(await v('unverified')).toBeNull();
    expect(await v('bad')).toBeNull();
  });

  it('access list: exact emails, "*" for anyone, empty for nobody', () => {
    expect(emailAllowed('Me@Example.com', 'me@example.com, other@x.com')).toBe(true);
    expect(emailAllowed('me@example.com', '*')).toBe(true);
    expect(emailAllowed('me@example.com', '')).toBe(false);
  });
});
