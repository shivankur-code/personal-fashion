// Signed-in routes for the Chrome extension: profile, photo (kept in our storage), try-on.
// Auth: "Authorization: Bearer <Google access token>", or "x-access-code" as a dev fallback
// while the Google OAuth client is being set up.
import { createHash } from 'node:crypto';
import { Occasion, Profile } from '@stylist/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { emailAllowed, type User, type Verifier } from './auth.js';
import type { BlobStore } from './blob.js';
import { runTryOn } from './pipeline.js';
import {
  clampGarments, codeMatches, decodeImage, NothingToWearError, outcomeBody, parseGarments, pipelineDeps,
  type DailyLimiter, type PipelineSettings,
} from './try-on.js';

export interface MeDeps extends PipelineSettings {
  verifier: Verifier;
  allowedEmails: string;
  accessCode: string;
  blobs: BlobStore | null;
  maxGarments: number;
}

/** Storage paths use a hash of the user ID, never the email. */
export function userKey(user: User): string {
  return createHash('sha256').update(user.id).digest('hex').slice(0, 32);
}

export function registerMe(app: FastifyInstance, deps: MeDeps, limiter: DailyLimiter): void {
  async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<User | null> {
    const code = req.headers['x-access-code'];
    if (typeof code === 'string' && codeMatches(code, deps.accessCode)) return { id: 'access-code:owner', email: 'owner@access-code' };
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    const user = token ? await deps.verifier(token).catch(() => null) : null;
    if (!user) { await reply.code(401).send({ error: 'Please sign in again.' }); return null; }
    if (!emailAllowed(user.email, deps.allowedEmails)) {
      await reply.code(403).send({ error: `${user.email} is not on the access list yet.` });
      return null;
    }
    return user;
  }

  function storage(reply: FastifyReply): BlobStore | null {
    if (!deps.blobs) { void reply.code(503).send({ error: 'Storage is not configured on this server.' }); return null; }
    return deps.blobs;
  }

  app.get('/v1/me', async (req, reply) => {
    const user = await authenticate(req, reply); if (!user) return reply;
    const blobs = storage(reply); if (!blobs) return reply;
    const key = userKey(user);
    const [profile, photo] = await Promise.all([blobs.get(`exports/profiles/${key}.json`), blobs.get(`photos/${key}/person.jpg`)]);
    return {
      email: user.email,
      profile: profile ? JSON.parse(profile.toString('utf8')) as unknown : null,
      hasPhoto: photo !== null,
      remainingToday: limiter.remaining(),
      maxGarments: clampGarments(deps.maxGarments),
    };
  });

  app.put('/v1/me/profile', async (req, reply) => {
    const user = await authenticate(req, reply); if (!user) return reply;
    const parsed = Profile.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Profile is incomplete.', issues: parsed.error.issues.map((i) => i.path.join('.')) });
    const blobs = storage(reply); if (!blobs) return reply;
    await blobs.put(`exports/profiles/${userKey(user)}.json`, Buffer.from(JSON.stringify(parsed.data)), 'application/json');
    return { ok: true };
  });

  app.put('/v1/me/photo', { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const user = await authenticate(req, reply); if (!user) return reply;
    const photo = decodeImage((req.body as { photo?: unknown } | null)?.photo);
    if (!photo) return reply.code(400).send({ error: 'Add a JPEG, PNG or WebP photo (max 2 MB).' });
    const blobs = storage(reply); if (!blobs) return reply;
    await blobs.put(`photos/${userKey(user)}/person.jpg`, photo, 'image/jpeg');
    return { ok: true };
  });

  app.post('/v1/me/try-on', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const user = await authenticate(req, reply); if (!user) return reply;
    const blobs = storage(reply); if (!blobs) return reply;
    if (!deps.generator) return reply.code(503).send({ error: 'Try-on is not configured on this server.' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const garments = parseGarments(body.garments, clampGarments(deps.maxGarments));
    if (typeof garments === 'string') return reply.code(400).send({ error: garments });
    const occasion = Occasion.safeParse(body.occasion);
    const [person, savedProfile] = await Promise.all([
      blobs.get(`photos/${userKey(user)}/person.jpg`), blobs.get(`exports/profiles/${userKey(user)}.json`),
    ]);
    if (!person) return reply.code(409).send({ error: 'Add your full-length photo first (Profile tab).' });
    // Height, weight and fit go into the render prompt; a broken or old profile is simply ignored.
    const parsedProfile = savedProfile ? Profile.safeParse(JSON.parse(savedProfile.toString('utf8'))) : null;
    const profile = parsedProfile?.success ? parsedProfile.data : null;
    if (!limiter.take()) return reply.code(429).send({ error: `Daily limit of ${limiter.limit} try-ons reached. Try again tomorrow.` });

    const note = [occasion.success ? `outfit for ${occasion.data}` : '', typeof body.prompt === 'string' ? body.prompt : '']
      .filter(Boolean).join(', ');
    try {
      const r = await runTryOn(pipelineDeps({ ...deps, generator: deps.generator }, req.log), person, garments, { note, profile });
      req.log.info({ latencyMs: r.latencyMs, costUsd: r.estimatedCostUsd, mode: r.mode, renders: r.renders, passes: r.passes, hasProfile: profile !== null, via: 'extension' }, 'try-on done');
      return outcomeBody(r, limiter.remaining());
    } catch (err) {
      limiter.giveBack();
      if (err instanceof NothingToWearError) return reply.code(400).send({ error: err.message });
      req.log.error({ err: String(err).slice(0, 300) }, 'try-on failed');
      return reply.code(502).send({ error: 'The image model failed. Please try again in a minute.' });
    }
  });
}
