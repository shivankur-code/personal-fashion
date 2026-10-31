// M1 smoke test: proves the FLUX.2 try-on path and the free vision checker end to end, inside Azure.
// Uses synthetic images only (no real person). Cost: about $0.12 of FLUX.2 from the Azure credit; checker $0.
import {
  FluxImageGenerator, managedIdentityTokenProvider, ModelError, OpenRouterReasoner, checkModels,
  type GenerateResult, type TokenProvider,
} from '@stylist/model-gateway';
import jpeg from 'jpeg-js';
import { log } from './log.js';

const SEED = 20261031;

/** Downscales a JPEG with a box filter (pure JS) for previews and cheaper vision calls. */
export function thumbnail(jpg: Buffer, width: number, quality = 60): Buffer {
  const src = jpeg.decode(jpg, { useTArray: true, maxMemoryUsageInMB: 256 });
  const scale = src.width / width;
  const height = Math.max(1, Math.round(src.height / scale));
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * scale), x1 = Math.min(src.width, Math.floor((x + 1) * scale));
      const y0 = Math.floor(y * scale), y1 = Math.min(src.height, Math.floor((y + 1) * scale));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < Math.max(y1, y0 + 1); yy++) {
        for (let xx = x0; xx < Math.max(x1, x0 + 1); xx++) {
          const i = (yy * src.width + xx) * 4;
          r += src.data[i]!; g += src.data[i + 1]!; b += src.data[i + 2]!; n++;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return Buffer.from(jpeg.encode({ data: out, width, height }, quality).data);
}

async function uploadBlob(token: TokenProvider, account: string, path: string, body: Buffer, contentType: string): Promise<void> {
  const t = await token('https://storage.azure.com');
  const res = await fetch(`https://${account}.blob.core.windows.net/${path}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${t}`, 'x-ms-version': '2023-11-03', 'x-ms-blob-type': 'BlockBlob',
      'content-type': contentType, 'content-length': String(body.length),
    },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status !== 201) throw new Error(`blob upload ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

/** Prints a small image into the logs in chunks so it can be reassembled outside Azure. */
function logPreview(name: string, jpg: Buffer): void {
  const b64 = thumbnail(jpg, 256).toString('base64');
  const size = 6000;
  const total = Math.ceil(b64.length / size);
  for (let i = 0; i < total; i++) console.log(`THUMB ${name} ${i + 1}/${total} ${b64.slice(i * size, (i + 1) * size)}`);
}

export async function evalSmoke(env: Record<string, string | undefined> = process.env): Promise<void> {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const token = managedIdentityTokenProvider(env);
  const account = env.STORAGE_ACCOUNT;
  if (!account) throw new Error('STORAGE_ACCOUNT is not set');

  // Endpoint: the configured one first, then the other documented host form.
  const sub = new URL(env.FOUNDRY_ENDPOINT ?? '').hostname.split('.')[0];
  const endpoints = [env.FOUNDRY_ENDPOINT!, `https://${sub}.services.ai.azure.com`, `https://${sub}.api.cognitive.microsoft.com`];

  let flux: FluxImageGenerator | null = null;
  const results: Record<string, Omit<GenerateResult, 'image'>> = {};
  const images: Record<string, Buffer> = {};

  async function gen(name: string, prompt: string, references: Buffer[] = []): Promise<void> {
    const req = {
      model: 'FLUX.2-pro' as const, prompt, width: 768, height: 1024, seed: SEED,
      references: references.map((b) => b.toString('base64')),
    };
    const candidates = flux ? [flux] : endpoints.map((e) => new FluxImageGenerator({ endpoint: e, tokenProvider: token }));
    let lastErr: unknown;
    for (const g of candidates) {
      try {
        const r = await g.generate(req);
        flux = g;
        images[name] = r.image;
        results[name] = { model: r.model, latencyMs: r.latencyMs, estimatedCostUsd: r.estimatedCostUsd, responseKeys: r.responseKeys };
        log('info', 'flux ok', { name, latencyMs: r.latencyMs, costUsd: r.estimatedCostUsd, keys: r.responseKeys, bytes: r.image.length });
        return;
      } catch (err) {
        lastErr = err;
        log('warn', 'flux attempt failed', { name, err: String(err).slice(0, 300) });
        if (err instanceof ModelError && err.kind !== 'bad_request' && err.status !== 404) break; // only try other hosts on 404/DNS-style errors
      }
    }
    throw lastErr;
  }

  await gen('person',
    'Full-length studio photograph of a fictional adult person standing straight, facing the camera, arms relaxed, '
    + 'wearing a plain fitted white t-shirt and plain grey trousers, plain light grey background, even soft lighting, '
    + 'whole body visible from head to shoes, photorealistic.');
  await gen('garment',
    'E-commerce product photograph of a single navy blue linen blazer with two buttons and notch lapels, '
    + 'laid flat on a pure white background, no person, no mannequin, sharp detail, photorealistic.');
  await gen('tryon',
    'Dress the person from image 1 in the blazer from image 2, worn open over the same white t-shirt. '
    + 'Keep the person\'s face, hair, body shape, pose, trousers, shoes, background and lighting exactly the same. '
    + 'Match the blazer\'s colour, fabric, buttons and lapels exactly. Photorealistic.',
    [images.person!, images.garment!]);

  // Free vision model scores the result against the inputs.
  let check: unknown;
  try {
    const reasoner = new OpenRouterReasoner({ apiKey: env.LLM_API_KEY ?? '', appName: 'Stylist eval' });
    const m = checkModels(env);
    const small = (b: Buffer) => ({ kind: 'base64' as const, mediaType: 'image/jpeg' as const, data: thumbnail(b, 384, 80).toString('base64') });
    const r = await reasoner.reason({
      model: m.model, fallbackModels: m.fallbackModels, reasoningEffort: 'low', maxOutputTokens: 1200, temperature: 0,
      system: 'You check virtual try-on results. Image 1: original person. Image 2: garment. Image 3: result. '
        + 'Reply with JSON only: {"garment_match":1-5,"identity_kept":1-5,"realism":1-5,"issues":[string]}',
      user: 'Score image 3.',
      images: [small(images.person!), small(images.garment!), small(images.tryon!)],
    });
    check = { model: r.model, latencyMs: r.latencyMs, costUsd: r.usage.costUsd, answer: r.text.slice(0, 600) };
  } catch (err) {
    check = { error: String(err).slice(0, 300) };
  }

  const summary = { runId, endpoint: (flux as FluxImageGenerator | null) ? 'ok' : 'none', results, check,
    totalEstimatedCostUsd: Object.values(results).reduce((s, r) => s + r.estimatedCostUsd, 0) };
  for (const [name, buf] of Object.entries(images)) {
    await uploadBlob(token, account, `results/eval/${runId}/${name}.jpg`, buf, 'image/jpeg');
  }
  await uploadBlob(token, account, `results/eval/${runId}/summary.json`, Buffer.from(JSON.stringify(summary, null, 2)), 'application/json');
  console.log(`SUMMARY ${JSON.stringify(summary)}`);
  for (const [name, buf] of Object.entries(images)) logPreview(name, buf);
}
