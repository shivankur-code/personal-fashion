export * from './types.js';
export { classify, OpenRouterReasoner, type OpenRouterOptions } from './openrouter.js';
export { checkModels, classifyModels, planModels, type ModelChoice } from './models.js';
export { managedIdentityTokenProvider, type TokenProvider } from './azure-identity.js';
export { FluxImageGenerator, fluxCostUsd, type FluxOptions, type GenerateRequest, type GenerateResult, type ImageGenerator } from './flux.js';

import { OpenRouterReasoner } from './openrouter.js';
import type { Reasoner } from './types.js';

/** Builds the configured reasoner from environment variables. */
export function reasonerFromEnv(env: Record<string, string | undefined> = process.env): Reasoner {
  const provider = env.LLM_PROVIDER ?? 'openrouter';
  if (provider === 'openrouter') {
    return new OpenRouterReasoner({
      apiKey: env.LLM_API_KEY ?? '',
      ...(env.LLM_BASE_URL ? { baseUrl: env.LLM_BASE_URL } : {}),
      appName: 'Stylist',
    });
  }
  throw new Error(`Unknown LLM_PROVIDER: ${provider}`);
}
