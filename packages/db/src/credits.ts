import type pg from 'pg';

export async function balance(db: pg.Pool | pg.PoolClient, userId: string): Promise<number> {
  const r = await db.query<{ b: string | null }>(
    `SELECT COALESCE(SUM(amount), 0) AS b FROM credit_ledger
     WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())`,
    [userId],
  );
  return Number(r.rows[0]?.b ?? 0);
}

/** Monthly free grant. Safe to run any number of times: one grant per user per period. */
export async function grantMonthly(
  db: pg.Pool,
  userId: string,
  period: string,
  amount: number,
  expiresAt: Date,
): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO credit_ledger (user_id, amount, kind, period, expires_at)
     VALUES ($1, $2, 'grant', $3, $4)
     ON CONFLICT (user_id, period) WHERE kind = 'grant' DO NOTHING`,
    [userId, amount, period, expiresAt],
  );
  return r.rowCount === 1;
}

/**
 * Reserves one look's credits for a job. A per-user transaction lock serialises concurrent
 * requests, so a user with 1 credit can never start 2 jobs (e.g. from two browser tabs).
 */
export async function reserve(
  pool: pg.Pool,
  userId: string,
  generationId: string,
  cost: number,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [userId]);
    if ((await balance(client, userId)) < cost) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `INSERT INTO credit_ledger (user_id, amount, kind, generation_id) VALUES ($1, $2, 'reserve', $3)`,
      [userId, -cost, generationId],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Job succeeded: record the spend (the reservation already took the credits).
 * Idempotent, and refused if the job was already refunded, so spend and refund never both happen.
 */
export async function confirmSpend(pool: pg.Pool, userId: string, generationId: string): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO credit_ledger (user_id, amount, kind, generation_id)
     SELECT $1, 0, 'spend', $2
     WHERE EXISTS (SELECT 1 FROM credit_ledger WHERE generation_id = $2 AND user_id = $1 AND kind = 'reserve')
       AND NOT EXISTS (SELECT 1 FROM credit_ledger WHERE generation_id = $2 AND kind = 'refund')
     ON CONFLICT (generation_id, kind) WHERE generation_id IS NOT NULL DO NOTHING`,
    [userId, generationId],
  );
  return r.rowCount === 1;
}

/** Job failed or timed out: give the reserved credits back. Idempotent; never refunds twice. */
export async function refund(pool: pg.Pool, userId: string, generationId: string): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO credit_ledger (user_id, amount, kind, generation_id)
     SELECT user_id, -amount, 'refund', generation_id FROM credit_ledger
     WHERE generation_id = $2 AND user_id = $1 AND kind = 'reserve'
       AND NOT EXISTS (SELECT 1 FROM credit_ledger WHERE generation_id = $2 AND kind = 'spend')
     ON CONFLICT (generation_id, kind) WHERE generation_id IS NOT NULL DO NOTHING`,
    [userId, generationId],
  );
  return r.rowCount === 1;
}
