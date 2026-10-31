// "Try it" page and endpoint: upload your photo + garment images, get a try-on back.
// Guarded by an access code and a daily limit; photos are used for the one request and not stored.
import { timingSafeEqual } from 'node:crypto';
import type { ImageGenerator, Reasoner } from '@stylist/model-gateway';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { GarmentInput } from './outfit.js';
import { MAX_CANDIDATES, NothingToWearError, runTryOn, type PipelineDeps, type TryOnOutcome } from './pipeline.js';
import { TRY_PAGE } from './try-page.js';

/** Settings shared by both try-on routes. */
export interface PipelineSettings {
  generator: ImageGenerator | null;
  /** Vision model for the decision and check steps; null = title rules, no checks. */
  reasoner?: Reasoner | null;
  /** Check each pass and retry once on failure (default true when a reasoner is set). */
  check?: boolean;
  /** Most re-renders per try-on (default 2). */
  maxRetries?: number;
}

export interface TryOnDeps extends PipelineSettings {
  /** 'unset' or empty disables the endpoint (fail closed). */
  accessCode: string;
  dailyLimit: number;
  /** Most garments per try-on (tunable 1–7). Each garment is one render pass. */
  maxGarments: number;
  now?: () => Date;
}

export function clampGarments(n: number): number {
  return Math.min(7, Math.max(1, Math.floor(Number.isFinite(n) ? n : 3)));
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

/**
 * Garments arrive as a plain image (base64) or { images: [base64...], title } with several candidate
 * photos of one product. Returns an error message for the user, or the parsed garments.
 */
export function parseGarments(raw: unknown, max: number): GarmentInput[] | string {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length === 0 || list.length > max) return `Pick 1 to ${max} items to try on.`;
  const out: GarmentInput[] = [];
  for (const g of list) {
    const obj = typeof g === 'string' ? { images: [g] } : (g ?? {}) as { images?: unknown; title?: unknown };
    const imgs = Array.isArray(obj.images) ? obj.images.slice(0, MAX_CANDIDATES).map(decodeImage) : [];
    const valid = imgs.filter((b): b is Buffer => b !== null);
    if (valid.length === 0) return 'Each item needs a JPEG, PNG or WebP image (max 2 MB).';
    out.push({ images: valid, ...(typeof obj.title === 'string' ? { title: obj.title.slice(0, 300) } : {}) });
  }
  return out;
}

export function pipelineDeps(s: PipelineSettings & { generator: ImageGenerator }, log: FastifyBaseLogger): PipelineDeps {
  return {
    generator: s.generator,
    reasoner: s.reasoner ?? null,
    check: s.check ?? true,
    maxRetries: s.maxRetries ?? 2,
    log,
  };
}

export function outcomeBody(r: TryOnOutcome, remainingToday: number) {
  return {
    image: `data:image/jpeg;base64,${r.image.toString('base64')}`,
    latencyMs: r.latencyMs,
    estimatedCostUsd: r.estimatedCostUsd,
    remainingToday,
    passes: r.passes,
    notes: r.notes,
  };
}

export { NothingToWearError };

export function registerTryOn(app: FastifyInstance, deps: TryOnDeps, limiter: DailyLimiter): void {

  app.get('/try', async (_req, reply) => {
    reply.header('content-security-policy',
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
    return reply.type('text/html; charset=utf-8').send(TRY_PAGE);
  });

  // Public settings the page and the extension read on start.
  app.get('/v1/config', async () => ({ maxGarments: clampGarments(deps.maxGarments), dailyLimit: limiter.limit }));

  app.post('/v1/try-on', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!codeMatches(body.code, deps.accessCode)) return reply.code(401).send({ error: 'Wrong or missing access code.' });
    if (!deps.generator) return reply.code(503).send({ error: 'Try-on is not configured on this server.' });

    const person = decodeImage(body.person);
    if (!person) return reply.code(400).send({ error: 'Add a JPEG, PNG or WebP photo of yourself (max 2 MB).' });
    const garments = parseGarments(body.garments, clampGarments(deps.maxGarments));
    if (typeof garments === 'string') return reply.code(400).send({ error: garments });

    if (!limiter.take()) return reply.code(429).send({ error: `Daily limit of ${limiter.limit} try-ons reached. Try again tomorrow.` });

    const note = typeof body.note === 'string' ? body.note : '';
    try {
      const r = await runTryOn(pipelineDeps({ ...deps, generator: deps.generator }, req.log), person, garments, note);
      req.log.info({ latencyMs: r.latencyMs, costUsd: r.estimatedCostUsd, passes: r.passes }, 'try-on done');
      return outcomeBody(r, limiter.remaining());
    } catch (err) {
      limiter.giveBack(); // failed renders don't count
      if (err instanceof NothingToWearError) return reply.code(400).send({ error: err.message });
      req.log.error({ err: String(err).slice(0, 300) }, 'try-on failed');
      return reply.code(502).send({ error: 'The image model failed. Please try again in a minute.' });
    }
  });
}
