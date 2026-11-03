import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'web/src/**/*.test.ts'],
          exclude: ['test/integration/**', 'test/isolation/**', 'test/chaos/**'],
          environment: 'node',
          testTimeout: 15000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30000,
        },
      },
      {
        // The scenarios again, each harness on a Postgres database of its own (ORC-228): run with
        // the integration project, skipped without DATABASE_URL.
        test: {
          name: 'scenarios-pg',
          include: ['test/scenarios/**/*.test.ts'],
          setupFiles: ['test/helpers/pg-harness.ts'],
          environment: 'node',
          testTimeout: 30000,
        },
      },
      {
        // A real daemon killed with SIGKILL at random moments (ORC-163): on Postgres with DATABASE_URL,
        // on a SQLite file otherwise. Its own CI job, with CHAOS_EVENTS=500 (docs/tests.md).
        test: {
          name: 'chaos',
          include: ['test/chaos/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30 * 60_000,
        },
      },
      {
        test: {
          name: 'isolation',
          include: ['test/isolation/**/*.test.ts'],
          globalSetup: ['test/isolation/global-setup.ts'],
          environment: 'node',
          testTimeout: 120000,
        },
      },
    ],
  },
});
