// Try-on pipeline: decide (pick photo + category per product) → render one garment per pass →
// check each pass (same person? item worn?) and retry once. The decision and check models are
// optional: if they are missing or fail, the pipeline falls back to title rules and skips checks,
// so a try-on still works when the free model pool is busy.
import { createHash } from 'node:crypto';
import { checkModels, classifyModels, type ImageGenerator, type ImageInput, type Reasoner } from '@stylist/model-gateway';
import {
  CHECK_SCHEMA, CHECK_SYSTEM, DECIDE_SCHEMA, DECIDE_SYSTEM, decideUserText, parseCheck, parseDecisions, passPrompt,
  planOutfit, ruleDecision, type Category, type CheckResult, type Decision, type GarmentInput,
} from './outfit.js';

export interface PipelineDeps {
  generator: ImageGenerator;
  reasoner: Reasoner | null;
  /** Check every pass with the vision model and retry once when it fails. */
  check: boolean;
  /** Most re-renders per try-on (each costs one image). */
  maxRetries: number;
  env?: Record<string, string | undefined>;
  log?: { info(o: object, m: string): void; warn(o: object, m: string): void };
}

export interface PassReport {
  item: number;
  category: Category;
  decidedBy: Decision['source'];
  check: 'passed' | 'failed' | 'skipped';
  retried: boolean;
}

export interface TryOnOutcome {
  image: Buffer;
  estimatedCostUsd: number;
  latencyMs: number;
  passes: PassReport[];
  notes: string[];
}

/** The decision call sees at most this many photos in total (free models handle about this many). */
export const MAX_DECIDE_PHOTOS = 12;
export const MAX_CANDIDATES = 4;

export class NothingToWearError extends Error {}

function mediaType(b: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}
const asInput = (b: Buffer): ImageInput => ({ kind: 'base64', mediaType: mediaType(b), data: b.toString('base64') });

/** Same inputs give the same seed, so repeating a try-on gives the same picture. */
export function seedFor(parts: Buffer[]): number {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest().readUInt32BE(0) & 0x7fffffff;
}

/** Fewer candidate photos per product when many products are picked, so one call can see them all. */
export function trimCandidates(garments: GarmentInput[]): GarmentInput[] {
  const per = Math.max(1, Math.min(MAX_CANDIDATES, Math.floor(MAX_DECIDE_PHOTOS / Math.max(1, garments.length))));
  return garments.map((g) => ({ ...g, images: g.images.slice(0, per) }));
}

export async function runTryOn(deps: PipelineDeps, person: Buffer, garmentsIn: GarmentInput[], note: string): Promise<TryOnOutcome> {
  const started = Date.now();
  const env = deps.env ?? process.env;
  const garments = trimCandidates(garmentsIn);
  let cost = 0;

  // 1. Decide. Single-photo products with a recognisable title still go to the model when one is
  //    configured, because its description makes the render more faithful.
  let decisions = garments.map(ruleDecision);
  if (deps.reasoner) {
    // A reasoning model can spend its whole budget thinking (seen live with 5 items: empty answer,
    // finish_reason=length). So: budget grows with the item count, and on failure we ask once more
    // starting from the next model in the list.
    const m = classifyModels(env);
    const all = [m.model, ...m.fallbackModels];
    for (const list of [all, all.slice(1)]) {
      if (list.length === 0) break;
      try {
        const r = await deps.reasoner.reason({
          model: list[0]!, fallbackModels: list.slice(1), reasoningEffort: 'low', temperature: 0,
          system: DECIDE_SYSTEM, user: decideUserText(garments),
          images: garments.flatMap((g) => g.images.map(asInput)),
          jsonSchema: DECIDE_SCHEMA, maxOutputTokens: Math.min(8000, 2000 + 1000 * garments.length),
        }, AbortSignal.timeout(45_000));
        decisions = parseDecisions(r.json, garments);
        cost += r.usage.costUsd ?? 0;
        deps.log?.info({ model: r.model, latencyMs: r.latencyMs, decisions: decisions.map((d) => [d.category, d.image, d.wornByModel]) }, 'try-on decided');
        break;
      } catch (err) {
        deps.log?.warn({ model: list[0], err: String(err).slice(0, 200) }, 'decision model failed');
      }
    }
    if (decisions.every((d) => d.source === 'rules')) deps.log?.warn({}, 'decision model unavailable; using title rules');
  }

  const { passes, notes } = planOutfit(decisions);
  if (passes.length === 0) throw new NothingToWearError('None of the picked items look like clothing.');

  // 2. Render one garment per pass; 3. check and retry.
  const chosen = passes.map((p) => garments[p.index]!.images[p.decision.image]!);
  const seed = seedFor([person, ...chosen]);
  let current = person;
  let retriesLeft = deps.check && deps.reasoner ? deps.maxRetries : 0;
  const reports: PassReport[] = [];

  for (const [i, p] of passes.entries()) {
    const garment = chosen[i]!;
    const anchor = i > 0;
    const render = async (attempt: number, retryReason?: string) => {
      const prompt = passPrompt(p.decision, { anchor, note, ...(retryReason ? { retryReason } : {}) });
      const r = await deps.generator.generate({
        model: 'FLUX.2-pro', prompt, width: 768, height: 1024, seed: seed + i * 101 + attempt,
        references: (anchor ? [current, garment, person] : [current, garment]).map((b) => b.toString('base64')),
      });
      cost += r.estimatedCostUsd;
      return r.image;
    };

    let image = await render(0);
    let check: PassReport['check'] = 'skipped';
    let retried = false;
    if (deps.check && deps.reasoner) {
      let result = await checkPass(deps, env, person, image, garment, (c) => { cost += c; });
      if (result && !result.ok && retriesLeft > 0) {
        retriesLeft--; retried = true;
        deps.log?.info({ pass: i + 1, reason: result.reason }, 'try-on pass rejected; retrying');
        image = await render(1, result.reason || (result.samePerson ? 'the item was not applied correctly' : 'the face changed'));
        result = await checkPass(deps, env, person, image, garment, (c) => { cost += c; });
      }
      check = result === null ? 'skipped' : result.ok ? 'passed' : 'failed';
      if (result && !result.ok) {
        notes.push(`Item ${p.index + 1} (${p.decision.category}) may not match exactly: ${result.reason || 'check failed'}.`);
      }
    }
    reports.push({ item: p.index + 1, category: p.decision.category, decidedBy: p.decision.source, check, retried });
    current = image;
  }

  return { image: current, estimatedCostUsd: Math.round(cost * 10_000) / 10_000, latencyMs: Date.now() - started, passes: reports, notes };
}

async function checkPass(
  deps: PipelineDeps, env: Record<string, string | undefined>,
  original: Buffer, result: Buffer, garment: Buffer, addCost: (c: number) => void,
): Promise<CheckResult | null> {
  const m = checkModels(env);
  try {
    const r = await deps.reasoner!.reason({
      model: m.model, fallbackModels: m.fallbackModels, reasoningEffort: 'low', temperature: 0,
      system: CHECK_SYSTEM, user: 'Check this try-on.',
      images: [original, result, garment].map(asInput),
      jsonSchema: CHECK_SCHEMA, maxOutputTokens: 1000,
    }, AbortSignal.timeout(45_000));
    addCost(r.usage.costUsd ?? 0);
    return parseCheck(r.json);
  } catch (err) {
    deps.log?.warn({ err: String(err).slice(0, 200) }, 'check model unavailable; pass accepted unchecked');
    return null;
  }
}
