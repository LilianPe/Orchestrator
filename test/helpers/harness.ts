import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeCheckRunner } from '../../src/adapters/checks/fake.js';
import { FakeForge } from '../../src/adapters/forge/fake.js';
import { FakePublisher } from '../../src/adapters/publisher/fake.js';
import { CachedRoleResolver } from '../../src/adapters/roles/cached.js';
import type { ProjectAuthz } from '../../src/adapters/roles/types.js';
import { FakeRunner } from '../../src/adapters/runner/fake.js';
import { FakeSandboxProvider } from '../../src/adapters/sandbox/fake.js';
import { FakeTracker } from '../../src/adapters/tracker/fake.js';
import { FakeWorkspaces } from '../../src/adapters/workspace/fake.js';
import { loadWorkflow } from '../../src/config/load-workflow.js';
import type { Workflow } from '../../src/config/workflow-schema.js';
import { EventBus } from '../../src/core/bus.js';
import { FakeClock } from '../../src/core/clock.js';
import type { RepoVariables } from '../../src/config/repo-variables.js';
import { Orchestrator, type ProjectRuntime } from '../../src/core/orchestrator.js';
import { Scheduler } from '../../src/core/scheduler.js';
import { TimerService } from '../../src/runtime/timers.js';
import type { EventPayloads, EventType, FactoryEvent, Taint } from '../../src/core/types.js';
import type { CleanVerifier, CleanVerifyRequest } from '../../src/core/clean-verify.js';
import type { Verifier } from '../../src/core/verify.js';
import type { EffectRetry } from '../../src/runtime/outbox.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import type { Store } from '../../src/store/types.js';
import type { Faults } from './faults.js';
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

/** REL-1 delegated, its dev run held by the runner: it stays `running` until released. */
export async function heldRun(h: ReturnType<typeof createHarness>): Promise<string> {
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
  h.runner.enqueue({ hold: true });
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
  return (await h.ticket()).activeRunId!;
}

export type StoreKind = 'sqlite' | 'postgres';

/**
 * The database of one harness (ORC-228). `connect` opens a store on it, read on the harness's
 * simulated clock (leases, backoffs, due rows), as a process does at its start: once when the
 * harness is created, then at each `restart`, always on the same database.
 */
export type HarnessDatabase = (now: () => number) => Store;

/** An in-memory SQLite database: a single store, which every life of the harness reconnects to. */
function sqliteDatabase(): HarnessDatabase {
  let store: SqliteStore | undefined;
  return (now) => (store ??= new SqliteStore(':memory:', now));
}

let databases: { kind: StoreKind; create: () => HarnessDatabase } = { kind: 'sqlite', create: sqliteDatabase };

/**
 * Where the harnesses created from now on keep their state: an in-memory SQLite database each by
 * default, a Postgres database each in the `scenarios-pg` project (test/helpers/pg-harness.ts).
 */
export function useHarnessDatabases(kind: StoreKind, create: () => HarnessDatabase): void {
  databases = { kind, create };
}

/** The database the scenarios run on, for the few written for one of them (a SQLite file, say). */
export const harnessStoreKind = (): StoreKind => databases.kind;

/**
 * A store as one process sees it: `kill()` is that process dying (`kill -9`). From then on none of
 * its calls reaches the database and none of their results comes back: a call not started never
 * starts; one under way runs to its end in the database, but its caller never hears of it. That is
 * a commit sent just before the death: a transaction cut before its commit, rolled back, is what a
 * really killed process gives (ORC-163, `crash-after-decision.ts`, and the `decide.after` fault of
 * `faults.ts`, which throws inside the transaction as it kills). The process's timers and pending
 * promises are left as they are, frozen on the store.
 *
 * `gate` puts an adapter of the same process behind the same death (ORC-163): once killed, the
 * process calls nothing outside any more (no comment, no activity, no run), and a call under way
 * that acted never answers.
 */
export function mortal(store: Store): { store: Store; kill(): void; gate<T extends object>(target: T): T } {
  let dead = false;
  const never = new Promise<never>(() => {});
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (dead) return never;
        // A wrapper that throws or answers synchronously is handled like any store call.
        return Promise.resolve()
          .then(() => (value as (...a: unknown[]) => unknown).apply(target, args))
          .then(
            (v) => (dead ? never : v),
            (err: unknown) => (dead ? never : Promise.reject(err)),
          );
      };
    },
  });
  /** A call of the live process, as it answers (synchronously or not); nothing once it is dead. */
  const call = (f: (...a: unknown[]) => unknown, self: unknown, args: unknown[]): unknown => {
    if (dead) return never;
    let result: unknown;
    try {
      result = f.apply(self, args);
    } catch (err) {
      if (dead) return never;
      throw err;
    }
    if (dead) return never;
    if (result instanceof Promise) {
      return result.then(
        (v: unknown) => (dead ? never : v),
        (err: unknown) => (dead ? never : Promise.reject(err)),
      );
    }
    return result;
  };
  const gate = <T extends object>(target: T): T =>
    new Proxy(target, {
      apply: (t, self, args: unknown[]) => call(t as (...a: unknown[]) => unknown, self, args),
      get(t, prop) {
        // Read at each call: a test that replaces an adapter's method (`h.tracker.moveTo = …`) is seen.
        const value: unknown = Reflect.get(t, prop, t);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => call(value as (...a: unknown[]) => unknown, t, args);
      },
    });
  return { store: proxy, kill: () => void (dead = true), gate };
}

