import type { Health } from '@stylist/contracts';
import { ping } from '@stylist/db';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { registerMe, type MeDeps } from './me.js';
import { createDailyLimiter, registerTryOn, type TryOnDeps } from './try-on.js';

export interface ServerDeps {
  /** Null when no database is configured yet (dev before Neon is set up). */
  pool: pg.Pool | null;
  version: string;
  logger?: boolean;
  tryOn?: TryOnDeps;
  me?: MeDeps;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger === false ? false : {
      level: process.env.LOG_LEVEL ?? 'info',
      // Never log credentials, tokens or photos.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    bodyLimit: 64 * 1024, // event batches are capped at 64 KB
    trustProxy: true, // behind Container Apps ingress
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'no-store');
  });

  // Liveness: the process is up. Never touches the database, so a database outage
  // does not make the platform restart healthy containers.
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Readiness: the platform calls this every 10 s. Pinging the database each time would keep a
  // free serverless database (Neon) awake 24/7 and use up its free compute, so the database is
  // only checked on request: /readyz?deep=1 (used by the release smoke test).
  app.get<{ Querystring: { deep?: string } }>('/readyz', async (req, reply) => {
    const deep = req.query.deep === '1';
    const database: Health['database'] = deps.pool === null
      ? 'not_configured'
      : !deep ? 'ok' : (await ping(deps.pool)) ? 'ok' : 'down';
    const body: Health = {
      status: database === 'down' ? 'degraded' : 'ok',
      version: deps.version,
      database,
    };
    return reply.code(database === 'down' ? 503 : 200).send(body);
  });

  app.get('/v1/version', async () => ({ version: deps.version }));

  // Landing response, so opening the bare address in a browser shows the service is up.
  app.get('/', async () => ({
    service: 'stylist-api',
    status: 'ok',
    version: deps.version,
    routes: ['/try', '/healthz', '/readyz', '/v1/version'],
  }));

  const limiter = createDailyLimiter(deps.tryOn?.dailyLimit ?? 30, deps.tryOn?.now);
  if (deps.tryOn) registerTryOn(app, deps.tryOn, limiter);
  if (deps.me) registerMe(app, deps.me, limiter);

  return app;
}
