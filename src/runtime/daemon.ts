import { randomUUID } from 'node:crypto';
import type { ArtifactHost, Forge, ForgeWriter } from '../adapters/forge/types.js';
import type { SecretRef } from '../adapters/secrets/types.js';
import type { Publisher } from '../adapters/publisher/types.js';
import type { RoleResolver } from '../adapters/roles/types.js';
import type { RunHandle, Runner } from '../adapters/runner/types.js';
import type { Sandbox, SandboxProvider, SpawnCommand } from '../adapters/sandbox/types.js';
import { IssueNotFoundError, type LabelsWritten, type Tracker, type TrackerIssue } from '../adapters/tracker/types.js';
import type { ReplayedTicket, ReplaySource } from '../ghost/delegate.js';
import type { WorkspaceManager } from '../adapters/workspace/types.js';
import type { RepoVariables } from '../config/repo-variables.js';
import type { RepoConfig, RepoConfigRead } from '../config/repo-config.js';
import type { Workflow } from '../core/workflow.js';
import type { AckMode } from '../config/factory-yml.js';
import type { EffectRetry } from './outbox.js';
import { backoff, isTransient, type RetryPolicy } from './transient.js';
import { RUN_LEASE_MS, type DecisionOutcome, type DecisionRequest, type EffectOutcome, type OutboxRow, type RunRecord, type Store } from '../store/types.js';
import { OutputPolicy } from '../publish/output-policy.js';
import type { EventBus } from '../server/live-feed.js';
import type { Clock } from '../core/clock.js';
import type { Effect } from '../core/decision.js';
import { deadLetteredEvent, repairedEvent } from '../core/dead-letter.js';
import type { HeldRow } from '../core/diagnosis.js';
import { NO_PLAN, planDecision } from '../core/decision-plan.js';
import { HUMAN_EVENTS, mayCheck } from '../core/engine.js';
import type { KbIndex } from '../knowledge/kb.js';
import type { PreviewRecipes } from '../knowledge/preview-recipe.js';
import { samePending } from '../core/reduce.js';
import type { StoredEvent } from '../core/upcast.js';
import type { Scheduler } from './capacity.js';
import { CREATES_TICKET, type EventPayloads, type IssueSnapshot, type LogicalState, type FactoryEvent, type RunOutcome, type TicketState, TRUSTED } from '../core/types.js';
import type { RegistryOpener } from '../checks/registry.js';
import type { CleanVerifier } from '../core/clean-verify.js';
import type { DryRun, DryRunRequest } from '../core/dry-run.js';
import type { Verifier } from '../core/verify.js';
import type { VisualShooter } from '../adapters/browser/types.js';
import { isTakenOver } from '../core/block-cause.js';
import { type EffectKey, endFacts, endKey, stagnationBounds, storedOutput, takeOverKey } from './daemon-base.js';
import { DaemonLaunch } from './launch.js';

export interface ProjectRuntime {
  id: string;
  repoPath: string;
  teamKey: string;
  workflow: Workflow;
  /**
   * `none` (ORC-231): nothing of the project's leaves the factory, no push, no PR, no comment; the outbox keeps each such effect
   * as an artifact of its run instead (`keptEffectsDir`). The replay of closed tickets runs so, and a prompt tried out.
   */
  effects?: 'none';
  /**
   * Set by `runtimeFor` on a ticket of a replay of closed tickets (ORC-376): its run reads the ticket as it was at its start, its
   * thread and linked tickets with it, and works on the clone at that start, which `repoPath` then names.
   */
  replayed?: Pick<ReplayedTicket, 'issue' | 'history' | 'knowledge'>;
}

