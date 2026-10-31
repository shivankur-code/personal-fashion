import { randomUUID } from 'node:crypto';
import { balance, createPool, migrateDown, reserve } from '@stylist/db';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, grantMonthlyCredits, migrate, sweep } from '../src/jobs.js';
import { createBoss } from '../src/queues.js';

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('worker jobs', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createPool(url as string, 5);
    await pool.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
    while ((await migrateDown(pool)) !== null) { /* start clean */ }
    await migrate({ pool, databaseUrl: url as string });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('migrate creates our tables, the pg-boss schema and all queues', async () => {
    const t = await pool.query("SELECT to_regclass('public.credit_ledger') AS a, to_regclass('pgboss.job') AS b");
    expect(t.rows[0].a).not.toBeNull();
    expect(t.rows[0].b).not.toBeNull();
    const q = await pool.query<{ name: string }>(
      `SELECT name FROM pgboss.queue WHERE name NOT LIKE '\\_\\_pgboss%' ORDER BY name`,
    );
    expect(q.rows.map((r) => r.name)).toEqual(['catalog', 'dead-letter', 'job-steps', 'privacy', 'render']);
  });

  it('migrate is safe to run twice', async () => {
    await expect(migrate({ pool, databaseUrl: url as string })).resolves.toBeUndefined();
  });

  it('the autoscaler query counts only our waiting jobs, including retries', async () => {
    // Must match the KEDA query in infra/bicep/main.bicep exactly.
    const q = `SELECT COUNT(*) FROM pgboss.job WHERE state IN ('created', 'retry') AND name IN ('job-steps', 'render', 'catalog', 'privacy')`;
    const before = Number((await pool.query(q)).rows[0].count);
    const boss = createBoss(url as string, 1);
    await boss.start();
    await boss.send('render', { test: true });
    await boss.send('dead-letter', { test: true }); // must not wake workers
    await boss.stop({ graceful: true });
    expect(Number((await pool.query(q)).rows[0].count)).toBe(before + 1);
  });

  it('grants each active user once per month', async () => {
    await pool.query(`INSERT INTO users (email) VALUES ($1), ($2)`, [`${randomUUID()}@t.local`, `${randomUUID()}@t.local`]);
    const now = new Date(Date.UTC(2026, 10, 3)); // Nov 2026
    const first = await grantMonthlyCredits({ pool, databaseUrl: url as string, now });
    const again = await grantMonthlyCredits({ pool, databaseUrl: url as string, now });
    expect(first).toBeGreaterThanOrEqual(2);
    expect(again).toBe(0);
  });

  it('sweep fails overdue jobs and refunds their credits', async () => {
    const u = (await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`, [`${randomUUID()}@t.local`],
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO credit_ledger (user_id, amount, kind, period, expires_at) VALUES ($1, 1, 'grant', 'x', now() + interval '1 day')`,
      [u],
    );
    const g = (await pool.query<{ id: string }>(
      `INSERT INTO generations (user_id, status, deadline_at) VALUES ($1, 'rendering', now() - interval '1 second') RETURNING id`,
      [u],
    )).rows[0]!.id;
    expect(await reserve(pool, u, g, 1)).toBe(true);
    expect(await balance(pool, u)).toBe(0);
    expect(await sweep({ pool, databaseUrl: url as string })).toBeGreaterThanOrEqual(1);
    const s = await pool.query('SELECT status FROM generations WHERE id = $1', [g]);
    expect(s.rows[0].status).toBe('failed');
    expect(await balance(pool, u)).toBe(1);
  });

  it('cleanup removes events older than 90 days only', async () => {
    const u = (await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`, [`${randomUUID()}@t.local`],
    )).rows[0]!.id;
    const s = (await pool.query<{ id: string }>(
      `INSERT INTO sessions (user_id, marketplace, occasion) VALUES ($1, 'amazon_in', 'casual') RETURNING id`, [u],
    )).rows[0]!.id;
    const p = (await pool.query<{ id: string }>(
      `INSERT INTO products (marketplace, external_id, url, title) VALUES ('amazon_in', $1, 'https://x.test', 't') RETURNING id`,
      [randomUUID()],
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO events (session_id, product_id, kind, at, received_at) VALUES
       ($1, $2, 'opened', now(), now() - interval '91 days'), ($1, $2, 'opened', now(), now())`,
      [s, p],
    );
    const out = await cleanup({ pool, databaseUrl: url as string });
    expect(out.events).toBe(1);
    const left = await pool.query('SELECT COUNT(*) FROM events WHERE session_id = $1', [s]);
    expect(Number(left.rows[0].count)).toBe(1);
  });
});
