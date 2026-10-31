import { createPool, isDatabaseConfigured } from '@stylist/db';
import { FluxImageGenerator, managedIdentityTokenProvider, OpenRouterReasoner } from '@stylist/model-gateway';
import { googleVerifier } from './auth.js';
import { AzureBlobStore } from './blob.js';
import { buildServer } from './server.js';

const url = process.env.DATABASE_URL;
const pool = isDatabaseConfigured(url) ? createPool(url) : null;
const foundry = process.env.FOUNDRY_ENDPOINT;
const hasIdentity = Boolean(process.env.IDENTITY_ENDPOINT);
const tokens = managedIdentityTokenProvider();
const generator = foundry && hasIdentity ? new FluxImageGenerator({ endpoint: foundry, tokenProvider: tokens }) : null;
const account = process.env.STORAGE_ACCOUNT;
const blobs = account && hasIdentity ? new AzureBlobStore(account, tokens) : null;
const accessCode = process.env.TRY_ACCESS_CODE ?? '';
const maxGarments = Number(process.env.TRY_MAX_GARMENTS ?? 3);
// Free vision model for the decision and check steps. Short timeout and one retry: if the free
// pool is busy, the pipeline falls back to title rules instead of making the user wait.
const llmKey = process.env.LLM_API_KEY ?? '';
const reasoner = llmKey && llmKey !== 'unset'
  ? new OpenRouterReasoner({ apiKey: llmKey, appName: 'Stylist', timeoutMs: 30_000, maxRetries: 1, ...(process.env.LLM_BASE_URL ? { baseUrl: process.env.LLM_BASE_URL } : {}) })
  : null;
const pipeline = {
  generator,
  reasoner,
  check: process.env.TRY_CHECK !== 'off',
  maxRetries: Number(process.env.TRY_MAX_RETRIES ?? 1),
  mode: process.env.TRY_MODE === 'per-item' ? 'per-item' as const : 'oneshot' as const,
};
const app = buildServer({
  pool,
  version: process.env.GIT_SHA ?? 'dev',
  tryOn: {
    ...pipeline,
    accessCode,
    dailyLimit: Number(process.env.TRY_DAILY_LIMIT ?? 30),
    maxGarments,
  },
  me: {
    verifier: googleVerifier(),
    allowedEmails: process.env.ALLOWED_EMAILS ?? '',
    accessCode,
    blobs,
    ...pipeline,
    maxGarments,
  },
});

const port = Number(process.env.PORT ?? 8080);
await app.listen({ host: '0.0.0.0', port });

// Container Apps sends SIGTERM before stopping a replica: finish in-flight requests, then exit.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close()
      .then(() => pool?.end())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
