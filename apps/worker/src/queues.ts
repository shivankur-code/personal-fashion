import { PgBoss } from 'pg-boss';

export const DEAD_LETTER = 'dead-letter';

/**
 * Every queue retries with exponential backoff, gives up after 5 attempts (retryLimit 4 + the first try),
 * and then copies the job to the dead-letter queue, where an alert picks it up.
 */
const common = {
  retryLimit: 4,
  retryBackoff: true,
  expireInSeconds: 300,
  deadLetter: DEAD_LETTER,
} as const;

export const QUEUES = {
  jobSteps: { name: 'job-steps', ...common },
  render: { name: 'render', ...common },
  catalog: { name: 'catalog', ...common },
  privacy: { name: 'privacy', ...common },
} as const;

export function createBoss(url: string, max = Number(process.env.PG_POOL_MAX ?? 3)): PgBoss {
  const boss = new PgBoss({ connectionString: url, max, application_name: 'stylist-worker' });
  boss.on('error', (err) => console.error(JSON.stringify({ level: 'error', msg: 'pg-boss', err: String(err) })));
  return boss;
}

/** Creates the dead-letter queue first, then every work queue. Safe to call on every start. */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  if (!(await boss.getQueue(DEAD_LETTER))) await boss.createQueue(DEAD_LETTER);
  for (const q of Object.values(QUEUES)) {
    const { name, ...options } = q;
    if (!(await boss.getQueue(name))) await boss.createQueue(name, options);
  }
}