export interface DaemonDeps {
  store: Store;
  clock: Clock;
  bus: EventBus;
  scheduler: Scheduler;
  tracker: Tracker;
  forge: Forge;
  /** One reconciliation of a project (ORC-185): Linear and GitHub compared to the factory's state, into the inbox. */
  reconcile?: (project: ProjectRuntime) => Promise<void>;
  /** Records the factory's own label write in the labels the reconciliation compares Linear with (ORC-346). */
  labelsWritten?: (projectId: string, ticketId: string, written: LabelsWritten) => Promise<void>;
  /** The factory's writes on the forge (ORC-148: the merge); absent with the `gh` CLI, which merges nothing. */
  forgeWriter?: ForgeWriter;
  /**
   * Where the visual proof's captures are shown from in a PR (ORC-407): the repository's `factory/artifacts` branch, by the GitHub
   * App. Absent: a PR says its captures were taken and not shown.
   */
  captureHost?: ArtifactHost;
  /**
   * The policy in front of every text the orchestrator publishes (ORC-214): its comments and activities, the PR's text. Absent: one
   * without gitleaks, for a test or the fake runner's daemon; the daemon's scans in its sandboxes.
   */
  outputPolicy?: OutputPolicy;
  /** The factory publishes what `verify` found green (ORC-125); absent without sandboxes or a GitHub App, a ticket that gets there is blocked and told why. */
  publisher?: Publisher;
  runner: Runner;
  workspaces: WorkspaceManager;
  verify: Verifier;
  /**
   * The agent's code may run on the daemon's host when there are no sandboxes: `verify`, `red`. Off, they answer an
   * infrastructure failure: without an explicit `FACTORY_ALLOW_HOST_VERIFY=1`, an instance that lost its sandboxes
   * does not fall back on running that code next to its secrets. Ignored with `sandboxes`, which are never fallen back from.
   */
  hostChecks?: boolean;
  /** `verify` with sandboxes (ORC-151); a test replaces it. */
  cleanVerify?: CleanVerifier;
  /** The dry run (ORC-408); a test replaces it. */
  dryRunner?: (req: DryRunRequest) => Promise<DryRun>;
  /** The image the sandboxes run (`FACTORY_RUNNER_IMAGE`), in the dry run's fingerprint (ORC-408); required for a dry run. */
  runnerImage?: string;
  /** The package registries `verify` asks (`factory/dependances`, ORC-371), through the egress proxy. */
  registries?: RegistryOpener;
  projects: ProjectRuntime[];
  packDir: string;
  /** `--settings` file for runs; defaults to <packDir>/settings.json. */
  settingsPath?: string;
  /**
   * Each attempt runs in a sandbox of its own (ORC-204), made at its launch and destroyed when it
   * ends; `setup` runs there too. Absent: runs and `setup` on the host (fake runner, tests).
   */
  sandboxes?: SandboxProvider;
  /** Where each ticket's Claude session dir lives on the host (`<sessionsDir>/<project>/<ticket>`); required with `sandboxes`. */
  sessionsDir?: string;
  /**
   * Per-run host dirs (`<runsDir>/<runId>`, ORC-217): `refusals/`, the hook's refusals log of every
   * sandboxed run, kept 30 days; `claude/`, the `~/.claude` of a run out of the ticket session, removed
   * with its sandbox. Required with `sandboxes`.
   */
  runsDir?: string;
  /**
   * The visual proof (ORC-176), with sandboxes that offer a browser: its `shooter`, and where its captures are kept,
   * `<artifactsDir>/<ticket>/<sha256>.png`, on the daemon's disk, out of every mount of a run. Absent, a required proof is unavailable, indicative.
   */
  visualProof?: { shooter: VisualShooter; artifactsDir: string };
  /**
   * The start recipes the factory validated (ORC-386), in the knowledge base: `verify` starts the application by the repository's
   * recipe when nothing is declared, and without one the `build` agent is asked to find it. Absent: none learned nor searched.
   */
  previewRecipes?: PreviewRecipes;
  /**
   * The fingerprint of the files that decide how the application starts, on the repository's default branch (ORC-406): three
   * searches that found no recipe ask none more while it holds. Absent, or undefined where git cannot read it: the last one holds.
   */
  startFingerprint?: (project: ProjectRuntime) => Promise<string | undefined>;
  /**
   * Where the effects of a project without effects are kept (ORC-231), `<keptEffectsDir>/<ticket>/<row>.json`, each with its row in
   * `artifacts`. Absent, such an effect fails: its ticket is blocked, nothing goes out.
   */
  keptEffectsDir?: string;
  /** The replay of closed tickets (ORC-376): where a replayed ticket of a project without effects runs, and what it reads. */
  replays?: ReplaySource;
  /** The egress proxy's journal of a run (`EgressProxy.journalPath`), read into its security log (ORC-296). */
  egressJournal?: (runId: string) => string;
  /** Where the runner keeps the runs' transcripts (ORC-132): the answer agent reads the session at work there (ORC-182). Absent: it reads none. */
  transcriptsDir?: string;
  agentEnv: (run: RunRecord) => Record<string, string>;
  /**
   * Repository-relative paths a run of this ticket reads whole past the pack's read threshold (ORC-279): the frozen
   * tests (ORC-131). ORC-212 will add the ticket's spec.
   */
  fullReadPaths?: (ticket: TicketState) => readonly string[];
  /** What the runner gets of the repository, from its config (ORC-211). Absent: nothing. */
  repoVariables?: (project: ProjectRuntime, config: RepoConfig) => Promise<RepoVariables>;
  /**
   * The values of a setup's secrets, from their sources (ORC-308): read at each setup that gets them, never before. It rejects,
   * naming the secret and its reference, never a value. Absent: a setup that needs a secret fails.
   */
  readSecrets?: (refs: Readonly<Record<string, SecretRef>>) => Promise<Record<string, string>>;
  /**
   * `.factory/config.yml` on the repository's default branch, read once at each launch (ORC-209 C); it rejects on an
   * invalid file. Absent: the socle, as for a repository without the file.
   */
  repoConfig?: (project: ProjectRuntime, read?: RepoConfigRead) => Promise<RepoConfig>;
  /** Where a project's base branch is fetched (ORC-151): required with `sandboxes`. */
  originUrl?: (project: ProjectRuntime) => Promise<string>;
  /** `budgets.per_ticket_tokens` of factory.yml (ORC-340): a ticket past it is blocked before its next run. The repository's own cap lowers it. */
  perTicketTokens?: number;
  /** `max_diff: off` of factory.yml (ORC-381): `verify` bounds the diff's size only where the repository's `max_diff` does. */
  maxDiff?: 'off';
  /** `budgets.on_usage_limit` of factory.yml (ORC-340): `wait`, a run stopped by the usage limit resumes at its reset. Absent: it blocks, as any failure. */
  onUsageLimit?: 'wait';
  /** `acknowledge` of factory.yml (ORC-380): `reaction` reacts on the message in place of the ack's comment. Absent: `comment`. */
  acknowledge?: AckMode;
  /** Why the configuration lets no ticket reach its end (ORC-350): while any, nothing is launched; events and effects go on. */
  configProblems?: readonly string[];
  /** The Claude account runs use (`claude.active`, ORC-211), asked at each launch (ORC-215): a usage limit holds the launches of that account only. Absent: `default`. */
  claudeAccount?: () => string | undefined;
  newId?: () => string;
  activityIntervalMs?: number;
  /**
   * The knowledge index, read at each launch (ORC-232): the server pulls the knowledge repository and reads its INDEX.md,
   * capped. The session gets it in its system prompt, and the rest through the MCP's `kb_search`. Absent: no knowledge base.
   * `repo`, another checkout of it: a replayed ticket's, at transaction time (ORC-376).
   */
  knowledgeIndex?: (repo?: string) => Promise<KbIndex>;
  /**
   * Retries of the inbox write of a run or check result (ORC-147): `attempts` writes in all, the
   * n-th retry after `baseMs * 2^(n-1)`. Default 5 writes from 200 ms (about 3 s in all).
   */
  inboxRetry?: RetryPolicy;
  /**
   * The daemon's start: events accepted before `replayInbox()` are only written, not processed,
   * so the inbox is not dispatched before the tracker is connected. Default false (tests).
   */
  holdInboxUntilReplay?: boolean;
  /** Lease of a claimed outbox row or queue item (ORC-149, ORC-150); default 60 s, renewed every 20 s while it runs. */
  effectLeaseMs?: number;
  /** Retries of an effect that throws (ORC-150); default `EFFECT_RETRY` (8 attempts, 1 s doubled, 5 min at most). */
  effectRetry?: EffectRetry;
  /** Retries of an inbox row whose processing throws (ORC-149); default `PROCESS_RETRY`. */
  processRetry?: RetryPolicy;
  /** The factory build's commit, labelled on each attempt; defaults to `FACTORY_COMMIT`, else null (ORC-226). */
  factoryCommit?: string | null;
  /**
   * Resolves the roles of a human event's signed actor before its decision (ORC-186): `decide` then
   * checks the authorization matrix on them. Without it (tests), no event carries roles and nothing is
   * checked; the daemon always passes one.
   */
  roles?: RoleResolver;
}

