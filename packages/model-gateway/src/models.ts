// Model choices live in code, not infrastructure: changing a model is a normal release.
// Each can be overridden with an environment variable.
// Free models (":free") cost $0 but share a rate-limited pool, so each list has fallbacks.
// Free vision models confirmed available on OpenRouter on 31 Oct 2026.
const FREE_VISION = [
  'nvidia/nemotron-3.5-super-vl:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
];

export interface ModelChoice {
  model: string;
  fallbackModels: string[];
}

function fromEnv(name: string, defaults: string[], env: Record<string, string | undefined>): ModelChoice {
  const list = (env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const chosen = list.length > 0 ? list : defaults;
  return { model: chosen[0]!, fallbackModels: chosen.slice(1) };
}

/** Outfit planning (reads the person photo and garment images). */
export const planModels = (env: Record<string, string | undefined> = process.env) => fromEnv('LLM_MODELS_PLAN', FREE_VISION, env);
/** Quality and safety check of a rendered image. */
export const checkModels = (env: Record<string, string | undefined> = process.env) => fromEnv('LLM_MODELS_CHECK', FREE_VISION, env);
/** Product classification (category, colour, pattern). */
export const classifyModels = (env: Record<string, string | undefined> = process.env) => fromEnv('LLM_MODELS_CLASSIFY', FREE_VISION, env);
