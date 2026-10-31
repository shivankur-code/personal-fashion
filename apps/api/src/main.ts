import { createPool, isDatabaseConfigured } from '@stylist/db';
import { FluxImageGenerator, managedIdentityTokenProvider } from '@stylist/model-gateway';
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
const app = buildServer({
  pool,
  version: process.env.GIT_SHA ?? 'dev',
  tryOn: {
    generator,
    accessCode,
    dailyLimit: Number(process.env.TRY_DAILY_LIMIT ?? 30),
  },
  me: {
    verifier: googleVerifier(),
    allowedEmails: process.env.ALLOWED_EMAILS ?? '',
    accessCode,
    blobs,
    generator,
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
