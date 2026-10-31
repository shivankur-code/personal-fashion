// Try-on pipeline.
//   1. Decide (one free vision call): read the shopper's body from their photo, pick the best photo
//      per product, classify and describe it, give a verdict per item and styling for the occasion.
//   2. Render. Mode 'oneshot' (default): one image call with all items in dressing order. Mode
//      'per-item': one call per item, each built on the previous result.
//   3. Check the result (same person? same body? every item worn?) and regenerate only when it fails.
// The vision model is optional: when it is missing or busy, title rules decide and checks are skipped.
import { createHash } from 'node:crypto';
import { checkModels, classifyModels, type ImageGenerator, type ImageInput, type Reasoner } from '@stylist/model-gateway';
import {
  CHECK_SCHEMA, CHECK_SYSTEM, DECIDE_SCHEMA, DECIDE_SYSTEM, decideUserText, OUTFIT_CHECK_SCHEMA, OUTFIT_CHECK_SYSTEM,
  outfitPrompt, parseAdvice, parseCheck, parseDecisions, parseOutfitCheck, passPrompt, planOutfit, ruleDecision,
  type Category, type CheckResult, type Decision, type GarmentInput, type OutfitAdvice, type OutfitCheck, type ShopperProfile,
} from './outfit.js';

export type TryOnMode = 'oneshot' | 'per-item';

export interface PipelineDeps {
  generator: ImageGenerator;
  reasoner: Reasoner | null;
  /** Check results with the vision model and regenerate on failure. */
  check: boolean;
  /** Most re-renders per try-on (each costs one image). */
  maxRetries: number;
  mode?: TryOnMode;
  env?: Record<string, string | undefined>;
  log?: { info(o: object, m: string): void; warn(o: object, m: string): void };
}

export interface TryOnContext {
  /** Occasion and the shopper's own note. */
  note: string;
  /** Saved profile (extension only); typed values win over what the model sees. */
  profile?: ShopperProfile | null;
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
  mode: TryOnMode;
  /** Image calls made, including regenerations. */
  renders: number;
  passes: PassReport[];
  notes: string[];
  /** Stylist output from the decision step: per-item verdicts and how to wear the outfit. */
  advice: { item: number; verdict: string }[];
  styling: string;
}

/** The decision call sees at most this many photos in total, including the shopper's. */
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
  const room = MAX_DECIDE_PHOTOS - 1; // one slot is the shopper's photo
  const per = Math.max(1, Math.min(MAX_CANDIDATES, Math.floor(room / Math.max(1, garments.length))));
  return garments.map((g) => ({ ...g, images: g.images.slice(0, per) }));
}

