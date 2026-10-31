import type { GenerateRequest, ImageGenerator, Reasoner, ReasonRequest } from '@stylist/model-gateway';
import { describe, expect, it } from 'vitest';
import { categoryFromTitle, decideUserText, parseDecisions, planOutfit, type Decision } from '../src/outfit.js';
import { runTryOn, trimCandidates } from '../src/pipeline.js';

// Distinct fake JPEGs so we can tell which photo was sent where.
const img = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50, n)]);
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

/** Answers decision calls with `decide` and check calls with the next item of `checks`. */
function reasoner(decide: unknown | Error, checks: (object | Error)[] = []) {
  const calls: ReasonRequest[] = [];
  const r: Reasoner = {
    provider: 'fake',
    async reason(req) {
      calls.push(req);
      const ans = req.jsonSchema?.name === 'garment_decisions' ? decide : checks.shift() ?? { same_person: true, item_worn: true, reason: 'ok' };
      if (ans instanceof Error) throw ans;
      return { text: JSON.stringify(ans), json: ans, model: 'fake', latencyMs: 1, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
    },
  };
  return { r, calls };
}

const d = (category: Decision['category']): Decision => ({ image: 0, category, description: '', wornByModel: true, source: 'rules' });

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

  it('numbers photos across products and maps answers back, falling back per product', () => {
    const gs = [{ images: [img(2), img(3)], title: 'Blazer' }, { images: [img(4)], title: 'Chinos' }, { images: [img(5)], title: 'Tee' }];
    expect(decideUserText(gs)).toBe('Product 1: photos 1 to 2. Title: "Blazer".\nProduct 2: photo 3. Title: "Chinos".\nProduct 3: photo 4. Title: "Tee".');
    const out = parseDecisions({ products: [
      { product: 1, best_photo: 2, category: 'outerwear', worn_by_model: false, description: 'navy blazer' },
      { product: 2, best_photo: 9, category: 'weird', worn_by_model: true, description: 'x' },
    ] }, gs);
    expect(out[0]).toMatchObject({ image: 1, category: 'outerwear', wornByModel: false, source: 'model' });
    expect(out[1]).toMatchObject({ image: 0, category: 'bottom', source: 'model' }); // bad photo number and category repaired
    expect(out[2]).toMatchObject({ category: 'top', source: 'rules' }); // missing answer
  });

  it('limits candidate photos so one decision call sees at most 12', () => {
    const many = Array.from({ length: 5 }, () => ({ images: [img(2), img(3), img(4), img(5)] }));
    expect(trimCandidates(many).map((g) => g.images.length)).toEqual([2, 2, 2, 2, 2]);
    expect(trimCandidates([{ images: [img(2), img(3), img(4), img(5)] }])[0]!.images).toHaveLength(4);
  });
});

describe('try-on pipeline', () => {
  it('renders the photo the decision model picked, in dressing order', async () => {
    const gen = generator();
    const llm = reasoner({ products: [
      { product: 1, best_photo: 2, category: 'outerwear', worn_by_model: false, description: 'navy linen blazer' },
      { product: 2, best_photo: 3, category: 'top', worn_by_model: true, description: 'white tee' },
    ] });
    const out = await runTryOn({ generator: gen.g, reasoner: llm.r, check: true, maxRetries: 2 },
      PERSON, [{ images: [img(2), img(3)], title: 'Blazer' }, { images: [img(4)], title: 'Tee' }], '');
    expect(gen.calls).toHaveLength(2);
    expect(gen.calls[0]!.prompt).toContain('white tee');            // top first…
    expect(gen.calls[0]!.references![1]).toBe(img(4).toString('base64'));
    expect(gen.calls[1]!.prompt).toContain('navy linen blazer');    // …then the blazer over it,
    expect(gen.calls[1]!.references![1]).toBe(img(3).toString('base64')); // using photo 2 of product 1
    expect(gen.calls[1]!.references![0]).toBe(img(100).toString('base64')); // built on pass 1
    expect(gen.calls[1]!.references![2]).toBe(PERSON.toString('base64'));
    expect(out.passes.map((p) => [p.item, p.category, p.check])).toEqual([[2, 'top', 'passed'], [1, 'outerwear', 'passed']]);
    expect(out.estimatedCostUsd).toBeCloseTo(0.12);
  });

  it('re-renders once with a new seed when the check says the face changed', async () => {
    const gen = generator();
    const llm = reasoner({ products: [] }, [
      { same_person: false, item_worn: true, reason: 'different face' },
      { same_person: true, item_worn: true, reason: 'ok' },
    ]);
    const out = await runTryOn({ generator: gen.g, reasoner: llm.r, check: true, maxRetries: 2 }, PERSON, [{ images: [img(2)], title: 'Tee' }], '');
    expect(gen.calls).toHaveLength(2);
    expect(gen.calls[1]!.seed).toBe(gen.calls[0]!.seed! + 1);
    expect(gen.calls[1]!.prompt).toContain('rejected because: different face');
    expect(out.passes[0]).toMatchObject({ check: 'passed', retried: true });
    expect(out.image.equals(img(101))).toBe(true);
  });

  it('respects the retry budget and tells the user when a pass still fails', async () => {
    const gen = generator();
    const bad = { same_person: true, item_worn: false, reason: 'wrong colour' };
    const llm = reasoner({ products: [] }, [bad, bad, bad]);
    const out = await runTryOn({ generator: gen.g, reasoner: llm.r, check: true, maxRetries: 1 },
      PERSON, [{ images: [img(2)], title: 'Tee' }, { images: [img(3)], title: 'Jeans' }], '');
    expect(gen.calls).toHaveLength(3); // 2 passes + 1 retry
    expect(out.notes.join(' ')).toContain('may not match exactly: wrong colour');
  });

  it('falls back to title rules and skips checks when the vision model is down', async () => {
    const gen = generator();
    const down = new Error('rate limited');
    const llm = reasoner(down, [down, down]);
    const out = await runTryOn({ generator: gen.g, reasoner: llm.r, check: true, maxRetries: 2 },
      PERSON, [{ images: [img(2)], title: 'Linen Blazer' }, { images: [img(3)], title: 'Cotton Shirt' }], '');
    expect(out.passes).toEqual([
      { item: 2, category: 'top', decidedBy: 'rules', check: 'skipped', retried: false },
      { item: 1, category: 'outerwear', decidedBy: 'rules', check: 'skipped', retried: false },
    ]);
    expect(gen.calls).toHaveLength(2);
  });

  it('gives the same seed for the same inputs', async () => {
    const a = generator(); const b = generator();
    await runTryOn({ generator: a.g, reasoner: null, check: false, maxRetries: 0 }, PERSON, [{ images: [img(2)] }], '');
    await runTryOn({ generator: b.g, reasoner: null, check: false, maxRetries: 0 }, PERSON, [{ images: [img(2)] }], '');
    expect(a.calls[0]!.seed).toBe(b.calls[0]!.seed);
  });

  it('refuses when nothing picked is clothing', async () => {
    const gen = generator();
    const llm = reasoner({ products: [{ product: 1, best_photo: 1, category: 'not-clothing', worn_by_model: false, description: 'a lamp' }] });
    await expect(runTryOn({ generator: gen.g, reasoner: llm.r, check: true, maxRetries: 2 }, PERSON, [{ images: [img(2)] }], ''))
      .rejects.toThrow('look like clothing');
    expect(gen.calls).toHaveLength(0);
  });
});