/** The `meta` key of the installation's id (`instanceId`). */
const INSTANCE_KEY = 'instance-id';

export function logicalFromName(states: Workflow['states'], name: string): LogicalState | undefined {
  return (Object.entries(states) as [LogicalState, string][]).find(([, n]) => n === name)?.[0];
}

/** The event of an attempt gone without a result (ORC-220), once per attempt by its id. */
function lostEvent(run: Pick<RunRecord, 'id' | 'projectId' | 'ticketId' | 'job'>, cause: EventPayloads['run.lost']['cause'], at: number): FactoryEvent<'run.lost'> {
  return { ...TRUSTED, id: `attempt:${run.id}:lost`, type: 'run.lost', at, projectId: run.projectId, ticketId: run.ticketId, payload: { runId: run.id, job: run.job, cause } };
}

/** What the dashboard reaches of a take-over (ORC-234): absent without sandboxes, where there is none. */
export interface TakeOverDesk {
  /** The host command of a shell in the ticket's take-over container; undefined when none is open. */
  attach(projectId: string, ticketId: string): Promise<SpawnCommand | undefined>;
  /** A bundle handed back, kept where the factory reads it (`<runsDir>/bundle-<project>-<ticket>/`): its path. */
  keepBundle(projectId: string, ticketId: string, bytes: Uint8Array): Promise<string>;
}

export class Daemon extends DaemonLaunch {
  /**
   * The one way in for an event (ORC-147): writes it to the inbox and resolves once the row is
   * committed, then lets the worker process it from the inbox. Resolves `false` for an id the
   * inbox already holds (a duplicate: nothing more happens). Rejects when the write fails: the
   * event was not taken, and the producer must report it (a webhook answers 500).
   */
  accept(event: FactoryEvent | StoredEvent): Promise<boolean> {
    const write = this.d.store.appendInbox(event).then((fresh) => {
      if (fresh) this.wake();
      return fresh;
    });
    // drained() waits for writes in flight too: their event is about to be processed.
    const tracked: Promise<void> = write.then(
      () => void this.writes.delete(tracked),
      () => void this.writes.delete(tracked),
    );
    this.writes.add(tracked);
    return write;
  }

  /** An inbox row was written outside `accept` (a timer's firing, ORC-161): the worker processes it now. */
  wake(): void {
    if (this.dispatchOpen) this.worker.kickInBackground();
  }

  /**
   * Processes the inbox rows and outbox effects a previous process left (written, then a crash or
   * a failed processing), oldest first. `factory up` calls it once at start, after `recover()`,
   * through `startWorker`.
   */
  async replayInbox(): Promise<void> {
    this.dispatchOpen = true;
    await this.worker.kick();
  }

  /**
   * One poll of the worker's loop (`startWorker`), for a caller that drives its own clock: the
   * scenario harness's `advance` (ORC-228), as the poller would once the simulated time passed.
   */
  async poll(): Promise<void> {
    if (this.dispatchOpen && !this.stopping) await this.worker.poll();
  }

  /** `replayInbox`, then polls the store: rows written by another process, leases that expired. */
  startWorker(intervalMs = 1000): Promise<void> {
    this.worker.start(intervalMs);
    return this.replayInbox();
  }

  /** A result the orchestrator produces itself (a check, a run lost): `deliver`ed to the inbox. */
  protected submitResult(event: FactoryEvent): Promise<void> {
    return this.deliver(event.id, `event ${event.id} (${event.type})`, async () => void (await this.accept(event)));
  }

  /**
   * For the results the orchestrator produces itself (run finished, checks): nobody resends them, so a failed write is
   * retried with a short backoff. Still failing transiently (`isTransient`: the database down), it is kept and written
   * again at each beat, with no bound but this process's life (ORC-343): the ticket and its slot go on once the database
   * is back. A permanent failure gives up with an error (the run's slot is then held until `recover()` at the next
   * start), as does a shutdown, which leaves it to that `recover()`. `write` must be idempotent: the inbox keeps an id once.
   */
  protected async deliver(id: string, what: string, write: () => Promise<void>): Promise<void> {
    const policy = this.d.inboxRetry ?? { attempts: 5, baseMs: 200 };
    for (let n = 1; ; n++) {
      try {
        await write();
        return;
      } catch (err) {
        if (n < policy.attempts) {
          await new Promise((resolve) => setTimeout(resolve, backoff(policy, n)));
          continue;
        }
        const kept = isTransient(err) && !this.stopping;
        this.log('error', `${what} not written to the inbox after ${n} attempts, ${kept ? 'written again at each beat' : 'lost'}: ${(err as Error).message}`);
        if (kept) this.unwritten.set(id, { what, write });
        return;
      }
    }
  }