export async function runTryOn(deps: PipelineDeps, person: Buffer, garmentsIn: GarmentInput[], ctx: TryOnContext): Promise<TryOnOutcome> {
  const started = Date.now();
  const env = deps.env ?? process.env;
  const mode = deps.mode ?? 'oneshot';
  const garments = trimCandidates(garmentsIn);
  const profile = ctx.profile ?? null;
  const cost = { usd: 0 };

  // 1. Decide.
  let decisions = garments.map(ruleDecision);
  let advice: OutfitAdvice = { body: null, styling: '', verdicts: garments.map(() => '') };
  if (deps.reasoner) {
    // A reasoning model can spend its whole budget thinking (seen live with 5 items: empty answer,
    // finish_reason=length). So the budget grows with the item count, and on failure we ask once
    // more starting from the next model in the list.
    const m = classifyModels(env);
    const all = [m.model, ...m.fallbackModels];
    for (const list of [all, all.slice(1)]) {
      if (list.length === 0) break;
      try {
        const r = await deps.reasoner.reason({
          model: list[0]!, fallbackModels: list.slice(1), reasoningEffort: 'low', temperature: 0,
          system: DECIDE_SYSTEM, user: decideUserText(garments, { note: ctx.note, profile }),
          images: [person, ...garments.flatMap((g) => g.images)].map(asInput),
          jsonSchema: DECIDE_SCHEMA, maxOutputTokens: Math.min(10_000, 3000 + 1000 * garments.length),
        }, AbortSignal.timeout(80_000));
        decisions = parseDecisions(r.json, garments);
        advice = parseAdvice(r.json, garments.length);
        cost.usd += r.usage.costUsd ?? 0;
        deps.log?.info({
          model: r.model, latencyMs: r.latencyMs, body: advice.body,
          decisions: decisions.map((d) => [d.category, d.image, d.wornByModel]),
        }, 'try-on decided');
        break;
      } catch (err) {
        deps.log?.warn({ model: list[0], err: String(err).slice(0, 200) }, 'decision model failed');
      }
    }
    if (decisions.every((d) => d.source === 'rules')) deps.log?.warn({}, 'decision model unavailable; using title rules');
  }

  const { passes, notes } = planOutfit(decisions);
  if (passes.length === 0) throw new NothingToWearError('None of the picked items look like clothing.');
  const chosen = passes.map((p) => garments[p.index]!.images[p.decision.image]!);
  const seed = seedFor([person, ...chosen]);
  const checking = deps.check && deps.reasoner !== null;

  const render = async (prompt: string, refs: Buffer[], s: number) => {
    const r = await deps.generator.generate({
      model: 'FLUX.2-pro', prompt, width: 768, height: 1024, seed: s, references: refs.map((b) => b.toString('base64')),
    });
    cost.usd += r.estimatedCostUsd;
    return r.image;
  };

  let image: Buffer;
  let renders = 0;
  const reports: PassReport[] = [];

  if (mode === 'oneshot') {
    // 2. One image call with every item; 3. check, and regenerate only when the check fails.
    const items = passes.map((p) => p.decision);
    const promptFor = (retryReason?: string) => outfitPrompt(items, {
      body: advice.body, profile, styling: advice.styling, note: ctx.note, ...(retryReason ? { retryReason } : {}),
    });
    image = await render(promptFor(), [person, ...chosen], seed); renders++;
    let result = checking ? await checkOutfit(deps, env, person, image, chosen, cost) : null;
    let retried = false;
    for (let attempt = 1; result && !result.ok && attempt <= deps.maxRetries; attempt++) {
      retried = true;
      const reason = result.reason || describeFailure(result);
      deps.log?.info({ attempt, reason, missing: result.missing }, 'try-on rejected; regenerating');
      image = await render(promptFor(reason), [person, ...chosen], seed + attempt); renders++;
      result = await checkOutfit(deps, env, person, image, chosen, cost);
    }
    if (result && !result.ok) notes.push(`The picture may not match exactly: ${result.reason || describeFailure(result)}.`);
    passes.forEach((p, i) => reports.push({
      item: p.index + 1, category: p.decision.category, decidedBy: p.decision.source, retried,
      check: result === null ? 'skipped' : result.missing.includes(i + 1) || !result.samePerson || !result.bodyKept ? 'failed' : 'passed',
    }));
  } else {
    // Per item: each call adds one item to the previous result; later calls also get the original photo.
    let current = person;
    let retriesLeft = checking ? deps.maxRetries : 0;
    for (const [i, p] of passes.entries()) {
      const garment = chosen[i]!;
      const anchor = i > 0;
      const refs = anchor ? [current, garment, person] : [current, garment];
      const promptFor = (retryReason?: string) => passPrompt(p.decision, {
        anchor, note: ctx.note, body: advice.body, profile, ...(retryReason ? { retryReason } : {}),
      });
      let step = await render(promptFor(), refs, seed + i * 101); renders++;
      let check: PassReport['check'] = 'skipped';
      let retried = false;
      if (checking) {
        let result = await checkPass(deps, env, person, step, garment, cost);
        if (result && !result.ok && retriesLeft > 0) {
          retriesLeft--; retried = true;
          deps.log?.info({ pass: i + 1, reason: result.reason }, 'try-on pass rejected; retrying');
          step = await render(promptFor(result.reason || (result.samePerson ? 'the item was not applied correctly' : 'the face changed')), refs, seed + i * 101 + 1);
          renders++;
          result = await checkPass(deps, env, person, step, garment, cost);
        }
        check = result === null ? 'skipped' : result.ok ? 'passed' : 'failed';
        if (result && !result.ok) notes.push(`Item ${p.index + 1} (${p.decision.category}) may not match exactly: ${result.reason || 'check failed'}.`);
      }
      reports.push({ item: p.index + 1, category: p.decision.category, decidedBy: p.decision.source, check, retried });
      current = step;
    }
    image = current;
  }

  return {
    image, mode, renders, passes: reports, notes,
    estimatedCostUsd: Math.round(cost.usd * 10_000) / 10_000,
    latencyMs: Date.now() - started,
    advice: advice.verdicts.map((verdict, i) => ({ item: i + 1, verdict })).filter((a) => a.verdict),
    styling: advice.styling,
  };
}

function describeFailure(r: OutfitCheck): string {
  return [
    r.samePerson ? '' : 'the face or hair changed',
    r.bodyKept ? '' : 'the body shape or height changed',
    r.missing.length ? `item ${r.missing.join(', ')} is missing or wrong` : '',
  ].filter(Boolean).join('; ');
}

async function checkOutfit(
  deps: PipelineDeps, env: Record<string, string | undefined>, original: Buffer, result: Buffer, items: Buffer[], cost: { usd: number },
): Promise<OutfitCheck | null> {
  const m = checkModels(env);
  try {
    const r = await deps.reasoner!.reason({
      model: m.model, fallbackModels: m.fallbackModels, reasoningEffort: 'low', temperature: 0,
      system: OUTFIT_CHECK_SYSTEM, user: `Check this try-on. There are ${items.length} items.`,
      images: [original, result, ...items].map(asInput),
      jsonSchema: OUTFIT_CHECK_SCHEMA, maxOutputTokens: 2000,
    }, AbortSignal.timeout(45_000));
    cost.usd += r.usage.costUsd ?? 0;
    return parseOutfitCheck(r.json, items.length);
  } catch (err) {
    deps.log?.warn({ err: String(err).slice(0, 200) }, 'check model unavailable; result accepted unchecked');
    return null;
  }
}

async function checkPass(
  deps: PipelineDeps, env: Record<string, string | undefined>, original: Buffer, result: Buffer, garment: Buffer, cost: { usd: number },
): Promise<CheckResult | null> {
  const m = checkModels(env);
  try {
    const r = await deps.reasoner!.reason({
      model: m.model, fallbackModels: m.fallbackModels, reasoningEffort: 'low', temperature: 0,
      system: CHECK_SYSTEM, user: 'Check this try-on.',
      images: [original, result, garment].map(asInput),
      jsonSchema: CHECK_SCHEMA, maxOutputTokens: 1000,
    }, AbortSignal.timeout(45_000));
    cost.usd += r.usage.costUsd ?? 0;
    return parseCheck(r.json);
  } catch (err) {
    deps.log?.warn({ err: String(err).slice(0, 200) }, 'check model unavailable; pass accepted unchecked');
    return null;
  }
}
