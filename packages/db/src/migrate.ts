import type pg from 'pg';
import * as m0001 from './migrations/0001_init.js';

interface Migration {
  id: string;
  up: string;
  down: string;
}

/** Ordered list. Never edit a released migration; add a new one. */
export const migrations: readonly Migration[] = [m0001];

// Any fixed number works; it only has to be the same for every migrator.
const LOCK_KEY = 727_001;

/**
 * Applies pending migrations in one transaction each, under an advisory lock so two
 * migrators (e.g. two CI runs) can never run at the same time.
 */
export async function migrateUp(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set(
      (await client.query<{ id: string }>('SELECT id FROM schema_migrations')).rows.map((r) => r.id),
    );
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.up);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
        await client.query('COMMIT');
        applied.push(m.id);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

/** Rolls back the most recent migration. */
export async function migrateDown(pool: pg.Pool): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    const last = await client.query<{ id: string }>(
      'SELECT id FROM schema_migrations ORDER BY applied_at DESC, id DESC LIMIT 1',
    ).catch(() => ({ rows: [] as { id: string }[] }));
    const id = last.rows[0]?.id;
    if (!id) return null;
    const m = migrations.find((x) => x.id === id);
    if (!m) throw new Error(`No down migration for ${id}`);
    await client.query('BEGIN');
    try {
      await client.query(m.down);
      await client.query('DELETE FROM schema_migrations WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    return id;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
