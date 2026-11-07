import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

/** What the projects on one Postgres share; the measures behind these numbers are in docs/tests.md (ORC-290). */
const onPostgres = {
  // A hook creates, migrates or drops databases, and a drop waits for a checkpoint of the whole server.
  // On a stalled CI runner a checkpoint of 45 buffers took 14.5 s, past Vitest's default of 10 s for a hook.
  hookTimeout: 60_000,
  // Vitest's default for a run (a worker per CPU but one), bounded: a drop's p90 is 4.2 s at 11 workers.
  // A bare 4 would raise a small CI runner's single worker.
  maxWorkers: Math.max(1, Math.min(4, availableParallelism() - 1)),
  // Vitest wants projects with another maxWorkers in another group; a same group shares that bound.
  sequence: { groupOrder: 1 },
};

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
          ...onPostgres,
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
          // A scenario is up to ~1,700 queries one after the other: 41 s at 24 ms a query on a loaded machine (docs/tests.md).
          testTimeout: 90_000,
          ...onPostgres,
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
