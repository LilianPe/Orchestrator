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
          // Many of these tests spawn real processes (git, bash, node): their time is the machine's load, not their
          // own (ORC-325). Two `npm test` at once on an 8-CPU machine: 85 to 89 tests past 15 s, the slowest at 59 s
          // (git-workspaces, host-git, verify, publish, worker's SIGKILL scenarios). 120 s is twice that. It bounds a
          // hang only: a passing test takes no longer for it. One bound for the project rather than a list of files
          // that spawn, which would rot; a test needing more says so itself.
          testTimeout: 120_000,
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
          testTimeout: 30000,
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
