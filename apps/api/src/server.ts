import type { Health } from '@stylist/contracts';
import { ping } from '@stylist/db';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';

export interface ServerDeps {
  /** Null when no database is configured yet (dev before Neon is set up). */
  pool: pg.Pool | null;
  version: string;
  logger?: boolean;
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

  // Readiness: only send traffic when the database answers (if one is configured).
  app.get('/readyz', async (_req, reply) => {
    const database: Health['database'] = deps.pool === null
      ? 'not_configured'
      : (await ping(deps.pool)) ? 'ok' : 'down';
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
    routes: ['/healthz', '/readyz', '/v1/version'],
  }));

  return app;
}
