import type { GenerateRequest, ImageGenerator, Reasoner, ReasonRequest } from '@stylist/model-gateway';
import { describe, expect, it } from 'vitest';
import {
  bodyText, categoryFromTitle, decideUserText, outfitPrompt, parseAdvice, parseDecisions, parseOutfitCheck, planOutfit,
  type Decision,
} from '../src/outfit.js';
import { fingerprint, runTryOn, trimCandidates, type PipelineDeps } from '../src/pipeline.js';

// Distinct fake JPEGs so we can tell which photo was sent where.
const img = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50, n)]);
const b64 = (n: number) => img(n).toString('base64');
const PERSON = img(1);

function generator() {
  const calls: GenerateRequest[] = [];
  let n = 100;
  const g: ImageGenerator = {
    provider: 'fake',
    async generate(req) { calls.push(req); return { image: img(n++), model: req.model, latencyMs: 1, estimatedCostUsd: 0.06, responseKeys: [] }; },
  };
  return { g, calls };
}

const OK_ONESHOT = { same_person: true, body_kept: true, missing_items: [], reason: 'ok' };
const OK_PASS = { same_person: true, item_worn: true, reason: 'ok' };

/** Answers decision calls with `decide` and check calls with the next item of `checks`. */
function reasoner(decide: unknown, checks: unknown[] = []) {
  const calls: ReasonRequest[] = [];
  const r: Reasoner = {
    provider: 'fake',
    async reason(req) {
      calls.push(req);
      const isDecide = req.jsonSchema?.name === 'garment_decisions';
      const ans = isDecide ? decide : checks.length ? checks.shift() : req.jsonSchema?.name === 'outfit_check' ? OK_ONESHOT : OK_PASS;
      if (ans instanceof Error) throw ans;
      return { text: JSON.stringify(ans), json: ans, model: 'fake', latencyMs: 1, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
    },
  };
  return { r, calls };
}

const PERSON_CARD = {
  build: 'athletic', body_shape: 'inverted triangle', shoulders: 'broad, square', proportions: 'long legs',
  skin_tone: 'medium tan, warm', hair: 'long black hair tied back', face: 'light stubble', distinctive_features: 'tattoo on right forearm',
  current_outfit: 'white tee, beige chinos, brown boots',
};

const d = (category: Decision['category']): Decision => ({ image: 0, category, description: '', wornByModel: true, source: 'rules' });
const deps = (over: Partial<PipelineDeps>): PipelineDeps => ({ generator: generator().g, reasoner: null, check: true, maxRetries: 1, ...over });

describe('outfit rules', () => {
  it('classifies titles, preferring the more specific word', () => {
    expect(categoryFromTitle('Men Slim Fit Linen Blazer')).toBe('outerwear');
    expect(categoryFromTitle('Women Shirt Dress, Midi')).toBe('one-piece');
    expect(categoryFromTitle('Denim Jacket with shirt collar')).toBe('outerwear');
    expect(categoryFromTitle('Slim Fit Stretch Jeans')).toBe('bottom');
    expect(categoryFromTitle('Leather Derby Shoes')).toBe('shoes');
    expect(categoryFromTitle('Printed Cotton Kurta')).toBe('top');
    expect(categoryFromTitle('Stainless steel water bottle')).toBeNull();
  });

  it('dresses base layers first and explains clashes', () => {
    const { passes, notes } = planOutfit([d('outerwear'), d('top'), d('shoes'), d('bottom'), d('top'), d('not-clothing')]);
    expect(passes.map((p) => p.decision.category)).toEqual(['bottom', 'top', 'top', 'outerwear', 'shoes']);
    expect(passes.map((p) => p.index)).toEqual([3, 1, 4, 0, 2]);
    expect(notes.join(' ')).toContain('2 tops');
    expect(notes.join(' ')).toContain('Item 6 does not look like clothing');
  });

  it('numbers photos after the shopper photo and maps answers back, falling back per product', () => {
    const gs = [{ images: [img(2), img(3)], title: 'Blazer' }, { images: [img(4)], title: 'Chinos' }, { images: [img(5)], title: 'Tee' }];
    const text = decideUserText(gs, { note: 'office', profile: { heightCm: 178, fit: 'slim', undertone: 'cool' } });
    expect(text).toContain('Photo 1: the shopper.\nProduct 1: photos 2 to 3. Title: "Blazer".\nProduct 2: photo 4. Title: "Chinos".\nProduct 3: photo 5.');
    expect(text).toContain('Shopper says: height 178 cm; prefers slim fit; cool undertone.');
    expect(text).toContain('Occasion and note: "office".');
    const answer = { person: PERSON_CARD, styling: 'tee tucked, blazer open', products: [
      { product: 1, best_photo: 3, category: 'outerwear', worn_by_model: false, description: 'navy blazer', verdict: 'navy suits you' },
      { product: 2, best_photo: 9, category: 'weird', worn_by_model: true, description: 'x', verdict: '' },
    ] };
    const out = parseDecisions(answer, gs);
    expect(out[0]).toMatchObject({ image: 1, category: 'outerwear', wornByModel: false, source: 'model' });
    expect(out[1]).toMatchObject({ image: 0, category: 'bottom', source: 'model' }); // bad photo number and category repaired
    expect(out[2]).toMatchObject({ category: 'top', source: 'rules' }); // missing answer
    const advice = parseAdvice(answer, 3);
    expect(advice.body).toMatchObject({ build: 'athletic', distinctive: 'tattoo on right forearm' });
    expect(advice.verdicts).toEqual(['navy suits you', '', '']);
    expect(advice.styling).toBe('tee tucked, blazer open');
  });

  it('limits candidate photos so one decision call sees at most 12 including the shopper', () => {
    const many = Array.from({ length: 5 }, () => ({ images: [img(2), img(3), img(4), img(5)] }));
    expect(trimCandidates(many).map((g) => g.images.length)).toEqual([2, 2, 2, 2, 2]);
    expect(trimCandidates([{ images: [img(2), img(3), img(4), img(5)] }])[0]!.images).toHaveLength(4);
  });

  it('describes the body and fit for the image model, typed profile first', () => {
    const t = bodyText(parseAdvice({ person: PERSON_CARD }, 0).body, { heightCm: 178, weightKg: 74.6, fit: 'slim' });
    expect(t).toContain('The person is about 178 cm tall, about 75 kg, athletic, inverted triangle, broad, square, long legs.');
    expect(t).toContain('do not make them taller, shorter, slimmer, heavier or more muscular');
    expect(t).toContain('Identity to keep exactly: light stubble; long black hair tied back; medium tan, warm; tattoo on right forearm.');
    expect(t).toContain('Fit: slim');
    expect(bodyText(null, null)).toMatch(/^Fit: true to size/);
  });

  it('one-shot prompt lists items in order and keeps outerwear over the top', () => {
    const p = outfitPrompt([{ ...d('top'), description: 'white tee', wornByModel: false }, { ...d('outerwear'), description: 'navy blazer' }],
      { body: null, profile: null, styling: 'blazer open', note: 'office' });
    expect(p).toContain('image 2: top (white tee); image 3: outer layer (navy blazer), shown on a shop model.');
    expect(p).toContain('go OVER the top');
    expect(p).toContain("never that model's face");
    expect(p).toContain('Styling: blazer open. Styling note: office.');
  });

  it('reads the one-shot check, ignoring item numbers out of range', () => {
    expect(parseOutfitCheck({ same_person: true, body_kept: true, missing_items: [2, 9], reason: 'no jacket' }, 2))
      .toEqual({ ok: false, samePerson: true, bodyKept: true, missing: [2], reason: 'no jacket' });
    expect(parseOutfitCheck(OK_ONESHOT, 2)!.ok).toBe(true);
    expect(parseOutfitCheck({ same_person: 'yes' }, 2)).toBeNull();
  });
});

describe('try-on pipeline, one shot (default)', () => {
  const DECIDE = { person: PERSON_CARD, styling: 'tee tucked, blazer open', products: [
    { product: 1, best_photo: 3, category: 'outerwear', worn_by_model: false, description: 'navy linen blazer', verdict: 'navy suits warm skin' },
    { product: 2, best_photo: 4, category: 'top', worn_by_model: true, description: 'white tee', verdict: '' },
  ] };
  const GARMENTS = [{ images: [img(2), img(3)], title: 'Blazer' }, { images: [img(4)], title: 'Tee' }];

  it('makes one image call with all items in dressing order, body and fit in the prompt', async () => {
    const gen = generator();
    const llm = reasoner(DECIDE);
    const out = await runTryOn(deps({ generator: gen.g, reasoner: llm.r }), PERSON, GARMENTS,
      { note: 'office', profile: { heightCm: 178, fit: 'regular' } });
    expect(llm.calls[0]!.images![0]).toMatchObject({ data: PERSON.toString('base64') }); // shopper photo goes to the decision step
    expect(gen.calls).toHaveLength(1);
    expect(gen.calls[0]!.references).toEqual([PERSON.toString('base64'), b64(4), b64(3)]); // tee, then blazer photo 2
    expect(gen.calls[0]!.prompt).toContain('image 2: top (white tee), shown on a shop model; image 3: outer layer (navy linen blazer)');
    expect(gen.calls[0]!.prompt).toContain('about 178 cm tall');
    expect(gen.calls[0]!.prompt).toContain('tattoo on right forearm');
    expect(gen.calls[0]!.prompt).toContain('Styling: tee tucked, blazer open.');
    expect(out).toMatchObject({ mode: 'oneshot', renders: 1, styling: 'tee tucked, blazer open', advice: [{ item: 1, verdict: 'navy suits warm skin' }] });
    expect(out.passes.map((p) => [p.item, p.category, p.check])).toEqual([[2, 'top', 'passed'], [1, 'outerwear', 'passed']]);
    expect(out.estimatedCostUsd).toBeCloseTo(0.06);
  });

  it('regenerates only when the check fails, telling the model what was wrong', async () => {
    const gen = generator();
    const llm = reasoner(DECIDE, [{ same_person: false, body_kept: true, missing_items: [2], reason: 'face changed, no blazer' }, OK_ONESHOT]);
    const out = await runTryOn(deps({ generator: gen.g, reasoner: llm.r, maxRetries: 1 }), PERSON, GARMENTS, { note: '' });
    expect(gen.calls).toHaveLength(2);
    expect(gen.calls[1]!.seed).toBe(gen.calls[0]!.seed! + 1);
    expect(gen.calls[1]!.prompt).toContain('rejected because: face changed, no blazer');
    expect(out.renders).toBe(2);
    expect(out.image.equals(img(101))).toBe(true);
    expect(out.notes).toEqual([]);
  });

  it('stops at the retry budget and says what is still off', async () => {
    const gen = generator();
    const bad = { same_person: true, body_kept: false, missing_items: [], reason: '' };
    const llm = reasoner(DECIDE, [bad, bad, bad]);
    const out = await runTryOn(deps({ generator: gen.g, reasoner: llm.r, maxRetries: 1 }), PERSON, GARMENTS, { note: '' });
    expect(gen.calls).toHaveLength(2);
    expect(out.notes.join(' ')).toContain('the body shape or height changed');
    expect(out.passes.every((p) => p.check === 'failed')).toBe(true);
  });

  it('works with no vision model: title rules, no checks, one call', async () => {
    const gen = generator();
    const out = await runTryOn(deps({ generator: gen.g, reasoner: null }), PERSON,
      [{ images: [img(2)], title: 'Linen Blazer' }, { images: [img(3)] }], { note: '' });
    expect(gen.calls).toHaveLength(1);
    expect(gen.calls[0]!.prompt).toContain('image 2: item, shown on a shop model; image 3: outer layer');
    expect(gen.calls[0]!.prompt).toContain('work out what it is from its image');
    expect(out.passes.map((p) => p.check)).toEqual(['skipped', 'skipped']);
  });

  it('asks the next model when the first returns an empty answer, with a budget that grows per item', async () => {
    const gen = generator();
    const seen: ReasonRequest[] = [];
    const r: Reasoner = {
      provider: 'fake',
      async reason(req) {
        seen.push(req);
        if (req.jsonSchema?.name === 'garment_decisions' && seen.length === 1) throw new Error('empty answer (finish_reason=length)');
        const ans = req.jsonSchema?.name === 'garment_decisions'
          ? { person: PERSON_CARD, styling: '', products: [{ product: 1, best_photo: 2, category: 'bottom', worn_by_model: true, description: 'blue jeans', verdict: '' }] }
          : OK_ONESHOT;
        return { text: '', json: ans, model: req.model, latencyMs: 1, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
      },
    };
    const out = await runTryOn(deps({ generator: gen.g, reasoner: r, env: { LLM_MODELS_CLASSIFY: 'a,b,c' } }), PERSON, [{ images: [img(2)] }], { note: '' });
    expect(seen[0]).toMatchObject({ model: 'a', fallbackModels: ['b', 'c'], maxOutputTokens: 4000 });
    expect(seen[1]).toMatchObject({ model: 'b', fallbackModels: ['c'] });
    expect(out.passes[0]).toMatchObject({ category: 'bottom', decidedBy: 'model' });
  });

  it('gives the same seed for the same inputs', async () => {
    const a = generator(); const b = generator();
    await runTryOn(deps({ generator: a.g }), PERSON, [{ images: [img(2)] }], { note: '' });
    await runTryOn(deps({ generator: b.g }), PERSON, [{ images: [img(2)] }], { note: '' });
    expect(a.calls[0]!.seed).toBe(b.calls[0]!.seed);
  });

  it('refuses when nothing picked is clothing', async () => {
    const gen = generator();
    const llm = reasoner({ person: PERSON_CARD, styling: '', products: [{ product: 1, best_photo: 2, category: 'not-clothing', worn_by_model: false, description: 'a lamp', verdict: '' }] });
    await expect(runTryOn(deps({ generator: gen.g, reasoner: llm.r }), PERSON, [{ images: [img(2)] }], { note: '' })).rejects.toThrow('look like clothing');
    expect(gen.calls).toHaveLength(0);
  });
});

describe('try-on pipeline, debugging and slot rules', () => {
  it('renders only the last of several tops in one shot and says so', async () => {
    const gen = generator();
    const out = await runTryOn(deps({ generator: gen.g }), PERSON,
      [{ images: [img(2)], title: 'Linen Shirt' }, { images: [img(3)], title: 'Cotton Tee' }, { images: [img(4)], title: 'Polo T-Shirt' }], { note: '' });
    expect(gen.calls[0]!.references).toEqual([PERSON.toString('base64'), b64(4)]);
    expect(out.passes.map((p) => p.item)).toEqual([3]);
    expect(out.notes.join(' ')).toContain('3 tops; the last one is what you');
  });

  it('logs the photos used, the decision request and answer, every render prompt and every check', async () => {
    const gen = generator();
    const llm = reasoner({ person: PERSON_CARD, styling: 'open', products: [
      { product: 1, best_photo: 2, category: 'top', worn_by_model: false, description: 'white tee', verdict: '' }] });
    const logs: { msg: string; o: Record<string, unknown> }[] = [];
    const log = { info: (o: object, msg: string) => logs.push({ msg, o: o as Record<string, unknown> }), warn: (o: object, msg: string) => logs.push({ msg, o: o as Record<string, unknown> }) };
    await runTryOn(deps({ generator: gen.g, reasoner: llm.r, log }), PERSON, [{ images: [img(2)], title: 'Tee' }], { note: 'office' });
    const by = (m: string) => logs.find((l) => l.msg === m)!.o;
    expect(by('try-on decide request')).toMatchObject({ person: fingerprint(PERSON), items: [{ item: 1, title: 'Tee', photos: [fingerprint(img(2))] }] });
    expect(by('try-on decide request').userText).toContain('Occasion and note: "office"');
    expect(String(by('try-on decided').answer)).toContain('white tee');
    expect(by('try-on render')).toMatchObject({ step: 'oneshot', prompt: gen.calls[0]!.prompt, references: [fingerprint(PERSON), fingerprint(img(2))] });
    expect(by('try-on check')).toHaveProperty('answer');
    expect(fingerprint(PERSON)).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('try-on pipeline, per item', () => {
  it('renders one item per call on top of the last result, anchored to the original photo', async () => {
    const gen = generator();
    const llm = reasoner({ person: PERSON_CARD, styling: '', products: [
      { product: 1, best_photo: 3, category: 'outerwear', worn_by_model: false, description: 'navy linen blazer', verdict: '' },
      { product: 2, best_photo: 4, category: 'top', worn_by_model: true, description: 'white tee', verdict: '' },
    ] });
    const out = await runTryOn(deps({ generator: gen.g, reasoner: llm.r, mode: 'per-item' }), PERSON,
      [{ images: [img(2), img(3)], title: 'Blazer' }, { images: [img(4)], title: 'Tee' }], { note: '' });
    expect(gen.calls).toHaveLength(2);
    expect(gen.calls[0]!.prompt).toContain('white tee');
    expect(gen.calls[0]!.references![1]).toBe(b64(4));
    expect(gen.calls[1]!.references).toEqual([b64(100), b64(3), PERSON.toString('base64')]);
    expect(gen.calls[1]!.prompt).toContain('tattoo on right forearm');
    expect(out).toMatchObject({ mode: 'per-item', renders: 2 });
  });

  it('re-renders a failed item once with a new seed', async () => {
    const gen = generator();
    const llm = reasoner({ person: PERSON_CARD, styling: '', products: [] }, [{ same_person: false, item_worn: true, reason: 'different face' }, OK_PASS]);
    const out = await runTryOn(deps({ generator: gen.g, reasoner: llm.r, mode: 'per-item' }), PERSON, [{ images: [img(2)], title: 'Tee' }], { note: '' });
    expect(gen.calls).toHaveLength(2);
    expect(gen.calls[1]!.seed).toBe(gen.calls[0]!.seed! + 1);
    expect(out.passes[0]).toMatchObject({ check: 'passed', retried: true });
  });
});
