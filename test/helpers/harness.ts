import { mkdtempSync, writeFileSync } from 'node:fs';
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
import { EventBus } from '../../src/core/bus.js';
import { FakeClock } from '../../src/core/clock.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { Scheduler } from '../../src/core/scheduler.js';
import { TimerService } from '../../src/core/timers.js';
import type { EventPayloads, EventType, FactoryEvent } from '../../src/core/types.js';
import type { Verifier } from '../../src/core/verify.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import type { TestPreset } from './test-preset.js';

export const packDir = join(import.meta.dirname, '../../packs/standard');

export function createHarness(
  opts: { projectYaml?: string; preset?: TestPreset; verify?: Verifier; knowledge?: boolean } = {},
) {
  if (opts.projectYaml !== undefined && opts.preset) throw new Error('createHarness: pass projectYaml or preset, not both');
  const projectYaml = opts.projectYaml ?? opts.preset?.yaml;
  let projectFile: string | undefined;
  if (projectYaml) {
    projectFile = join(mkdtempSync(join(tmpdir(), 'factory-h-')), 'workflow.yml');
    writeFileSync(projectFile, projectYaml);
  }
  const workflow = loadWorkflow({ packDir, projectFile });
  const clock = new FakeClock(Date.UTC(2026, 9, 10, 9, 0));
  const store = new SqliteStore(':memory:');
  const tracker = new FakeTracker();
  const forge = new FakeForge();
  const runner = new FakeRunner();
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
  });
  let orch = build();
  const timers = new TimerService(store, clock, (e) => void orch.submit(e));
  let seq = 0;

  async function send<T extends EventType>(type: T, payload: EventPayloads[T], ticketId = 'REL-1'): Promise<void> {
    await orch.submit({ id: `t-${++seq}`, type, at: clock.now(), projectId: 'p', ticketId, payload } as FactoryEvent);
    await orch.idle();
  }

  async function advance(ms: number): Promise<void> {
    clock.advance(ms);
    timers.tick();
    await orch.idle();
  }

  /** Graceful shutdown, then a fresh orchestrator over the same store, as `factory up` does on restart. */
  async function restart(): Promise<void> {
    orch.stopAll();
    await orch.idle();
    orch = build();
    orch.recover();
    await orch.announceRecovery();
  }

  return {
    clock, store, tracker, forge, runner, workspaces, checks, sandboxes, publisher,
    send, advance, restart, project,
    get orch() {
      return orch;
    },
    ticket: (id = 'REL-1') => store.getTicket('p', id)!,
  };
}
