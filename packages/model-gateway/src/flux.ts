// FLUX.2 on Microsoft Foundry (Black Forest Labs provider API).
// Request format from Microsoft's docs (read 31 Oct 2026):
//   POST {endpoint}/providers/blackforestlabs/v1/flux-2-pro?api-version=preview
//   { model: "FLUX.2-pro", prompt, width, height, seed, output_format, input_image, input_image_2 ... }
// The docs say the response holds "a URL or base64 image" without naming fields, so parsing
// accepts the known shapes and reports the keys it saw.
import type { TokenProvider } from './azure-identity.js';
import { ModelError } from './types.js';

export interface GenerateRequest {
  model: 'FLUX.2-pro' | 'FLUX.2-flex';
  prompt: string;
  /** Base64 images, in order: input_image, input_image_2, ... (pro: up to 8). */
  references?: string[];
  width?: number;
  height?: number;
  seed?: number;
  outputFormat?: 'jpeg' | 'png';
}

export interface GenerateResult {
  image: Buffer;
  model: string;
  latencyMs: number;
  /** Estimated from the published per-megapixel prices; see fluxCostUsd. */
  estimatedCostUsd: number;
  /** Top-level response keys, kept for diagnostics (the response shape isn't documented). */
  responseKeys: string[];
}

export interface ImageGenerator {
  readonly provider: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

/**
 * Azure list prices for FLUX.2-pro (Global Standard, East US 2): $0.03 for the first output
 * megapixel, $0.015 per further output megapixel and per reference-image megapixel.
 * Assumption to verify on the bill: partial megapixels round up.
 */
export function fluxCostUsd(outputPixels: number, referencePixels: number[]): number {
  const outMp = Math.max(1, Math.ceil(outputPixels / 1e6));
  const refMp = referencePixels.reduce((sum, px) => sum + Math.ceil(px / 1e6), 0);
  return Math.round((0.03 + (outMp - 1) * 0.015 + refMp * 0.015) * 10_000) / 10_000;
}

export interface FluxOptions {
  /** e.g. https://<resource>.cognitiveservices.azure.com */
  endpoint: string;
  tokenProvider: TokenProvider;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Pixel counts of the references, for the cost estimate (the adapter can't decode images). */
  referencePixels?: (refs: string[]) => number[];
}

const MODEL_PATH: Record<GenerateRequest['model'], string> = {
  'FLUX.2-pro': 'flux-2-pro',
  'FLUX.2-flex': 'flux-2-flex',
};

export class FluxImageGenerator implements ImageGenerator {
  readonly provider = 'azure-foundry-bfl';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: FluxOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const width = req.width ?? 768;
    const height = req.height ?? 1024;
    const body: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
      width,
      height,
      output_format: req.outputFormat ?? 'jpeg',
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
    };
    (req.references ?? []).forEach((b64, i) => { body[i === 0 ? 'input_image' : `input_image_${i + 1}`] = b64; });

    const token = await this.opts.tokenProvider('https://cognitiveservices.azure.com');
    const url = `${this.opts.endpoint.replace(/\/$/, '')}/providers/blackforestlabs/v1/${MODEL_PATH[req.model]}?api-version=preview`;
    const started = Date.now();
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
    const text = await res.text();
    if (!res.ok) {
      const kind = res.status === 429 ? 'rate_limited' : res.status === 401 || res.status === 403 ? 'auth'
        : res.status >= 500 ? 'unavailable' : 'bad_request';
      throw new ModelError(`FLUX ${res.status}: ${text.slice(0, 300)}`, kind, kind === 'rate_limited' || kind === 'unavailable', res.status);
    }
    let data: Record<string, unknown>;
    try { data = JSON.parse(text) as Record<string, unknown>; } catch {
      throw new ModelError('FLUX returned non-JSON', 'invalid_output', false);
    }
    const image = await this.extractImage(data);
    const refPx = this.opts.referencePixels?.(req.references ?? []) ?? (req.references ?? []).map(() => width * height);
    return {
      image,
      model: req.model,
      latencyMs: Date.now() - started,
      estimatedCostUsd: fluxCostUsd(width * height, refPx),
      responseKeys: Object.keys(data),
    };
  }

  /** Accepts OpenAI-style data[0].b64_json / data[0].url, BFL-style result.sample, or a bare url/image field. */
  private async extractImage(data: Record<string, unknown>): Promise<Buffer> {
    const first = Array.isArray(data.data) ? (data.data[0] as Record<string, unknown> | undefined) : undefined;
    const result = (data.result ?? {}) as Record<string, unknown>;
    const b64 = (first?.b64_json ?? data.b64_json ?? data.image) as string | undefined;
    if (typeof b64 === 'string' && !b64.startsWith('http')) return Buffer.from(b64, 'base64');
    const link = (first?.url ?? result.sample ?? data.url ?? data.sample ?? (typeof b64 === 'string' ? b64 : undefined)) as string | undefined;
    if (typeof link === 'string') {
      const r = await this.fetchImpl(link, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new ModelError(`could not download FLUX image: ${r.status}`, 'unavailable', true, r.status);
      return Buffer.from(await r.arrayBuffer());
    }
    throw new ModelError(`unrecognised FLUX response; keys: ${Object.keys(data).join(',')}`, 'invalid_output', false);
  }
}
