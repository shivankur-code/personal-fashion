import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    // Database suites share one test database, so files run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
