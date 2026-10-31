import pg from 'pg';

/** True when a real database URL is configured (Azure sets the secret to "unset" until one exists). */
export function isDatabaseConfigured(url: string | undefined): url is string {
  return typeof url === 'string' && url.length > 0 && url !== 'unset';
}

/**
 * One pool per process. Size comes from PG_POOL_MAX so the total across all apps stays
 * inside the database's connection limit (B1ms: 35 user connections; budget is 33).
 */
export function createPool(url: string, max = Number(process.env.PG_POOL_MAX ?? 5)): pg.Pool {
  return new pg.Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: process.env.APP_NAME ?? 'stylist',
  });
}

export async function ping(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
