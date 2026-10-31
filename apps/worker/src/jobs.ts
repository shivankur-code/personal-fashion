import { grantMonthly, migrateUp, refund } from '@stylist/db';
import type pg from 'pg';
import { createBoss, ensureQueues } from './queues.js';
import { log } from './log.js';

export const JOB_NAMES = ['migrate', 'sweep', 'grant-monthly-credits', 'cleanup', 'healthcheck', 'eval-smoke'] as const;
export type JobName = (typeof JOB_NAMES)[number];

export interface JobContext {
  pool: pg.Pool;
  databaseUrl: string;
  now?: Date;
}

/** Our tables first, then pg-boss's own schema and queues. */
export async function migrate(ctx: JobContext): Promise<void> {
  const applied = await migrateUp(ctx.pool);
  const boss = createBoss(ctx.databaseUrl, 1);
  await boss.start(); // creates or upgrades the pgboss schema
  await ensureQueues(boss);
  await boss.stop({ graceful: true });
  log('info', 'migrate done', { applied });
}

/** Jobs past their deadline are failed and their credits refunded. Runs every minute. */
export async function sweep(ctx: JobContext): Promise<number> {
  const r = await ctx.pool.query<{ id: string; user_id: string }>(
    `UPDATE generations SET status = 'failed', error = 'deadline exceeded', updated_at = now()
     WHERE status NOT IN ('done', 'failed', 'cancelled') AND deadline_at < now()
     RETURNING id, user_id`,
  );
  for (const g of r.rows) await refund(ctx.pool, g.user_id, g.id);
  if (r.rows.length > 0) log('warn', 'sweep failed overdue jobs', { count: r.rows.length });
  return r.rows.length;
}

/** Free monthly looks for every active user. Safe to re-run: one grant per user per month. */
export async function grantMonthlyCredits(ctx: JobContext): Promise<number> {
  const now = ctx.now ?? new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const expiresAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const amount = Number(process.env.FREE_LOOKS_PER_MONTH ?? 10);
  const users = await ctx.pool.query<{ id: string }>(`SELECT id FROM users WHERE status = 'active'`);
  let granted = 0;
  for (const u of users.rows) {
    if (await grantMonthly(ctx.pool, u.id, period, amount, expiresAt)) granted++;
  }
  log('info', 'monthly grants', { period, granted, users: users.rows.length });
  return granted;
}

/** Retention: browsing events 90 days, idempotency keys 24 hours. */
export async function cleanup(ctx: JobContext): Promise<{ events: number; keys: number }> {
  const e = await ctx.pool.query(`DELETE FROM events WHERE received_at < now() - interval '90 days'`);
  const k = await ctx.pool.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`);
  const out = { events: e.rowCount ?? 0, keys: k.rowCount ?? 0 };
  log('info', 'cleanup', out);
  return out;
}

/** Free health check: fails (exit 1) when the API's liveness route is not 200. */
export async function healthcheck(apiUrl: string | undefined): Promise<void> {
  if (!apiUrl) throw new Error('API_URL is not set');
  const res = await fetch(new URL('/healthz', apiUrl), { signal: AbortSignal.timeout(10_000) });
  if (res.status !== 200) throw new Error(`healthz returned ${res.status}`);
  log('info', 'healthcheck ok', { apiUrl });
}
