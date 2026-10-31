import { describe, expect, it } from 'vitest';
import { FluxImageGenerator, fluxCostUsd, managedIdentityTokenProvider } from '../src/index.js';

const png = Buffer.from('iVBORw0KGgo=', 'base64');

function fake(responses: Array<(url: string) => Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return responses.shift()!(String(url));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('FLUX.2 adapter', () => {
  it('posts the documented request shape with numbered reference images', async () => {
    const f = fake([() => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))]);
    const g = new FluxImageGenerator({ endpoint: 'https://res.cognitiveservices.azure.com/', tokenProvider: async () => 'tok', fetchImpl: f.impl });
    const out = await g.generate({ model: 'FLUX.2-pro', prompt: 'p', references: ['AAA', 'BBB', 'CCC'], width: 768, height: 1024, seed: 7 });
    expect(f.calls[0]!.url).toBe('https://res.cognitiveservices.azure.com/providers/blackforestlabs/v1/flux-2-pro?api-version=preview');
    const body = JSON.parse(String(f.calls[0]!.init!.body));
    expect(body).toMatchObject({ model: 'FLUX.2-pro', prompt: 'p', width: 768, height: 1024, seed: 7, output_format: 'jpeg', input_image: 'AAA', input_image_2: 'BBB', input_image_3: 'CCC' });
    expect((f.calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(out.image.equals(png)).toBe(true);
    expect(out.responseKeys).toEqual(['data']);
  });

  it('downloads the image when the response holds a URL (BFL result.sample)', async () => {
    const f = fake([
      () => new Response(JSON.stringify({ id: 'x', result: { sample: 'https://cdn.test/img.jpg' } })),
      () => new Response(png),
    ]);
    const g = new FluxImageGenerator({ endpoint: 'https://e', tokenProvider: async () => 't', fetchImpl: f.impl });
    const out = await g.generate({ model: 'FLUX.2-pro', prompt: 'p' });
    expect(f.calls[1]!.url).toBe('https://cdn.test/img.jpg');
    expect(out.image.equals(png)).toBe(true);
  });

  it('reports unknown response shapes by their keys', async () => {
    const f = fake([() => new Response(JSON.stringify({ polling_url: 'u', id: 'i' }))]);
    const g = new FluxImageGenerator({ endpoint: 'https://e', tokenProvider: async () => 't', fetchImpl: f.impl });
    await expect(g.generate({ model: 'FLUX.2-pro', prompt: 'p' })).rejects.toThrow(/polling_url,id/);
  });

  it('maps 429 to a retryable rate limit', async () => {
    const f = fake([() => new Response('busy', { status: 429 })]);
    const g = new FluxImageGenerator({ endpoint: 'https://e', tokenProvider: async () => 't', fetchImpl: f.impl });
    await expect(g.generate({ model: 'FLUX.2-pro', prompt: 'p' })).rejects.toMatchObject({ kind: 'rate_limited', retryable: true });
  });

  it('estimates cost from published prices', () => {
    expect(fluxCostUsd(768 * 1024, [])).toBe(0.03); // 0.79 MP output only
    expect(fluxCostUsd(768 * 1024, [768 * 1024, 512 * 512])).toBe(0.06); // + 2 references (1 MP each, rounded up)
    expect(fluxCostUsd(1536 * 1536, [])).toBe(0.06); // 2.36 MP -> 3 MP
  });
});

describe('managed identity tokens', () => {
  it('calls the Container Apps identity endpoint with the client ID and caches the token', async () => {
    const f = fake([() => new Response(JSON.stringify({ access_token: 'abc', expires_on: Math.floor(Date.now() / 1000) + 3600 }))]);
    const get = managedIdentityTokenProvider({ IDENTITY_ENDPOINT: 'http://localhost:42356/msi/token', IDENTITY_HEADER: 'h', AZURE_CLIENT_ID: 'cid' }, f.impl);
    expect(await get('https://cognitiveservices.azure.com')).toBe('abc');
    expect(await get('https://cognitiveservices.azure.com')).toBe('abc');
    expect(f.calls).toHaveLength(1);
    const u = new URL(f.calls[0]!.url);
    expect(u.searchParams.get('resource')).toBe('https://cognitiveservices.azure.com');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect((f.calls[0]!.init!.headers as Record<string, string>)['X-IDENTITY-HEADER']).toBe('h');
  });
});
