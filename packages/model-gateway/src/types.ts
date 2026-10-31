// The rest of the backend talks only to these interfaces, never to a vendor SDK.
// Swapping OpenRouter for Anthropic, Foundry or anything else is a new adapter + config.

export type ImageInput =
  | { kind: 'url'; url: string } // e.g. a short-lived Blob Storage link
  | { kind: 'base64'; mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; data: string };

export interface ReasonRequest {
  model: string;
  /** Tried in order by the provider when `model` is busy or rate-limited (OpenRouter `models`). */
  fallbackModels?: string[];
  /** Reasoning models can spend the whole output budget thinking; keep it low for short answers. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  system: string;
  /** Untrusted text (product titles, user prompt) goes here as data, never into `system`. */
  user: string;
  images?: ImageInput[];
  /** JSON schema the answer must follow. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  maxOutputTokens?: number;
  temperature?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported cost in USD when available (OpenRouter reports it). */
  costUsd: number | null;
}

export interface ReasonResult {
  text: string;
  json: unknown | null;
  model: string;
  usage: Usage;
  latencyMs: number;
}

export interface Reasoner {
  readonly provider: string;
  reason(req: ReasonRequest, signal?: AbortSignal): Promise<ReasonResult>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly kind: 'rate_limited' | 'spend_limit' | 'unavailable' | 'bad_request' | 'auth' | 'invalid_output' | 'timeout',
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}
