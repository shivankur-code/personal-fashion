// "Try it" page and endpoint: upload your photo + 1–3 garment images, get a FLUX.2 try-on back.
// Guarded by an access code and a daily limit; photos are used for the one request and not stored.
import { timingSafeEqual } from 'node:crypto';
import type { ImageGenerator } from '@stylist/model-gateway';
import type { FastifyInstance } from 'fastify';
import { TRY_PAGE } from './try-page.js';

export interface TryOnDeps {
  generator: ImageGenerator | null;
  /** 'unset' or empty disables the endpoint (fail closed). */
  accessCode: string;
  dailyLimit: number;
  now?: () => Date;
}

/** One counter per API copy, shared by the /try page and the extension. Failed renders are given back. */
export interface DailyLimiter { take(): boolean; giveBack(): void; remaining(): number; limit: number }

export function createDailyLimiter(limit: number, now: () => Date = () => new Date()): DailyLimiter {
  let day = '';
  let used = 0;
  const roll = () => { const d = now().toISOString().slice(0, 10); if (d !== day) { day = d; used = 0; } };
  return {
    limit,
    take() { roll(); if (used >= limit) return false; used++; return true; },
    giveBack() { used = Math.max(0, used - 1); },
    remaining() { roll(); return limit - used; },
  };
}

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export function decodeImage(b64: unknown): Buffer | null {
  if (typeof b64 !== 'string' || b64.length === 0) return null;
  const clean = b64.replace(/^data:image\/(jpeg|png|webp);base64,/, '');
  const buf = Buffer.from(clean, 'base64');
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const isWebp = buf.subarray(8, 12).toString('ascii') === 'WEBP';
  return isJpeg || isPng || isWebp ? buf : null;
}

export function codeMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || expected === '' || expected === 'unset') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildPrompt(garments: number, note: string): string {
  const refs = garments === 1 ? 'the garment from image 2' : `the garments from images 2 to ${garments + 1}`;
  const safeNote = note.replace(/[^\p{L}\p{N} ,.'-]/gu, '').slice(0, 200);
  return `Dress the person from image 1 in ${refs}. `
    + 'Keep the person\'s face, hair, skin tone, body shape and pose exactly the same, and keep the background. '
    + 'Replace only the clothing those garments cover; keep everything else the person wears. '
    + 'Match each garment\'s colour, fabric, pattern and details exactly. Full-length, photorealistic.'
    + (safeNote ? ` Styling note: ${safeNote}.` : '');
}

export function registerTryOn(app: FastifyInstance, deps: TryOnDeps, limiter: DailyLimiter): void {

  app.get('/try', async (_req, reply) => {
    reply.header('content-security-policy',
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
    return reply.type('text/html; charset=utf-8').send(TRY_PAGE);
  });

  app.post('/v1/try-on', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!codeMatches(body.code, deps.accessCode)) return reply.code(401).send({ error: 'Wrong or missing access code.' });
    if (!deps.generator) return reply.code(503).send({ error: 'Try-on is not configured on this server.' });

    const person = decodeImage(body.person);
    const garmentsIn = Array.isArray(body.garments) ? body.garments.slice(0, 3) : [];
    const garments = garmentsIn.map(decodeImage);
    if (!person) return reply.code(400).send({ error: 'Add a JPEG, PNG or WebP photo of yourself (max 2 MB).' });
    if (garments.length === 0 || garments.some((g) => g === null)) {
      return reply.code(400).send({ error: 'Add 1 to 3 garment images (JPEG, PNG or WebP, max 2 MB each).' });
    }

    if (!limiter.take()) return reply.code(429).send({ error: `Daily limit of ${limiter.limit} try-ons reached. Try again tomorrow.` });

    const note = typeof body.note === 'string' ? body.note : '';
    try {
      const r = await deps.generator.generate({
        model: 'FLUX.2-pro',
        prompt: buildPrompt(garments.length, note),
        references: [person, ...(garments as Buffer[])].map((b) => b.toString('base64')),
        width: 768,
        height: 1024,
      });
      req.log.info({ latencyMs: r.latencyMs, costUsd: r.estimatedCostUsd, garments: garments.length }, 'try-on done');
      return {
        image: `data:image/jpeg;base64,${r.image.toString('base64')}`,
        latencyMs: r.latencyMs,
        estimatedCostUsd: r.estimatedCostUsd,
        remainingToday: limiter.remaining(),
      };
    } catch (err) {
      limiter.giveBack(); // failed renders don't count
      req.log.error({ err: String(err).slice(0, 300) }, 'try-on failed');
      return reply.code(502).send({ error: 'The image model failed. Please try again in a minute.' });
    }
  });
}
