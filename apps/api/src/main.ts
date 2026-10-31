import { createPool, isDatabaseConfigured } from '@stylist/db';
import { buildServer } from './server.js';

const url = process.env.DATABASE_URL;
const pool = isDatabaseConfigured(url) ? createPool(url) : null;
const app = buildServer({ pool, version: process.env.GIT_SHA ?? 'dev' });

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
