// Runs against a real PostgreSQL (TEST_DATABASE_URL). Each run uses a fresh schema-less database state.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  balance, confirmSpend, createPool, grantMonthly, migrateDown, migrateUp, refund, reserve,
} from '../src/index.js';

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('database', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createPool(url as string, 10);
    while ((await migrateDown(pool)) !== null) { /* start clean */ }
  });
  afterAll(async () => {
    await pool.end();
  });

  async function newUser(): Promise<string> {
    const r = await pool.query<{ id: string }>(
      'INSERT INTO users (email) VALUES ($1) RETURNING id',
      [`${randomUUID()}@test.local`],
    );
    return r.rows[0]!.id;
  }

  it('applies migrations once, rolls back, and re-applies', async () => {
    expect(await migrateUp(pool)).toEqual(['0001_init']);
    expect(await migrateUp(pool)).toEqual([]);
    expect(await migrateDown(pool)).toBe('0001_init');
    const t = await pool.query("SELECT to_regclass('public.users') AS t");
    expect(t.rows[0].t).toBeNull();
    expect(await migrateUp(pool)).toEqual(['0001_init']);
  });

  it('two migrators at once apply the migration exactly once', async () => {
    await migrateDown(pool);
    const [a, b] = await Promise.all([migrateUp(pool), migrateUp(pool)]);
    expect([...a, ...b]).toEqual(['0001_init']);
  });

  it('grants monthly credits only once per period', async () => {
    const u = await newUser();
    const exp = new Date(Date.now() + 40 * 864e5);
    expect(await grantMonthly(pool, u, '2026-11', 10, exp)).toBe(true);
    expect(await grantMonthly(pool, u, '2026-11', 10, exp)).toBe(false);
    expect(await balance(pool, u)).toBe(10);
  });

  it('expired grants do not count', async () => {
    const u = await newUser();
    await grantMonthly(pool, u, '2026-09', 10, new Date(Date.now() - 1000));
    expect(await balance(pool, u)).toBe(0);
  });

  it('with 1 credit, 5 simultaneous jobs start exactly one', async () => {
    const u = await newUser();
    await grantMonthly(pool, u, '2026-11', 1, new Date(Date.now() + 864e5));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => reserve(pool, u, randomUUID(), 1)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await balance(pool, u)).toBe(0);
  });

  it('refund returns credits once, and spend is refused after a refund', async () => {
    const u = await newUser();
    await grantMonthly(pool, u, '2026-11', 2, new Date(Date.now() + 864e5));
    const job = randomUUID();
    expect(await reserve(pool, u, job, 1)).toBe(true);
    expect(await balance(pool, u)).toBe(1);
    expect(await refund(pool, u, job)).toBe(true);
    expect(await refund(pool, u, job)).toBe(false);
    expect(await confirmSpend(pool, u, job)).toBe(false);
    expect(await balance(pool, u)).toBe(2);
  });

  it('refund is refused after a spend', async () => {
    const u = await newUser();
    await grantMonthly(pool, u, '2026-11', 1, new Date(Date.now() + 864e5));
    const job = randomUUID();
    await reserve(pool, u, job, 1);
    expect(await confirmSpend(pool, u, job)).toBe(true);
    expect(await confirmSpend(pool, u, job)).toBe(false);
    expect(await refund(pool, u, job)).toBe(false);
    expect(await balance(pool, u)).toBe(0);
  });

  it('purchased credits cannot carry an expiry date', async () => {
    const u = await newUser();
    await expect(pool.query(
      `INSERT INTO credit_ledger (user_id, amount, kind, expires_at) VALUES ($1, 10, 'purchase', now())`,
      [u],
    )).rejects.toThrow(/check constraint/);
  });
});
