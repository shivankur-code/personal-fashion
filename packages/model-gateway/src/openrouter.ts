// OpenRouter adapter (OpenAI-compatible chat completions API).
import { ModelError, type ImageInput, type Reasoner, type ReasonRequest, type ReasonResult } from './types.js';

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl?: string; // default https://openrouter.ai/api/v1
  /** Shown in OpenRouter's dashboard; identifies our app. */
  appName?: string;
  appUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface ChatResponse {
  model?: string;
  choices?: { finish_reason?: string | null; message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: number };
}

function imagePart(img: ImageInput): { type: 'image_url'; image_url: { url: string } } {
  const url = img.kind === 'url' ? img.url : `data:${img.mediaType};base64,${img.data}`;
  return { type: 'image_url', image_url: { url } };
}

export class OpenRouterReasoner implements Reasoner {
  readonly provider = 'openrouter';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: OpenRouterOptions) {
    if (!opts.apiKey || opts.apiKey === 'unset') throw new ModelError('OpenRouter API key is not set', 'auth', false);
    this.baseUrl = (opts.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async reason(req: ReasonRequest, signal?: AbortSignal): Promise<ReasonResult> {
    const body = {
      model: req.model,
      messages: [
        { role: 'system', content: req.system },
        {
          role: 'user',
          content: [{ type: 'text', text: req.user }, ...(req.images ?? []).map(imagePart)],
        },
      ],
      ...(req.fallbackModels?.length ? { models: [req.model, ...req.fallbackModels] } : {}),
      ...(req.reasoningEffort ? { reasoning: { effort: req.reasoningEffort, exclude: true } } : {}),
      max_tokens: req.maxOutputTokens ?? 1024,
      temperature: req.temperature ?? 0.2,
      usage: { include: true }, // ask OpenRouter to report cost
      ...(req.jsonSchema
        ? { response_format: { type: 'json_schema', json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema } } }
        : {}),
    };

    const maxRetries = this.opts.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 60_000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          signal: combined,
          headers: {
            authorization: `Bearer ${this.opts.apiKey}`,
            'content-type': 'application/json',
            ...(this.opts.appUrl ? { 'HTTP-Referer': this.opts.appUrl } : {}),
            ...(this.opts.appName ? { 'X-Title': this.opts.appName } : {}),
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        if (attempt < maxRetries && !signal?.aborted) { await this.sleep(backoff(attempt)); continue; }
        throw new ModelError(isTimeout ? 'model call timed out' : `network error: ${String(err)}`, isTimeout ? 'timeout' : 'unavailable', true);
      }

      if (res.ok) {
        const data = (await res.json()) as ChatResponse;
        if (data.error) throw classify(data.error.code ?? 500, data.error.message ?? 'provider error');
        const choice = data.choices?.[0];
        const text = choice?.message?.content ?? '';
        if (text.trim() === '') {
          // Seen in rehearsal: a reasoning model used the whole budget thinking and returned nothing.
          throw new ModelError(
            `empty answer from ${data.model ?? req.model} (finish_reason=${choice?.finish_reason ?? 'unknown'}); raise maxOutputTokens or lower reasoningEffort`,
            'invalid_output', false);
        }
        let json: unknown | null = null;
        if (req.jsonSchema) {
          try { json = JSON.parse(text); } catch { throw new ModelError('model did not return valid JSON', 'invalid_output', false); }
        }
        return {
          text,
          json,
          model: data.model ?? req.model,
          latencyMs: Date.now() - started,
          usage: {
            inputTokens: data.usage?.prompt_tokens ?? 0,
            outputTokens: data.usage?.completion_tokens ?? 0,
            costUsd: typeof data.usage?.cost === 'number' ? data.usage.cost : null,
          },
        };
      }

      const message = await res.text().catch(() => '');
      const err = classify(res.status, message.slice(0, 300));
      if (err.retryable && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      throw err;
    }
  }
}

function backoff(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** attempt);
}

/** Maps provider HTTP status to our error kinds. 402 = out of credits: never retried. */
export function classify(status: number, message: string): ModelError {
  if (status === 401 || status === 403) return new ModelError(`auth failed: ${message}`, 'auth', false, status);
  if (status === 402) return new ModelError(`out of credits: ${message}`, 'spend_limit', false, status);
  if (status === 429) return new ModelError(`rate limited: ${message}`, 'rate_limited', true, status);
  if (status === 400 || status === 404 || status === 422) return new ModelError(`bad request: ${message}`, 'bad_request', false, status);
  return new ModelError(`provider unavailable (${status}): ${message}`, 'unavailable', true, status);
}