  /** Writes again the results `deliver` kept (ORC-343), oldest first. One still failing transiently waits for the next beat. */
  private async deliverKept(): Promise<void> {
    for (const [id, { what, write }] of this.unwritten) {
      try {
        await write();
        this.unwritten.delete(id);
        this.log('info', `${what} written to the inbox`);
      } catch (err) {
        // The same outage for all of them: the next beat tries again, without waiting for each one's timeout in turn.
        if (isTransient(err)) return;
        this.unwritten.delete(id);
        this.log('error', `${what} not written to the inbox, lost: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Waits until this process has nothing left to do with the inbox and the outbox (ORC-149, in
   * place of the event chain's `idle()`): no inbox write in flight, no pending row or claimable
   * effect it can still process, no worker task running, and no background work (checks, the end
   * of a run) about to write to the inbox. Runs still streaming are not waited for. Rows this
   * process skipped (a failed processing) or left to another worker do not count.
   */
  async drained(): Promise<void> {
    for (;;) {
      // Note: setImmediate is incompatible with fake timers (vi.useFakeTimers fakes it by default).
      // Let promise continuations of a just-released/finished runner settle before sampling the state.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.all(this.writes);
      // After stopAll(), only what is already handed out (or accepted here) is finished: a daemon
      // shutting down does not take up the rows another process left.
      const kick = () => (this.stopping || !this.dispatchOpen ? Promise.resolve(0) : this.worker.kick());
      const handed = await kick();
      await this.worker.settle();
      const pending = this.pendingBackground();
      await Promise.all(pending);
      // What settled may have written rows (a run's result once its pump ends): read the inbox again.
      const more = await kick();
      if (handed === 0 && more === 0 && pending.length === 0 && this.writes.size === 0 && this.pendingBackground().length === 0) return;
    }
  }

  private pendingBackground(): Promise<void>[] {
    return [...this.background].filter(([, runId]) => runId === undefined || !this.liveRuns.has(runId)).map(([p]) => p);
  }

  /**
   * Takes up what a crash (`running`) or a shutdown (`interrupted`) left (ORC-220), without a human:
   *
   * - an attempt still alive in its container is reattached to: it goes on, and its real result comes back;
   * - an attempt gone gets `run.lost`, whose decision starts its step again (a question: tells its thread);
   * - a result recorded and never sent is sent, with the id it would have had: nothing runs twice;
   * - a check cut gets `verify.lost`, whose decision runs it again;
   * - a run named by its ticket and never written is a launch cut before it: nothing started it, and the
   *   start taken up again launches it (`startHandled`, ORC-277); the ticket just lets go of it.
   *
   * A run or check whose result is in the inbox, written before the crash and not yet processed, is
   * left alone: the inbox replay settles it with its real result. So is one whose result is set aside
   * in `dead_letter`, open (ORC-321): its repair (`factory run repair`) is the decision. Everything goes through the inbox,
   * written before the status it replaces, so a kill at any point leaves it to the next recover(), and
   * the event is written once (by its id; a check, which can be cut again under one run, by the scan of the
   * inbox). Nothing is woken here: the worker starts after, on the sandboxes
   * of the dead attempts destroyed.
   */
  async recover(): Promise<void> {
    const { store, clock } = this.d;
    const cut = await store.runsByStatus('running');
    const tickets = await store.listTickets();
    const ticketOf = (run: RunRecord) => tickets.find((x) => x.projectId === run.projectId && x.ticketId === run.ticketId);
    // By what was taken up, not by the handles: an attempt found ended is gone from them as soon as it is attached.
    const attached = new Set<string>();
    for (const run of cut) if (await this.attach(run, ticketOf(run))) attached.add(run.id);
    await this.destroyDeadSandboxes(new Set(tickets.filter(isTakenOver).map((t) => takeOverKey(t.projectId, t.ticketId))));
    const settled = new Set<string>();
    const checked = new Set<string>();
    // A repair in the inbox carries its result; the inbox read first, a row set aside meanwhile is found among the open dead letters.
    const pending = (await store.pendingInbox(Number.MAX_SAFE_INTEGER)).map(deadLetteredEvent);
    const setAside = (await store.deadLetters()).filter((d) => d.status === 'open').map((d) => d.event);
    for (const row of [...pending, ...setAside]) {
      if (row.type === 'run.finished' || row.type === 'run.lost') settled.add((row.payload as EventPayloads['run.lost']).runId);
      if (row.type === 'verify.passed' || row.type === 'verify.failed' || row.type === 'verify.errored' || row.type === 'verify.lost' || row.type === 'publish.done' || row.type === 'publish.refused') checked.add((row.payload as EventPayloads['verify.lost']).runId);
    }
    const interrupted = await store.runsByStatus('interrupted');
    for (const found of [...cut, ...interrupted]) {
      if (attached.has(found.id)) continue;
      // Taken over before it is closed (ORC-344): a daemon that still follows it writes nothing more of it; one that took it first keeps it.
      const run = found.status === 'running' ? await this.takeOver(found.id) : found;
      if (!run) continue;
      // A dev attempt its ticket no longer holds (stopped, replaced) leaves nothing to start again.
      const lost = run.queue === 'dev' ? ticketOf(run)?.activeRunId === run.id : run.linearSessionId !== undefined;
      if (lost && !settled.has(run.id)) {
        await store.appendInbox(lostEvent(run, 'restart', clock.now()));
        settled.add(run.id);
      }
      await store.putRun({ ...run, status: run.status === 'interrupted' ? 'stopped' : 'failure', endedAt: run.endedAt ?? clock.now() }, run.leaseToken ?? 0);
    }
    for (const t of tickets) {
      if (t.activeRunId && !attached.has(t.activeRunId) && !settled.has(t.activeRunId)) await this.recoverActive(t, t.activeRunId);
      if (t.verifyingRunId && !checked.has(t.verifyingRunId)) await this.recoverCheck(t, t.verifyingRunId);
    }
  }

  /**
   * Its ticket still holds it, its sandbox still runs and its runner can take it up: the attempt goes on
   * under this process. A dev attempt the ticket let go of is not taken up, alive or not: another may have its place.
   */
  private async attach(cut: RunRecord, ticket: TicketState | undefined): Promise<boolean> {
    const { sandboxes, runner, clock, store, scheduler } = this.d;
    if (cut.queue === 'dev' && ticket?.activeRunId !== cut.id) return false;
    let handle: RunHandle | undefined;
    try {
      const project = await this.runtimeFor(cut.projectId, cut.ticketId, ticket ?? null);
      const job = project?.workflow.jobs[cut.job];
      if (!project || !job || !runner.attach) return false;
      // Taken from whoever followed it, a daemon stopped or still alive: from now on its writes of it are refused (ORC-344).
      const run = await this.takeOver(cut.id);
      if (!run) return false;
      const sandbox = sandboxes && (await sandboxes.reattach(run.id));
      if (sandboxes && !sandbox) return false;
      // The limits it was launched with: the ticket's token budget may have lowered the job's (ORC-340).
      const bounds = stagnationBounds(project.workflow, job);
      handle = runner.attach({ runId: run.id, limits: run.limits ?? job.limits, model: job.model, elapsedMs: clock.now() - run.startedAt, env: this.d.agentEnv(run), ...bounds });
      if (!handle) return false;
      await store.renewRun(run.id, clock.now() + RUN_LEASE_MS, run.leaseToken);
      // Its slot, in the memory of this process. Over a capacity lowered meanwhile, it goes on all the same.
      scheduler.tryAcquire(run.queue, `${run.ticketId}:${run.queue}`);
      this.follow(run.id, handle, run.leaseToken!, bounds.stagnation.silentMs);
      this.liveRuns.add(run.id);
      this.track(this.pump(run, job.step ?? job.name, handle, sandbox?.id), run.id);
      this.log('info', `run ${run.id} of ${run.ticketId} still alive: reattached`);
      return true;
    } catch (err) {
      // Taken up and not followed: stopped, since its step starts again.
      handle?.stop();
      this.log('warn', `run ${cut.id} not reattached, its step starts again: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Takes an attempt over from whoever held its lease (ORC-344): its record as it is now, under the token raised for this
   * process. Undefined when it ended, or when another daemon took it first.
   */
  private async takeOver(id: string): Promise<RunRecord | undefined> {
    const rec = await this.d.store.getRun(id);
    if (rec?.status !== 'running') return undefined;
    const token = await this.d.store.claimRun(id, rec.leaseToken ?? 0);
    return token === undefined ? undefined : { ...rec, leaseToken: token };
  }

  /** An attempt this process follows from now on (ORC-344): its handle, its lease token, its progress counted from now. */
  protected follow(runId: string, handle: RunHandle, token: number, silentMs: number): void {
    this.handles.set(runId, handle);
    this.held.set(runId, { token, seenAt: this.d.clock.now(), silentMs });
  }

  /** Followed no more, and left running (ORC-344): nothing of it is written here (its pump finds it no longer `held`), its sandbox and its workspace stay. */
  private letGo(runId: string): void {
    this.handles.get(runId)?.detach?.();
    this.handles.delete(runId);
    this.held.delete(runId);
  }

  /** A stop asked of an attempt (a human, a session stopped): a shutdown then waits for its end rather than letting it run on. */
  protected stopRun(runId: string): void {
    const held = this.held.get(runId);
    if (held) held.stopped = true;
    this.handles.get(runId)?.stop();
  }

  /** The ticket's active run, cut and not settled: its result was never sent, or its launch never wrote it. */
  private async recoverActive(t: TicketState, runId: string): Promise<void> {
    const { store, clock } = this.d;
    const run = await store.getRun(runId);
    if (run) {
      await store.appendInbox(await this.finishedFor(run, { outcome: run.status as RunOutcome, costUsd: run.costUsd, turns: run.turns, lastText: run.lastText, ...endFacts(run) }));
      return;
    }
    // Nothing else will take it up (a pending job started by `settle` has no mark): `run.lost`, on the job the ticket holds.
    // Handed out too: a queue item whose launch the crash cut is the queue's to start again, under a lease still live (ORC-339).
    const queued = t.activeJob !== undefined && (await this.queueHolds(t.projectId, t.ticketId, (q) => q.job === t.activeJob));
    const unfinished = (await store.listEffects(t.projectId, t.ticketId)).some((r) => r.effect.kind === 'start_run' && (r.status === 'pending' || r.status === 'running'));
    if (queued || unfinished || !t.activeJob) await this.apply(t, { type: 'run.cleared' });
    else await store.appendInbox(lostEvent({ id: runId, projectId: t.projectId, ticketId: t.ticketId, job: t.activeJob }, 'restart', clock.now()));
  }

  /**
   * The check of an attempt cut with the process that ran it: run again, unless its effect or the publication behind
   * it is still to come (the outbox replays it), or nothing says what it checked.
   */
  private async recoverCheck(t: TicketState, runId: string): Promise<void> {
    const { store, clock } = this.d;
    const rows = await store.listEffects(t.projectId, t.ticketId);
    if (rows.some((r) => (r.effect.kind === 'run_verify' || r.effect.kind === 'publish') && r.effect.runId === runId && (r.status === 'pending' || r.status === 'running'))) return;
    const run = await store.getRun(runId);
    // The effect of its check says under which job, as any check's does: a human's push has no run (ORC-159), and the
    // commit of the relay job is checked under the reply rule's (ORC-375).
    const job = rows.map((r) => r.effect).find((e): e is Extract<Effect, { kind: 'run_verify' }> => e.kind === 'run_verify' && e.runId === runId)?.job ?? run?.job;
    if (!job) {
      this.log('warn', `verification of ${t.ticketId} names a run never written (${runId}): dropped`);
      await this.apply(t, { type: 'work.cancelled' });
      return;
    }
    const output = run ? await storedOutput(store, runId).catch(() => undefined) : undefined;
    await store.appendInbox({
      ...TRUSTED,
      // By its time: a check run again can be cut again, and the inbox keeps an id once.
      id: `check:${runId}:lost:${clock.now()}`,
      type: 'verify.lost',
      at: clock.now(),
      projectId: t.projectId,
      ticketId: t.ticketId,
      payload: { runId, job, ...(output ? { output } : {}) },
    });
  }

  /**
   * One heartbeat (ORC-220): an attempt this process runs, that still lives and that showed progress within its silence
   * bound (ORC-344), has its lease renewed under its token; an attempt whose lease expired is lost. `factory up` calls it
   * every `RUN_BEAT_MS`. A process stuck mid-flight lets its lease run out with its beats, as does an attempt that writes
   * nothing more, and whoever looks next takes the attempt over. One another daemon took over is let go of, still running.
   */
  async supervise(): Promise<void> {
    // One beat at a time: an engine or a store that answers slowly does not pile them up.
    if (this.stopping || this.beating) return;
    this.beating = true;
    try {
      const { store, clock } = this.d;
      for (const [runId, held] of this.held) {
        if (held.ending || clock.now() - held.seenAt >= held.silentMs || !(await this.alive(runId))) continue;
        if (await store.renewRun(runId, clock.now() + RUN_LEASE_MS, held.token)) continue;
        // Refused: `leaseExpired` closed it, or another daemon took it over and follows it now, with its slot.
        const rec = await store.getRun(runId);
        if (rec?.status === 'running' && (rec.leaseToken ?? 0) !== held.token) {
          this.log('warn', `lease of run ${runId} of ${rec.ticketId} taken over by another daemon: let go of here`);
          this.letGo(runId);
          this.d.scheduler.release(`${rec.ticketId}:${rec.queue}`);
        }
      }
      // Before the leases: a run whose result is kept is still `running` in the store, its lease run out, and only its result tells its end.
      await this.deliverKept();
      for (const run of await store.runsByStatus('running')) {
        // Its result is kept (`deliver`), or on its way: ended, not lost, whatever its lease says.
        if (this.unwritten.has(endKey(run.id)) || this.held.get(run.id)?.ending) continue;
        if (run.leaseUntil !== undefined && run.leaseUntil < clock.now()) await this.leaseExpired(run);
      }
    } finally {
      this.beating = false;
    }
  }

  /** Its sandbox still runs: an engine that does not answer counts as no. Without sandboxes, a held attempt lives until its process ends it. */
  private async alive(runId: string): Promise<boolean> {
    if (!this.d.sandboxes) return true;
    try {
      return (await this.d.sandboxes.findByAttempt(runId)) !== undefined;
    } catch (err) {
      this.log('warn', `sandbox of run ${runId} not read, no beat: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * An engine that does not answer relaunches nothing: the old attempt may still be there, the next beat
   * looks again. Otherwise the attempt is closed first: its own end, which destroying its sandbox brings
   * at once, then sends nothing (`pump`), and `run.lost` alone speaks for it. Its sandbox goes before the
   * relaunch can meet it on the same session and the same worktree; the slot goes with it.
   */
  private async leaseExpired(expired: RunRecord): Promise<void> {
    const { store, sandboxes, clock, scheduler } = this.d;
    let box: Sandbox | undefined;
    try {
      box = await sandboxes?.findByAttempt(expired.id);
    } catch (err) {
      this.log('warn', `lease of run ${expired.id} of ${expired.ticketId} expired, not relaunched yet: ${(err as Error).message}`);
      return;
    }
    // Taken over, so read again: it may have ended while the engine was asked, or another daemon took it first (ORC-344).
    const run = await this.takeOver(expired.id);
    if (!run) return;
    // Taken from itself: its pump still records what the attempt spent, under the new token, and sends nothing.
    const mine = this.held.get(run.id);
    if (mine) mine.token = run.leaseToken!;
    this.log('warn', `lease of run ${run.id} of ${run.ticketId} expired`);
    await store.putRun({ ...run, status: 'failure', endedAt: clock.now() }, run.leaseToken);
    if (box) await this.destroySandbox(box.id, run.id);
    this.handles.get(run.id)?.stop();
    scheduler.release(`${run.ticketId}:${run.queue}`);
    if (run.queue === 'dev' || run.linearSessionId !== undefined) await this.submitResult(lostEvent(run, 'lease', clock.now()));
  }

  /** The sandboxes a crash left behind (ORC-204): every one whose attempt this process is not running. */
  /** `takenOver`: the containers of the tickets still taken over (ORC-234), which are no attempt and stay. */
  private async destroyDeadSandboxes(takenOver: ReadonlySet<string>): Promise<void> {
    const sandboxes = this.d.sandboxes;
    if (!sandboxes) return;
    let live: Awaited<ReturnType<SandboxProvider['list']>>;
    try {
      live = await sandboxes.list();
    } catch (err) {
      this.log('error', `sandboxes not listed, those of dead attempts are left: ${(err as Error).message}`);
      return;
    }
    // ponytail: a red check's sandbox (`<run>-red`) has no run record: its log is left to the files' purge.
    const dead = new Map<string, string[]>();
    for (const { runId, sandbox } of live) if (!this.handles.has(runId) && !takenOver.has(runId)) dead.set(runId, [...(dead.get(runId) ?? []), sandbox.id]);
    // An attempt's containers, its services among them (ORC-309), one after the other: its security log once they are all gone.
    await Promise.all(
      [...dead].map(async ([runId, ids]) => {
        for (const id of ids) await this.destroySandbox(id, runId);
        const owner = await this.d.store.getRun(runId);
        if (owner) await this.ingestSecurityLog(runId, owner);
      }),
    );
  }

  async tick(): Promise<void> {
    try {
      await this.drain('dev');
      await this.drain('questions');
    } catch (err) {
      this.log('error', `tick: ${(err as Error).message}`);
    }
  }

  /**
   * A clean shutdown: nothing more is taken, and the attempts under way are let go of, still running (ORC-344). The
   * next start reattaches to them, or starts their step again if they are gone, as after a SIGKILL (`recover`).
   */
  stopAll(): void {
    this.stopping = true;
    this.worker.stop();
    this.d.scheduler.cancelWaits();
    for (const runId of [...this.handles.keys()]) {
      // Ended already, its end on its way, or stopped on request: drained() waits for its end, written here.
      if (this.liveRuns.has(runId) && !this.held.get(runId)?.stopped) this.letGo(runId);
      else this.liveRuns.delete(runId);
    }
  }

  /** The failed inbox rows of this process's worker that hold the ticket (ORC-350), for its diagnosis. */
  heldRows(ticketId: string): HeldRow[] {
    return this.worker.held(ticketId);
  }

  /**
   * An event that starts tracking a ticket must carry its snapshot, so that `decide` and a replay of the
   * journal never read the tracker. A producer that could not fill it gets it filled here, before journaling.
   * An issue the tracker no longer finds (deleted meanwhile, ORC-302) leaves it without one: its decision
   * ignores it, journaled, instead of retrying a read that would fail again. Any other read error throws: retried.
   */
  private async withSnapshot(event: FactoryEvent): Promise<FactoryEvent> {
    if (event.projectId === '*' || !event.ticketId || !CREATES_TICKET.has(event.type)) return event;
    const payload = event.payload as { issue?: IssueSnapshot };
    if (payload.issue || (await this.d.store.getTicket(event.projectId, event.ticketId))) return event;
    const project = this.project(event.projectId);
    let issue: TrackerIssue;
    try {
      issue = await this.d.tracker.getIssue(event.ticketId);
    } catch (err) {
      if (!(err instanceof IssueNotFoundError)) throw err;
      this.log('warn', `event ${event.id} (${event.type}): ${event.ticketId} not found in the tracker, left without a snapshot: ${err.message}`);
      return event;
    }
    const logical = logicalFromName(project.workflow.states, issue.stateName) ?? 'todo';
    return { ...event, payload: { ...payload, issue: { title: issue.title, logical, priority: issue.priority } } } as FactoryEvent;
  }

  /**
   * A human event `decide` may check gets its actor's roles before its decision (ORC-186), journaled
   * with it, so that `decide` stays pure and a replay checks the matrix on the same roles. No actor, no
   * roles: the event is then refused whatever it asks. A resolution that fails throws: the event waits
   * and is retried, never decided on roles that may be wrong. An event the matrix will not check (on a
   * ticket the factory does not track, or that no rule with a run answers in the ticket's workflow)
   * gets none, and never waits on Linear or GitHub.
   */
  private async withRoles(event: FactoryEvent): Promise<FactoryEvent> {
    const resolver = this.d.roles;
    if (!resolver || event.roles !== undefined || event.projectId === '*' || !event.ticketId || !HUMAN_EVENTS.has(event.type)) return event;
    const known = await this.d.store.getTicket(event.projectId, event.ticketId);
    if (!known && !CREATES_TICKET.has(event.type)) return event;
    const project = await this.runtimeFor(event.projectId, event.ticketId, known ?? null);
    if (!project || !mayCheck(event, project.workflow)) return event;
    return { ...event, roles: event.actor ? await resolver.rolesOf(event.projectId, event.actor) : [] };
  }

  /**
   * A dead `settle` whose pending job the queue holds gets `queued` before its decision (ORC-359), as roles are resolved:
   * `decide` stays pure and blocks nothing, the queue launches the job and its run takes it off the ticket. The queue
   * unread, it gets none: the ticket is blocked, as before, rather than its job left to a queue that may not hold it.
   */
  private async withQueued(event: FactoryEvent): Promise<FactoryEvent> {
    if (event.type !== 'effect.failed' || event.payload.kind !== 'settle' || event.payload.queued || !event.ticketId) return event;
    const { projectId, ticketId } = event;
    try {
      const pending = (await this.d.store.getTicket(projectId, ticketId))?.pendingJob;
      if (!pending || !(await this.queueHolds(projectId, ticketId, (q) => samePending(q, pending)))) return event;
    } catch (err) {
      this.log('warn', `dead settle of ${ticketId}: the queue unread (${(err as Error).message}), its pending job taken for not queued`);
      return event;
    }
    return { ...event, payload: { ...event.payload, queued: true } };
  }

  /**
   * What the decision of an event needs from outside. A repair that applies its event prepares that one: set
   * aside out of attempts, it may never have been (ORC-320), and an event without roles is not checked at all. A
   * `force` records facts without a decision: it needs the snapshot alone, not what may be down still. An event
   * already prepared stays as it is. One its upcast refuses is left to the decision, which throws too.
   */
  protected async prepared(event: FactoryEvent): Promise<FactoryEvent> {
    const outside = async (e: FactoryEvent) => this.withQueued(await this.withFreeze(await this.withRoles(await this.withSnapshot(e))));
    if (event.type !== 'dead_letter.repaired') return outside(event);
    let repaired: FactoryEvent | undefined;
    try {
      repaired = repairedEvent(event);
    } catch {
      return event;
    }
    if (!repaired) return event;
    const inner = event.payload.action === 'force' ? await this.withSnapshot(repaired) : await outside(repaired);
    return inner === repaired ? event : { ...event, payload: { ...event.payload, event: inner } };
  }

  /** The decision transaction of an event (ORC-149): `decide` runs in the store, under the ticket's lock. */
  protected request(event: FactoryEvent): DecisionRequest {
    const project = event.projectId === '*' ? this.d.projects[0] : this.project(event.projectId);
    const now = this.d.clock.now();
    if (!project) return { event, workflow: { hash: '', definition: null }, decide: () => NO_PLAN };
    return {
      event,
      workflow: this.currentVersion(project),
      // By the ticket's team, not the event's project: a delegation may come here from a team believed to have no repo (ORC-171).
      peers: this.d.projects.filter((p) => p.id !== event.projectId && p.teamKey === event.ticketId?.split('-')[0]).map((p) => p.id),
      decide: (known, version) => planDecision({ event, known, workflow: this.workflowOf(version, project.id, event.ticketId), hash: version.hash, now }),
    };
  }

  /**
   * A run result left waiting (behind a failed event, or failing itself past its last retry) or set
   * aside still frees its run's slot: otherwise, slot after slot, it would stop every launch for as long
   * as it stays. The slots are in memory, so the replay at the next start frees nothing twice.
   */
  protected async freeSlot(row: StoredEvent): Promise<void> {
    if (row.type !== 'run.finished') return;
    const run = await this.d.store.getRun((row.payload as EventPayloads['run.finished']).runId).catch(() => undefined);
    if (run) this.d.scheduler.release(`${run.ticketId}:${run.queue}`);
  }

  /** After the commit, before the effects. */
  protected async committed(event: FactoryEvent, outcome: Extract<DecisionOutcome, { status: 'committed' }>): Promise<void> {
    const { bus, scheduler } = this.d;
    // First, and without a store read: a finished run's slot is freed whatever follows.
    if (event.type === 'run.finished' && outcome.known && event.ticketId) {
      const hash = outcome.known.workflowHash;
      const workflow = (hash && this.workflows.get(hash)) || this.project(event.projectId).workflow;
      const queue = workflow.jobs[event.payload.job]?.queue;
      if (queue) scheduler.release(`${event.ticketId}:${queue}`);
    }
    bus.publish({ kind: 'event', event });
    if (outcome.plan.note) this.log('info', outcome.plan.note);
    if (outcome.preempted.length > 0) {
      this.log('warn', `${event.type} ${event.id} cancelled the effects held back by their retry: ${outcome.preempted.join(', ')}`);
    }
    if (outcome.plan.ticket) bus.publish({ kind: 'ticket', ticket: outcome.plan.ticket });
  }

  /**
   * Executes one outbox row of a decision, after its commit, for the outbox executor (ORC-150):
   * throws when the effect failed. The executor retries it, then lets it die; its result comes back
   * through the inbox (`effect:<id>`), and a dead one blocks the ticket by `decide`.
   */
  protected async execute(row: OutboxRow): Promise<EffectOutcome | void> {
    const project = await this.runtimeFor(row.projectId, row.ticketId);
    if (!project) return;
    const effect = row.effect;
    if (effect.kind === 'settle') {
      if (row.ticketId) await this.settle(project, row.ticketId);
      return;
    }
    this.d.bus.publish({ kind: 'command', projectId: project.id, ticketId: row.ticketId, command: effect });
    const key: EffectKey = { id: `${row.id}@${await this.instanceId()}`, replay: row.attempts > 1, eventId: row.eventId };
    const outcome = await this.exec(project, row.ticketId, effect, key);
    if (outcome?.deduplicated) this.log('info', `effect ${row.id} (${effect.kind}) already made${outcome.ref ? ` (${outcome.ref})` : ''}: not written again`);
    return outcome;
  }

  /**
   * This installation's id, drawn once and kept in the store: it salts the keys of the effects
   * written outside (ORC-162), so that another instance on the same Linear workspace, or this one
   * after its journal restarted from zero, never takes an effect of its own for one of theirs.
   */
  private instanceId(): Promise<string> {
    this.instance ??= (async () => {
      const known = await this.d.store.getMeta(INSTANCE_KEY);
      if (known) return known;
      await this.d.store.setMeta(INSTANCE_KEY, randomUUID().replaceAll('-', '').slice(0, 12));
      // Read back: of two daemons starting together on one store, both keep the one written last.
      return (await this.d.store.getMeta(INSTANCE_KEY))!;
    })().catch((err: unknown) => {
      // Not kept: the next effect reads the store again.
      this.instance = undefined;
      throw err;
    });
    return this.instance;
  }
}
