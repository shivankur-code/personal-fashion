// Two modes:
//   node main.js              -> long-running pg-boss workers (the "worker" Container App)
//   node main.js job <name>   -> run one job and exit 0/1 (the Container Apps jobs)
import { createPool, isDatabaseConfigured } from '@stylist/db';
import { cleanup, grantMonthlyCredits, healthcheck, JOB_NAMES, migrate, sweep, type JobName } from './jobs.js';
import { log } from './log.js';
import { createBoss, ensureQueues, QUEUES } from './queues.js';

async function runJob(name: JobName): Promise<void> {
  if (name === 'healthcheck') return healthcheck(process.env.API_URL);
  const url = process.env.DATABASE_URL;
  if (!isDatabaseConfigured(url)) throw new Error('DATABASE_URL is not set');
  const pool = createPool(url, Number(process.env.PG_POOL_MAX ?? 1));
  try {
    const ctx = { pool, databaseUrl: url };
    if (name === 'migrate') await migrate(ctx);
    else if (name === 'sweep') await sweep(ctx);
    else if (name === 'grant-monthly-credits') await grantMonthlyCredits(ctx);
    else if (name === 'cleanup') await cleanup(ctx);
  } finally {
    await pool.end();
  }
}

async function runWorkers(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!isDatabaseConfigured(url)) throw new Error('DATABASE_URL is not set');
  const boss = createBoss(url);
  await boss.start();
  await ensureQueues(boss);
  // M0: handlers only acknowledge. Real pipeline steps arrive in M6.
  for (const q of Object.values(QUEUES)) {
    await boss.work(q.name, async (jobs) => {
      for (const job of jobs) log('info', 'job received', { queue: q.name, id: job.id });
    });
  }
  log('info', 'workers started', { queues: Object.values(QUEUES).map((q) => q.name) });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      log('info', 'stopping workers', { signal });
      void boss.stop({ graceful: true }).then(() => process.exit(0), () => process.exit(1));
    });
  }
}

const [mode, name] = process.argv.slice(2);
if (mode === 'job') {
  if (!JOB_NAMES.includes(name as JobName)) {
    log('error', 'unknown job', { name, known: JOB_NAMES });
    process.exit(2);
  }
  runJob(name as JobName).then(
    () => process.exit(0),
    (err: unknown) => { log('error', 'job failed', { name, err: String(err) }); process.exit(1); },
  );
} else {
  runWorkers().catch((err: unknown) => { log('error', 'worker crashed', { err: String(err) }); process.exit(1); });
}
