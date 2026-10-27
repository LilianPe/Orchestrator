import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeCheckRunner } from '../../src/adapters/checks/fake.js';
import { FakeForge } from '../../src/adapters/forge/fake.js';
import { FakePublisher } from '../../src/adapters/publisher/fake.js';
import { FakeRunner } from '../../src/adapters/runner/fake.js';
import { FakeSandboxProvider } from '../../src/adapters/sandbox/fake.js';
import { FakeTracker } from '../../src/adapters/tracker/fake.js';
import { FakeWorkspaces } from '../../src/adapters/workspace/fake.js';
import { loadWorkflow } from '../../src/config/load-workflow.js';
import type { Workflow } from '../../src/config/workflow-schema.js';
import { EventBus } from '../../src/core/bus.js';
import { FakeClock } from '../../src/core/clock.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { Scheduler } from '../../src/core/scheduler.js';
import { TimerService } from '../../src/core/timers.js';
import type { EventPayloads, EventType, FactoryEvent } from '../../src/core/types.js';
import type { Verifier } from '../../src/core/verify.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import type { Store } from '../../src/store/types.js';
import type { TestPreset } from './test-preset.js';

export const packDir = join(import.meta.dirname, '../../packs/standard');

/** The standard pack with `projectYaml` on top, as a project's workflow.yml; the temporary file is removed once read. */
export function loadTestWorkflow(projectYaml?: string): Workflow {
  if (!projectYaml) return loadWorkflow({ packDir });
  const dir = mkdtempSync(join(tmpdir(), 'factory-h-'));
  try {
    const projectFile = join(dir, 'workflow.yml');
    writeFileSync(projectFile, projectYaml);
    return loadWorkflow({ packDir, projectFile });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function createHarness(
  opts: {
    projectYaml?: string;
    preset?: TestPreset;
    verify?: Verifier;
    knowledge?: boolean;
    /** An empty store to run on instead of the in-memory SQLite one (the Postgres scenarios of test/integration). */
    store?: Store;
    /** Lease of a claimed outbox row (ORC-149); the orchestrator's default otherwise. */
    effectLeaseMs?: number;
    /** Retries of an inbox row whose processing throws (ORC-149); the orchestrator's default otherwise. */
    processRetry?: { attempts: number; baseMs: number };
  } = {},
) {
  if (opts.projectYaml !== undefined && opts.preset) throw new Error('createHarness: pass projectYaml or preset, not both');
  const workflow = loadTestWorkflow(opts.projectYaml ?? opts.preset?.yaml);
  const clock = new FakeClock(Date.UTC(2026, 9, 10, 9, 0));
  const store = opts.store ?? new SqliteStore(':memory:');
  const tracker = new FakeTracker(Object.values(workflow.states));
  const forge = new FakeForge();
  const runner = new FakeRunner(clock);
  const workspaces = new FakeWorkspaces();
  const checks = new FakeCheckRunner(opts.verify);
  const sandboxes = new FakeSandboxProvider();
  const publisher = new FakePublisher(forge);
  const project = { id: 'p', repoPath: '/repo', teamKey: 'REL', workflow };
  let n = 0;
  const build = () => new Orchestrator({
    store,
    clock,
    bus: new EventBus(),
    scheduler: new Scheduler(store, { dev: workflow.limits.parallelSessions, questions: workflow.limits.questionSessions }),
    tracker,
    forge,
    runner,
    workspaces,
    verify: checks.run,
    projects: [project],
    packDir,
    agentEnv: (r) => ({ FACTORY_RUN_TOKEN: r.token }),
    newId: () => `id-${++n}`,
    activityIntervalMs: 0,
    knowledgeConfigured: opts.knowledge,
    inboxRetry: { attempts: 3, baseMs: 1 },
    effectLeaseMs: opts.effectLeaseMs,
    processRetry: opts.processRetry,
  });
  let orch = build();
  const timers = new TimerService(store, clock, (e) => orch.accept(e));
  let seq = 0;

  async function send<T extends EventType>(type: T, payload: EventPayloads[T], ticketId = 'REL-1'): Promise<void> {
    await orch.accept({ id: `t-${++seq}`, type, at: clock.now(), projectId: 'p', ticketId, payload } as FactoryEvent);
    await orch.drained();
  }

  async function advance(ms: number): Promise<void> {
    clock.advance(ms);
    runner.tick();
    await timers.tick();
    await orch.drained();
  }

  /** Graceful shutdown, then a fresh orchestrator over the same store, as `factory up` does on restart. */
  async function restart(): Promise<void> {
    orch.stopAll();
    await orch.drained();
    orch = build();
    await orch.recover();
    await orch.announceRecovery();
    await orch.replayInbox();
    await orch.drained();
  }

  return {
    clock, store, tracker, forge, runner, workspaces, checks, sandboxes, publisher,
    send, advance, restart, project,
    get orch() {
      return orch;
    },
    ticket: async (id = 'REL-1') => (await store.getTicket('p', id))!,
  };
}
