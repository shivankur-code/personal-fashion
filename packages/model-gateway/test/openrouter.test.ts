// Uses a fake fetch: no network, no key, no cost.
import { describe, expect, it } from 'vitest';
import { ModelError, OpenRouterReasoner } from '../src/index.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<() => Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no more fake responses');
    return next();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = (content: string, extra: Record<string, unknown> = {}) => () =>
  new Response(JSON.stringify({
    model: 'test/model',
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.00042 },
    ...extra,
  }), { status: 200, headers: { 'content-type': 'application/json' } });

const noSleep = async () => undefined;

describe('OpenRouterReasoner', () => {
  it('sends text, images and the JSON schema in OpenAI format, and reads usage and cost', async () => {
    const f = fakeFetch([ok('{"pick":"top-1"}')]);
    const r = new OpenRouterReasoner({ apiKey: 'k', fetchImpl: f.impl, sleep: noSleep, appName: 'Stylist' });
    const out = await r.reason({
      model: 'test/model',
      system: 'You are a stylist.',
      user: 'Pick one.',
      images: [{ kind: 'url', url: 'https://example.test/a.jpg' }, { kind: 'base64', mediaType: 'image/png', data: 'AAA=' }],
      jsonSchema: { name: 'pick', schema: { type: 'object', properties: { pick: { type: 'string' } }, required: ['pick'] } },
    });
    expect(out.json).toEqual({ pick: 'top-1' });
    expect(out.usage).toEqual({ inputTokens: 120, outputTokens: 30, costUsd: 0.00042 });
    const call = f.calls[0]!;
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer k');
    expect(headers['X-Title']).toBe('Stylist');
    const body = JSON.parse(String(call.init.body));
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a stylist.' });
    expect(body.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'https://example.test/a.jpg' } });
    expect(body.messages[1].content[2].image_url.url).toBe('data:image/png;base64,AAA=');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.usage).toEqual({ include: true });
  });

  it('retries a 429 using retry-after, then succeeds', async () => {
    const waits: number[] = [];
    const f = fakeFetch([
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
      ok('hello'),
    ]);
    const r = new OpenRouterReasoner({ apiKey: 'k', fetchImpl: f.impl, sleep: async (ms) => { waits.push(ms); } });
    const out = await r.reason({ model: 'm', system: 's', user: 'u' });
    expect(out.text).toBe('hello');
    expect(waits).toEqual([2000]);
    expect(f.calls).toHaveLength(2);
  });

  it('never retries when out of credits (402)', async () => {
    const f = fakeFetch([() => new Response('insufficient credits', { status: 402 })]);
    const r = new OpenRouterReasoner({ apiKey: 'k', fetchImpl: f.impl, sleep: noSleep });
    await expect(r.reason({ model: 'm', system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'spend_limit', retryable: false });
    expect(f.calls).toHaveLength(1);
  });

  it('gives up after the retry limit on 5xx', async () => {
    const f = fakeFetch([
      () => new Response('down', { status: 503 }),
      () => new Response('down', { status: 503 }),
      () => new Response('down', { status: 503 }),
    ]);
    const r = new OpenRouterReasoner({ apiKey: 'k', fetchImpl: f.impl, sleep: noSleep, maxRetries: 2 });
    await expect(r.reason({ model: 'm', system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'unavailable' });
    expect(f.calls).toHaveLength(3);
  });

  it('rejects invalid JSON when a schema was requested', async () => {
    const f = fakeFetch([ok('not json')]);
    const r = new OpenRouterReasoner({ apiKey: 'k', fetchImpl: f.impl, sleep: noSleep });
    await expect(r.reason({ model: 'm', system: 's', user: 'u', jsonSchema: { name: 'x', schema: {} } }))
      .rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('refuses to start without a key', () => {
    expect(() => new OpenRouterReasoner({ apiKey: 'unset' })).toThrow(ModelError);
  });
});
