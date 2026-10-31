import { Health } from '@stylist/contracts';
import { createPool } from '@stylist/db';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

describe('api health', () => {
  it('healthz is 200 without a database', async () => {
    const app = buildServer({ pool: null, version: 't', logger: false });
    const r = await app.inject({ url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('the bare address answers 200 with the service name and version', async () => {
    const app = buildServer({ pool: null, version: 'abc', logger: false });
    const r = await app.inject({ url: '/' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ service: 'stylist-api', status: 'ok', version: 'abc' });
  });

  it('readyz reports not_configured (200) when no database is set', async () => {
    const app = buildServer({ pool: null, version: 't', logger: false });
    const r = await app.inject({ url: '/readyz' });
    expect(r.statusCode).toBe(200);
    expect(Health.parse(r.json()).database).toBe('not_configured');
  });

  it('readyz is 503 when the database is unreachable', async () => {
    const pool = createPool('postgresql://nobody:x@127.0.0.1:1/none', 1);
    const app = buildServer({ pool, version: 't', logger: false });
    const r = await app.inject({ url: '/readyz' });
    expect(r.statusCode).toBe(503);
    expect(Health.parse(r.json())).toMatchObject({ status: 'degraded', database: 'down' });
    await pool.end();
  });

  const url = process.env.TEST_DATABASE_URL;
  (url ? it : it.skip)('readyz is 200 with a live database', async () => {
    const pool = createPool(url as string, 1);
    const app = buildServer({ pool, version: 't', logger: false });
    const r = await app.inject({ url: '/readyz' });
    expect(r.statusCode).toBe(200);
    expect(r.json().database).toBe('ok');
    await pool.end();
  });

  it('rejects bodies over 64 KB', async () => {
    const app = buildServer({ pool: null, version: 't', logger: false });
    app.post('/echo', async () => ({ ok: true }));
    const r = await app.inject({
      method: 'POST', url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ x: 'a'.repeat(70 * 1024) }),
    });
    expect(r.statusCode).toBe(413);
  });
});
