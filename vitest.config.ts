import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

/**
 * The hooks of the Postgres projects create, migrate and drop databases, and a drop waits for a
 * checkpoint of the whole server. Vitest's 10 s fail on a stalled machine, not on a bug: on CI, a
 * checkpoint of 45 buffers took 14.5 s, and a file 75 times its usual time (docs/tests.md, ORC-290).
 */
const POSTGRES_HOOK_TIMEOUT = 60_000;

/**
 * Vitest's default (one worker per CPU but one), bounded: at 11 workers a drop waits 4 s, at 6 it
 * waits 0.6 s (docs/tests.md, ORC-290). An explicit number alone would raise a small CI runner's one worker.
 */
const POSTGRES_MAX_WORKERS = Math.max(1, Math.min(4, availableParallelism() - 1));

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
          hookTimeout: POSTGRES_HOOK_TIMEOUT,
          maxWorkers: POSTGRES_MAX_WORKERS,
          // One project at a time on Postgres, each with its own bound of workers.
          sequence: { groupOrder: 1 },
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
          hookTimeout: POSTGRES_HOOK_TIMEOUT,
          maxWorkers: POSTGRES_MAX_WORKERS,
          sequence: { groupOrder: 2 },
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