export function createHarness(
  opts: {
    projectYaml?: string;
    preset?: TestPreset;
    verify?: Verifier;
    /** The clean check itself; by default its verdict comes from `checks`. */
    cleanVerify?: CleanVerifier;
    /** `false`: an instance with neither sandboxes nor `FACTORY_ALLOW_HOST_VERIFY`. */
    hostChecks?: boolean;
    knowledge?: boolean;
    /**
     * A store to run on instead of the harness's own database (the SQLite file a SIGKILLed child
     * left). It keeps its own clock: `advance` then moves no lease or backoff of it.
     */
    store?: Store;
    /** Wraps each store opened on the database (one that fails on purpose), whatever the database. */
    wrapStore?: (store: Store) => Store;
    /** Lease of a claimed outbox row (ORC-149); the orchestrator's default otherwise. */
    effectLeaseMs?: number;
    /** Retries of an inbox row whose processing throws (ORC-149); the orchestrator's default otherwise. */
    processRetry?: { attempts: number; baseMs: number };
    /** Retries of an effect that throws (ORC-150); default one attempt: a failed effect dies at once and blocks its ticket. */
    effectRetry?: EffectRetry;
    /**
     * The project's designations (ORC-186): given, the orchestrator resolves the roles of human events
     * through the harness's tracker (team members) and forge (repo permissions), and checks the matrix.
     */
    authz?: Partial<Pick<ProjectAuthz, 'maintainers' | 'validators' | 'githubLogins'>>;
    /**
     * The fault planned along the chain, and the ledger of the visible calls (ORC-163): each life of
     * the harness gets its store and its tracker and runner wrapped by it (`faults.ts`).
     */
    faults?: Faults;
    /** The simulated clock, for a process that must go on from a time another one reached (the chaos daemon). */
    clock?: FakeClock;
    /** One reconciliation of a project (ORC-185), run by the `reconcile` effect of its timer. */
    reconcile?: (project: ProjectRuntime) => Promise<void>;
    /** Runs in `sandboxes` (ORC-204), the ticket's session dirs in a temporary dir; on the host otherwise. */
    sandboxed?: boolean;
    /** What the runner gets of the repository (ORC-211). */
    repoVariables?: (project: ProjectRuntime) => Promise<RepoVariables>;
  } = {},
) {
  if (opts.projectYaml !== undefined && opts.preset) throw new Error('createHarness: pass projectYaml or preset, not both');
  const workflow = loadTestWorkflow(opts.projectYaml ?? opts.preset?.yaml);
  const clock = opts.clock ?? new FakeClock(Date.UTC(2026, 9, 10, 9, 0));
  const given = opts.store;
  const database: HarnessDatabase = given ? () => given : databases.create();
  const tracker = new FakeTracker(Object.values(workflow.states));
  const forge = new FakeForge();
  const runner = new FakeRunner(clock);
  const workspaces = new FakeWorkspaces();
  const checks = new FakeCheckRunner(opts.verify);
  const sandboxes = new FakeSandboxProvider();
  const publisher = new FakePublisher(forge);
  const sessionsDir = opts.sandboxed ? mkdtempSync(join(tmpdir(), 'factory-sessions-')) : undefined;
  const runsDir = opts.sandboxed ? mkdtempSync(join(tmpdir(), 'factory-runs-')) : undefined;
  /** The orchestrator's log lines, every life of it. */
  const logs: { level: string; message: string }[] = [];
  const project = { id: 'p', repoPath: '/repo', teamKey: 'REL', workflow };
  const authz = opts.authz && { teamKey: 'REL', repoPath: '/repo', maintainers: [], validators: [], githubLogins: {}, ...opts.authz };
  /** One life of the process: its store and its adapters, all of them silent once it is killed. */
  const connect = () => {
    let store = database(() => clock.now());
    if (opts.wrapStore) store = opts.wrapStore(store);
    let kill = () => {};
    const view = opts.faults?.life(() => kill());
    const life = mortal(view ? view.store(store) : store);
    kill = life.kill;
    const outside = {
      tracker: life.gate(view ? view.tracker(tracker) : tracker),
      runner: life.gate(view ? view.runner(runner) : runner),
      forge: life.gate(forge),
      forgeWriter: life.gate(forge),
      workspaces: life.gate(workspaces),
      verify: life.gate(checks.run),
      hostChecks: opts.hostChecks ?? true,
      originUrl: async () => '/origin',
      // The clean check is proved by itself (clean-verify.test.ts, the isolation suite): a scenario decides its verdict through the same fake.
      cleanVerify: opts.cleanVerify ?? (async (req: CleanVerifyRequest) => ({ ...(req.commands.length ? await life.gate(checks.run)(req.worktree, [...req.commands], undefined, {}) : { ok: true, failures: [] }), sha: (await workspaces.head(req.worktree)) ?? 'head', tree: 'clean-tree' })),
      // The proxy's journal of a run (ORC-296) beside its refusals log: a test writes both.
      ...(sessionsDir ? { sandboxes: life.gate(sandboxes), sessionsDir, runsDir, egressJournal: (id: string) => join(runsDir!, id, 'egress.jsonl') } : {}),
    };
    return { ...life, outside };
  };
  let life = connect();
  let n = 0;
  const build = ({ store, outside, gate }: ReturnType<typeof connect>) => new Orchestrator({
    store,
    clock,
    bus: (() => {
      const bus = new EventBus();
      bus.subscribe((m) => void (m.kind === 'log' && logs.push({ level: m.level, message: m.message })));
      return bus;
    })(),
    scheduler: new Scheduler(store, { dev: workflow.limits.parallelSessions, questions: workflow.limits.questionSessions }),
    ...outside,
    projects: [project],
    packDir,
    agentEnv: (r) => ({ FACTORY_RUN_TOKEN: r.token }),
    newId: () => `id-${++n}`,
    activityIntervalMs: 0,
    knowledgeConfigured: opts.knowledge,
    inboxRetry: { attempts: 3, baseMs: 1 },
    effectLeaseMs: opts.effectLeaseMs,
    processRetry: opts.processRetry,
    effectRetry: opts.effectRetry ?? { attempts: 1, baseMs: 1, capMs: 1 },
    // Each life resolves roles through its own adapters and keeps its own cache, as a process does.
    reconcile: opts.reconcile,
    repoVariables: opts.repoVariables,
    roles: authz && new CachedRoleResolver({ projects: (id) => (id === 'p' ? authz : undefined), team: gate(tracker), repo: outside.forge, now: () => clock.now() }),
  });
  let orch = build(life);
  // Holds nothing between ticks (ORC-161): the timers live in the store, a restart loses none.
  const timerService = (store: Store) => new TimerService(store, clock, () => orch.wake());
  let timers = timerService(life.store);
  let seq = 0;

  /** `signed`: the event's signed actor and taint, as the Linear ingestion stamps them (ORC-160). */
  async function send<T extends EventType>(type: T, payload: EventPayloads[T], ticketId = 'REL-1', signed: { actor?: string; taint?: Taint } = {}): Promise<void> {
    await orch.accept({ id: `t-${++seq}`, type, at: clock.now(), projectId: 'p', ticketId, ...signed, payload } as FactoryEvent);
    await orch.drained();
  }

  /**
   * Moves the simulated clock: the runs' duration caps, the timers due in the database (fired
   * through the inbox, ORC-161), and the leases and backoffs of the outbox and the queue, which the
   * store reads on the same clock.
   */
  async function advance(ms: number): Promise<void> {
    clock.advance(ms);
    runner.tick();
    await timers.tick();
    // The heartbeat, as the daemon's would by then: the leases of the attempts (ORC-220).
    await orch.supervise();
    // The worker's poll, as the daemon's loop would by then: rows held by a backoff or a lease go again.
    await orch.poll();
    await orch.drained();
  }

  /**
   * Another process over the same database, as `factory up` does on restart. `clean` (default): a
   * graceful shutdown first. `brutal`: the process dies as under `kill -9` (`mortal`): no stop, no
   * drain, no cleanup. Its claims stay in the database until their lease expires on the simulated
   * clock (`advance`); what it held in memory is gone.
   */
  async function restart({ mode = 'clean' }: { mode?: 'clean' | 'brutal' } = {}): Promise<void> {
    if (mode === 'clean') {
      orch.stopAll();
      await Promise.all([orch.drained(), timers.stop()]);
    } else {
      life.kill();
    }
    life = connect();
    orch = build(life);
    timers = timerService(life.store);
    await orch.recover();
    await orch.replayInbox();
    await orch.drained();
  }

  return {
    clock, tracker, forge, runner, workspaces, checks, sandboxes, publisher, sessionsDir, runsDir, logs,
    send, advance, restart, project,
    get orch() {
      return orch;
    },
    /** The store of the process alive now; a brutal restart leaves the dead one's frozen. */
    get store() {
      return life.store;
    },
    ticket: async (id = 'REL-1') => (await life.store.getTicket('p', id))!,
  };
}
