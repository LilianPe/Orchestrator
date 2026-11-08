import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Forge, ForgeWriter, MergeResult } from '../adapters/forge/types.js';
import { prEventId } from '../adapters/forge/github-webhook.js';
import { prText, PublishRefused, type Publisher } from '../adapters/publisher/types.js';
import type { RoleResolver } from '../adapters/roles/types.js';
import type { RunHandle, RunResult, Runner, StagnationBounds } from '../adapters/runner/types.js';
import {
  DEFAULT_REQUIREMENTS,
  PACK_TARGET,
  REFUSALS_TARGET,
  SANDBOX_HOME,
  SETTINGS_TARGET,
  WORKSPACE_TARGET,
  type Sandbox,
  type SandboxMount,
  type SandboxProvider,
} from '../adapters/sandbox/types.js';
import { ActivityRelay } from '../adapters/tracker/activity-relay.js';
import { IssueNotFoundError, labelEchoKey, stateEchoKey, type ActivityInput, type Tracker, type TrackerIssue } from '../adapters/tracker/types.js';
import type { Workspace, WorkspaceManager } from '../adapters/workspace/types.js';
import { NO_REPO_VARIABLES, type RepoVariables } from '../config/repo-variables.js';
import { parseRepoConfig, RepoConfigError, ticketTokenCap, type RepoConfig, type RepoConfigRead } from '../config/repo-config.js';
import type { JobSpec, Workflow } from '../config/workflow-schema.js';
import type { EffectRetry } from '../runtime/outbox.js';
import { attemptsFor, backoff, isTransient, TRANSIENT_WINDOW_MS, type RetryPolicy } from '../runtime/transient.js';
import { Worker } from '../runtime/worker.js';
import { workflowVersion } from '../runtime/workflow-version.js';
import {
  LEASE_MS,
  RUN_LEASE_MS,
  RUN_SILENT_MS,
  type DecisionOutcome,
  type DecisionRequest,
  type EffectOutcome,
  type OutboxRow,
  type QueueItem,
  type RunRecord,
  type SessionRole,
  type Store,
  type WorkflowVersion,
} from '../store/types.js';
import { agentOutputKey, attemptOutcome, parseAgentOutput, type AgentOutput } from './agent-output.js';
import { composeResult, OutputPolicy, OutputRefused, PolicedTracker } from '../publish/output-policy.js';
import type { EventBus } from './bus.js';
import type { Clock } from './clock.js';
import type { Effect } from './decision.js';
import { repairedEvent } from './dead-letter.js';
import { NO_PLAN, planDecision } from './decision-plan.js';
import { blockFacts, composeBlockComment, type BlockFacts, type BlockStatus } from './block-comment.js';
import { blockedLabelChange, goesThroughFreeze, historyTaint, HUMAN_EVENTS, ingestedConversation, mayCheck, mayPublish, RECONCILE_MS, reconcileTicket, refusesDevWork, SENSITIVE_PATHS, sensitivePathsAtLaunch, stepOf, taintedKnowledge, waitingBody, waitingOn } from './engine.js';
import { codeRunTokens } from './measures.js';
import { attemptLabels, packFingerprints } from './attempt-labels.js';
import { openBlockers, pickupFailures } from './pickup.js';
import { buildPrompt, formatFeedback, formatVerifyFailures, readConventions, withHumanInbox } from './prompt.js';
import { carriedAtLaunch, forAgent } from './human-message.js';
import { pendingOf, reduce, samePending } from './reduce.js';
import { advancePlan, closePlan, planStepOfJob, startPlan, type PlanStep } from './session-plan.js';
import { MERGE_PUSHED, upcast, upcastMergeRefusal, type MergeRefusal, type StoredEvent } from './upcast.js';
import type { Scheduler } from './scheduler.js';
import {
  CREATES_TICKET,
  type EventPayloads,
  type FeedbackItem,
  type InputKind,
  type InternalEvent,
  type IssueSnapshot,
  type LogicalState,
  type QueueName,
  type FactoryEvent,
  type RunOutcome,
  type TicketState,
  type VerifyFailure,
  TRUSTED,
} from './types.js';
import { runSealedSetup } from './sealed-setup.js';
import { checkBranchPaths, runCleanVerify, untrustedCheck, type CleanVerifier, type UntrustedMark } from './clean-verify.js';
import { logExcerpt } from '../checks/log-excerpt.js';
import { cappedCommand, VERIFY_CHECK, type Verifier, type VerifyResult } from './verify.js';
import { PRODUCT_NAME } from '../product.js';
import { checkRed, type RedDeps, type RedResult } from '../checks/red.js';
import { checkFrozen, FREEZE_CHECK, freezeTests, newTestsOnly, REFREEZE, type FrozenTests } from '../checks/freeze.js';
import { isTestFile } from '../checks/test-files.js';
import { ANTI_CHEAT_CHECK, ANTI_CHEAT_OK } from '../checks/anti-cheat.js';
import { mdCode } from '../checks/markdown.js';
import { parseStatus } from '../adapters/workspace/git-workspaces.js';
import { agentPolicy, type EgressPolicy } from '../network/levels.js';
import { REPO_CONFIG_REFUSED, TICKET_TOKENS_REACHED, type BlockKind } from './block-cause.js';
import { readSecurityLog, refusalSummary } from '../network/security-log.js';

/** Meta key of the head a ticket's tests step started on (ORC-123). */
const redBaseKey = (projectId: string, ticketId: string): string => `red-base:${projectId}:${ticketId}`;
/** Set while a fresh worktree is not set up and sealed (ORC-211): a daemon killed before the end leaves it, and the next launch makes the worktree anew. */
const setupPendingKey = (path: string): string => `setup-pending:${path}`;

/**
 * Every run's Claude Code (ORC-284): no auto-memory (ORC-205), telemetry off by both variables ORC-128
 * names, which one does it unmeasured; in a sandbox the egress proxy blocks it anyway (ORC-213).
 */
export const CLAUDE_RUN_ENV = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };

/** Half of what Linux takes for one environment string (128 KiB): past it, the launch itself would fail. */
const FULL_READ_ENV_MAX_BYTES = 64 * 1024;

/** The pack hook's list of paths read whole, absolute as the run sees them. Throws past the bound: see `fullReadEnvOf`. */
export function fullReadEnv(cwd: string, paths: readonly string[]): Record<string, string> {
  if (paths.length === 0) return {};
  const list = JSON.stringify(paths.map((path) => `${cwd}/${path}`));
  if (Buffer.byteLength(list) > FULL_READ_ENV_MAX_BYTES) throw new Error(`${paths.length} paths: too long for the environment`);
  return { FACTORY_FULL_READ_PATHS: list };
}

/**
 * The run's output, validated again: absent or invalid, the agent submitted none (ORC-289). A store
 * that cannot be read rejects: that is the infrastructure's, not the agent's.
 */
async function storedOutput(store: Store, runId: string): Promise<AgentOutput | undefined> {
  const raw = await store.getMeta(agentOutputKey(runId));
  if (raw === undefined) return undefined;
  try {
    const parsed = parseAgentOutput(JSON.parse(raw));
    return parsed.ok ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}

/** What only the runner knows of an attempt's end (ORC-136), kept on its row: recover() sends the same result if the process dies before it does. */
function endFacts({ stagnation, infra, usageLimit, overBudget }: Pick<RunResult, 'stagnation' | 'infra' | 'usageLimit' | 'overBudget'>): Pick<RunResult, 'stagnation' | 'infra' | 'usageLimit' | 'overBudget'> {
  return { ...(stagnation ? { stagnation } : {}), ...(infra ? { infra } : {}), ...(usageLimit ? { usageLimit } : {}), ...(overBudget ? { overBudget } : {}) };
}

/** A usage limit whose reset the CLI did not tell: tried again after this long (ORC-340). ponytail: a fixed probe, hourly. */
const USAGE_RETRY_MS = 60 * 60_000;

/** Meta key: until when (ms) the account's usage limit holds every launch (ORC-340). */
const USAGE_LIMITED_UNTIL = 'usage-limited-until';
/** The account of a hold: each account has its own limit, and a launch on another one is not held. */
const usageHoldKey = (account: string): string => `${USAGE_LIMITED_UNTIL}:${account}`;
/** The shortest wait on a usage limit: a reset already past (or announced late) is not a reason to hit the limit again at once. */
const USAGE_MIN_WAIT_MS = 5 * 60_000;

/** A launch refused because the ticket spent its token budget (ORC-340): blocked with this message as its reason. */
class TicketBudgetError extends Error {}

/**
 * What a run's stagnation is watched against (ORC-136). `silentAfterMs` tells a version frozen since: one before it has
 * `repeatedFailures` too (ORC-187), for its checks only, and keeps running as it did. Only a dev job has its worktree read
 * for a loop: `decide` blocks no ticket on a question, whose checkout stays out of it.
 */
function stagnationBounds(wf: Workflow, job: JobSpec): { stagnation?: StagnationBounds } {
  const silentMs = wf.limits.silentAfterMs;
  if (!silentMs) return {};
  const repeats = job.queue === 'dev' ? wf.limits.repeatedFailures : undefined;
  return { stagnation: { silentMs, ...(repeats ? { repeats } : {}) } };
}

export interface ProjectRuntime {
  id: string;
  repoPath: string;
  teamKey: string;
  workflow: Workflow;
}

export interface OrchestratorDeps {
  store: Store;
  clock: Clock;
  bus: EventBus;
  scheduler: Scheduler;
  tracker: Tracker;
  forge: Forge;
  /** One reconciliation of a project (ORC-185): Linear and GitHub compared to the factory's state, into the inbox. */
  reconcile?: (project: ProjectRuntime) => Promise<void>;
  /** The factory's writes on the forge (ORC-148: the merge); absent with the `gh` CLI, which merges nothing. */
  forgeWriter?: ForgeWriter;
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
  /** The egress proxy's journal of a run (`EgressProxy.journalPath`), read into its security log (ORC-296). */
  egressJournal?: (runId: string) => string;
  /** Other host paths every sandbox mounts (the factory's install, for `factory-agent`). */
  sandboxMounts?: readonly SandboxMount[];
  agentEnv: (run: RunRecord) => Record<string, string>;
  /**
   * Repository-relative paths a run of this ticket reads whole past the pack's read threshold (ORC-279): the frozen
   * tests (ORC-131). ORC-212 will add the ticket's spec.
   */
  fullReadPaths?: (ticket: TicketState) => readonly string[];
  /** What the runner gets of the repository, from its config (ORC-211). Absent: nothing. */
  repoVariables?: (project: ProjectRuntime, config: RepoConfig) => Promise<RepoVariables>;
  /**
   * `.factory/config.yml` on the repository's default branch, read once at each launch (ORC-209 C); it rejects on an
   * invalid file. Absent: the socle, as for a repository without the file.
   */
  repoConfig?: (project: ProjectRuntime, read?: RepoConfigRead) => Promise<RepoConfig>;
  /** Where a project's base branch is fetched (ORC-151): required with `sandboxes`. */
  originUrl?: (project: ProjectRuntime) => Promise<string>;
  /** `budgets.per_ticket_tokens` of factory.yml (ORC-340): a ticket past it is blocked before its next run. The repository's own cap lowers it. */
  perTicketTokens?: number;
  /** `budgets.on_usage_limit` of factory.yml (ORC-340): `wait`, a run stopped by the usage limit resumes at its reset. Absent: it blocks, as any failure. */
  onUsageLimit?: 'wait';
  /** The Claude account runs use (`claude.active`, ORC-211): a usage limit holds the launches of that account only. Absent: `default`. */
  claudeAccount?: () => string | undefined;
  newId?: () => string;
  activityIntervalMs?: number;
  beforeRun?: (run: RunRecord) => Promise<void>;
  /** False when no knowledge repo is configured: `knowledge` jobs (learn, remember) are then skipped. Default true. */
  knowledgeConfigured?: boolean;
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

interface StartOpts {
  job: string;
  input?: InputKind;
  inputText?: string;
  linearSessionId?: string;
  resume?: boolean;
  /** Those the start was decided with: kept pending or queued with it, completed at the launch (ORC-274). */
  sensitivePaths?: readonly string[];
  /** The lost attempt whose step this starts again (ORC-220): what it read, its taint and its session come from its record. */
  relaunchOf?: string;
  /** A queued item's place in its queue, kept when it goes back there. */
  enqueuedAt?: number;
  /** The start mark its launch names its run in (ORC-277, `startHandled`): an outbox effect's, or its queued item's. */
  startMark?: string;
}

/** A drain's hooks on a start it hands out of the queue (`startRun`). */
interface StartFrom {
  admitted?: () => void;
  recorded?: () => Promise<void>;
}

/**
 * A launch that failed before its `run.started`, and nothing of the run is the ticket's yet: its read or write of the
 * factory's own state failed (ORC-339), or anything it called failed transiently (`isTransient`: GitHub, Linear or the
 * database down, ORC-343). The start is tried again (the effect's retry, the drain's bounded one) instead of blocking
 * the ticket. A launch's own failure (a worktree, a setup, the repository's config) still blocks it at once: retried,
 * it would fail again. `failure`: what failed, also its `cause`, which `isTransient` reads.
 */
class RetryableStart extends Error {
  constructor(readonly failure: unknown) {
    super(failure instanceof Error ? failure.message : String(failure), { cause: failure });
  }
}

/**
 * Starts of a queue item that failed before their `run.started` (ORC-339): handed out again after 2 s, 4 s, 8 s, 16 s,
 * doubled up to 5 min; past 5 attempts, or 14 (about 33 min) when the failure is transient (ORC-343), the ticket is blocked.
 */
export const START_RETRY = { attempts: 5, transientWindowMs: TRANSIENT_WINDOW_MS, baseMs: 2_000, capMs: 300_000 } satisfies RetryPolicy;

/** What a start came to: queued, set pending behind a run that holds the ticket (`deferred`), or anything else. */
type StartOutcome = 'queued' | 'deferred' | 'done';

const ECHO_MS = 60_000;
/** The `meta` key of the installation's id (`instanceId`). */
const INSTANCE_KEY = 'instance-id';

/** An outbox effect's idempotency key (ORC-162): `<ticket:seq:i>@<installation>`, and whether the row runs again. */
/** A session's plan as the store keeps it (ORC-171): the session is that of the delegation that opened it. */
interface KeptPlan {
  sessionId: string;
  plan: PlanStep[];
}

interface EffectKey {
  id: string;
  replay: boolean;
  /** The inbox event the effect's decision came from. */
  eventId: string;
}

export function logicalFromName(states: Workflow['states'], name: string): LogicalState | undefined {
  return (Object.entries(states) as [LogicalState, string][]).find(([, n]) => n === name)?.[0];
}

/**
 * The session role of an attempt (ORC-217): the ticket session is the implementer's, any other `dev`-queue
 * session a reviewer's, a read-only question the answerer's.
 * ponytail: read from the job's shape, not declared in the workflow; a `role:` per job if a pack needs another.
 */
function roleOf(job: JobSpec, ticketSession: boolean): SessionRole | undefined {
  if (ticketSession) return 'implementer';
  if (job.queue === 'dev') return 'reviewer';
  return job.workspace === 'trunk-readonly' ? 'answerer' : undefined;
}

/** The inbox id of an attempt's result, and its key among the results kept (`deliver`). */
const endKey = (runId: string): string => `attempt:${runId}:finished`;

/** The event of an attempt gone without a result (ORC-220), once per attempt by its id. */
function lostEvent(run: Pick<RunRecord, 'id' | 'projectId' | 'ticketId' | 'job'>, cause: EventPayloads['run.lost']['cause'], at: number): FactoryEvent<'run.lost'> {
  return { ...TRUSTED, id: `attempt:${run.id}:lost`, type: 'run.lost', at, projectId: run.projectId, ticketId: run.ticketId, payload: { runId: run.id, job: run.job, cause } };
}

/** Whether Claude Code holds the session in this config dir: `--resume` fails without it, `--session-id` with it (ORC-128, calls 9 and 10). */
function sessionSaved(configDir: string, sessionId: string): boolean {
  const projects = join(configDir, 'projects');
  return existsSync(projects) && readdirSync(projects).some((dir) => existsSync(join(projects, dir, `${sessionId}.jsonl`)));
}

/** A verdict on a commit: what ran on it, absent when it was found green before and nothing ran again. */
type Verified = VerifyResult & { sha?: string | undefined; commands?: readonly string[] };

const HOST_CHECKS_OFF = "no sandbox (FACTORY_CONTAINER_CLI) and FACTORY_ALLOW_HOST_VERIFY is not 1: I do not run the agent's code on the host.";

/** A block made out of a decision, its step to resume as the engine's `block` journals it: only where a reply resumes it (ORC-196). */
const blockedOn = (workflow: Workflow, kind: BlockKind, reason: string, job: string): InternalEvent => ({ type: 'ticket.blocked', reason, kind, ...(workflow.blockComment ? { job } : {}) });

export class Orchestrator {
  private background = new Map<Promise<void>, string | undefined>();
  /** Runs whose event stream is still open (the runner is working, nothing for the factory to do): drained() does not wait for them. */
  private liveRuns = new Set<string>();
  private handles = new Map<string, RunHandle>();
  /**
   * The attempts this process follows (ORC-344), until their end is delivered: the token of their lease, which each of its
   * writes of them carries, when they last showed progress, how long a silence their lease outlives, and whether a stop
   * was asked of them. `ending`: their stream is over, their end on its way: no beat renews them, none takes them over.
   */
  private held = new Map<string, { token: number; seenAt: number; silentMs: number; stopped?: true; ending?: true }>();
  private beating = false;
  private stopping = false;
  private newId: () => string;
  /** Inbox writes in flight (accept). */
  private writes = new Set<Promise<void>>();
  /** False until `replayInbox()` when `holdInboxUntilReplay` is set: `accept` then only writes. */
  private dispatchOpen: boolean;
  /** The inbox worker (ORC-149): one task per ticket, a decision transaction per event. */
  private readonly worker: Worker;
  /** The policy every published text goes through (ORC-214), and the tracker without it, for the live relay alone: its words are the factory's. */
  private readonly policy: OutputPolicy;
  private readonly relayTracker: Tracker;
  /** Versions of the projects' workflows, by workflow object. */
  private versionOfWorkflow = new WeakMap<Workflow, WorkflowVersion>();
  /** Workflows by version hash: the current ones and those tickets are frozen on. */
  private workflows = new Map<string, Workflow>();
  /** Dequeued items whose start has not taken its slot yet, per queue: drain hands out no more than the free slots. */
  private admitting: Record<QueueName, number> = { dev: 0, questions: 0 };
  /** Drains run one at a time. */
  private draining: Promise<void> = Promise.resolve();
  private instance: Promise<string> | undefined;
  /** Results this process could not write, the database down (ORC-343): written again at each beat (`supervise`), by id. */
  private unwritten = new Map<string, { what: string; write: () => Promise<void> }>();

  constructor(private d: OrchestratorDeps) {
    this.policy = d.outputPolicy ?? new OutputPolicy();
    this.relayTracker = d.tracker;
    this.d = { ...d, tracker: new PolicedTracker(d.tracker, this.policy, (m) => this.log('warn', m)) };
    this.newId = d.newId ?? randomUUID;
    this.dispatchOpen = !d.holdInboxUntilReplay;
    this.worker = new Worker({
      store: d.store,
      log: (level, message) => this.log(level, message),
      prepare: (event) => this.prepared(event),
      request: (event) => this.request(event),
      committed: (event, outcome) => this.committed(event, outcome),
      execute: (row) => this.execute(row),
      leaseMs: d.effectLeaseMs,
      retry: d.processRetry,
      left: (row) => void this.freeSlot(row),
      deadLettered: (row) => void this.freeSlot(row),
      effectRetry: d.effectRetry,
      now: () => d.clock.now(),
    });
  }

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
  private submitResult(event: FactoryEvent): Promise<void> {
    return this.deliver(event.id, `event ${event.id} (${event.type})`, async () => void (await this.accept(event)));
  }

  /**
   * For the results the orchestrator produces itself (run finished, checks): nobody resends them, so a failed write is
   * retried with a short backoff. Still failing transiently (`isTransient`: the database down), it is kept and written
   * again at each beat, with no bound but this process's life (ORC-343): the ticket and its slot go on once the database
   * is back. A permanent failure gives up with an error (the run's slot is then held until `recover()` at the next
   * start), as does a shutdown, which leaves it to that `recover()`. `write` must be idempotent: the inbox keeps an id once.
   */
  private async deliver(id: string, what: string, write: () => Promise<void>): Promise<void> {
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
   * left alone: the inbox replay settles it with its real result. Everything goes through the inbox,
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
    await this.destroyDeadSandboxes();
    const settled = new Set<string>();
    const checked = new Set<string>();
    for (const row of await store.pendingInbox(Number.MAX_SAFE_INTEGER)) {
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
      this.follow(run.id, handle, run.leaseToken!, bounds.stagnation?.silentMs);
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
  private follow(runId: string, handle: RunHandle, token: number, silentMs = RUN_SILENT_MS): void {
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
  private stopRun(runId: string): void {
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
    if (!run) {
      this.log('warn', `verification of ${t.ticketId} names a run never written (${runId}): dropped`);
      await this.apply(t, { type: 'work.cancelled' });
      return;
    }
    const output = await storedOutput(store, runId).catch(() => undefined);
    await store.appendInbox({
      ...TRUSTED,
      // By its time: a check run again can be cut again, and the inbox keeps an id once.
      id: `check:${runId}:lost:${clock.now()}`,
      type: 'verify.lost',
      at: clock.now(),
      projectId: t.projectId,
      ticketId: t.ticketId,
      payload: { runId, job: run.job, ...(output ? { output } : {}) },
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
  private async destroyDeadSandboxes(): Promise<void> {
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
    await Promise.all(live.filter(({ runId }) => !this.handles.has(runId)).map(async ({ sandbox, runId }) => this.destroySandbox(sandbox.id, runId, await this.d.store.getRun(runId))));
  }

  /**
   * Logged, never thrown: a sandbox left behind is recover()'s at the next start. The run's own
   * `~/.claude` goes with it (a dir left by a failed removal is purged with the run's dir, at 30 days).
   * Then the security log of the attempt `owner` ran there, if any (ORC-296): its journals are complete.
   */
  private async destroySandbox(id: string, runId: string, owner?: RunRecord): Promise<void> {
    await this.d.sandboxes?.destroy(id).catch((err: Error) => this.log('error', `sandbox ${id} not destroyed: ${err.message}`));
    if (this.d.runsDir) rmSync(join(this.d.runsDir, runId, 'claude'), { recursive: true, force: true });
    if (owner) await this.ingestSecurityLog(runId, owner);
  }

  /**
   * The proxy's journal and the hook's refusals log of a sandbox into the base, once (ORC-296); a
   * summary of the refusals in the session of `owner`. Logged, never thrown: the run's end goes on.
   * ponytail: posted directly, not by the outbox; a crash between the write and the post loses the summary.
   */
  private async ingestSecurityLog(runId: string, owner: RunRecord): Promise<void> {
    try {
      const log = readSecurityLog(
        { runId, projectId: owner.projectId, ticketId: owner.ticketId, at: this.d.clock.now() },
        { ...(this.d.egressJournal ? { egress: this.d.egressJournal(runId) } : {}), refusals: join(this.d.runsDir!, runId, 'refusals', 'refusals.jsonl') },
      );
      if (!(await this.d.store.putSecurityLog(log))) return;
      const { egress, refusals } = log.skipped;
      if (egress + refusals) this.log('warn', `security log of ${runId}: ${egress} egress and ${refusals} refusal lines skipped (malformed or forged)`);
      const summary = refusalSummary(log);
      if (summary && owner.linearSessionId) await this.d.tracker.activity(owner.linearSessionId, { type: 'thought', body: summary });
    } catch (err) {
      this.log('error', `security log of ${runId} not recorded: ${(err as Error).message}`);
    }
  }

  /**
   * The attempt's sandbox (ORC-204): the worktree, its git dir inside (ORC-317), the ticket's
   * Claude session dir as `~/.claude` (`--resume` across attempts) when the attempt runs the ticket
   * session, else an empty per-run dir there, removed with the sandbox: a review or a question starts in
   * a fresh context that never sees the ticket's (ORC-217). The run's refusals dir, read-write, so the
   * hook's log outlives the sandbox. The pack and the run settings read-only.
   * A `trunk-readonly` job gets its worktree read-write too: only `--permission-mode plan` keeps it
   * from writing, as on the host. The network is applied by the egress proxy (ORC-213): the repository's
   * level for the agent (`agentPolicy`, from the config read at the launch); `none` for a check (the red sandbox).
   */
  private async openSandbox(sandboxes: SandboxProvider, project: ProjectRuntime, ticketId: string, ws: Workspace, runId: string, ticketSession: boolean, policy: EgressPolicy): Promise<Sandbox> {
    if (!this.d.sessionsDir || !this.d.runsDir) throw new Error('sessionsDir and runsDir are required with sandboxes');
    const runDir = join(this.d.runsDir, runId);
    const claudeDir = ticketSession ? join(this.d.sessionsDir, project.id, ticketId) : join(runDir, 'claude');
    const refusalsDir = join(runDir, 'refusals');
    for (const dir of [claudeDir, refusalsDir]) mkdirSync(dir, { recursive: true });
    return sandboxes.create({
      runId,
      ticketId,
      workspacePath: ws.path,
      network: policy.level,
      ...(policy.allow.length ? { allow: policy.allow } : {}),
      requirements: DEFAULT_REQUIREMENTS,
      // Its git dir is in its worktree, its own (ORC-317): the repository's, which git reads on the host, is never mounted.
      mounts: [
        { host: claudeDir, target: `${SANDBOX_HOME}/.claude`, readOnly: false },
        { host: refusalsDir, target: REFUSALS_TARGET, readOnly: false },
        { host: this.d.packDir, target: PACK_TARGET, readOnly: true },
        { host: this.settingsPath(), target: SETTINGS_TARGET, readOnly: true },
        ...(this.d.sandboxMounts ?? []),
      ],
    });
  }

  private settingsPath(): string {
    return this.d.settingsPath ?? join(this.d.packDir, 'settings.json');
  }

  /**
   * The repository's `setup` in a worktree just made: in a sandbox of its own, gone and sealed before the
   * agent's is opened (ORC-211), on the host without sandboxes, where it gets no secret. It throws on a
   * failure; the launch then removes the worktree, so the next attempt runs it again.
   */
  private async runSetup(project: ProjectRuntime, ticketId: string, ws: Workspace, runId: string, vars: RepoVariables, commands: string[]): Promise<void> {
    const sandboxes = this.d.sandboxes;
    if (!sandboxes) {
      const res = await this.d.verify(ws.path, commands, undefined, vars.env);
      if (!res.ok) throw new Error(`The worktree setup failed: ${res.failures[0]!.command}`);
      return;
    }
    // On commits a previous agent wrote, `setup` runs code nobody reviewed: no secret for it. A setup that needs one fails.
    const secrets = ws.ahead ? {} : vars.setupSecrets;
    if (ws.ahead && Object.keys(vars.setupSecrets).length) this.log('warn', `setup of ${ticketId}: its branch has commits beyond the default branch, the repository's secrets are withheld`);
    const { purged } = await runSealedSetup(sandboxes, {
      runId,
      ticketId,
      workspacePath: ws.path,
      mounts: [{ host: join(ws.path, '.git'), target: `${WORKSPACE_TARGET}/.git`, readOnly: true }],
      commands,
      env: vars.env,
      secrets,
      now: new Date(this.d.clock.now()),
    });
    if (purged.length) this.log('warn', `setup of ${ticketId}: secret found and purged in ${purged.join(', ')}`);
  }

  /** `.factory/config.yml` on the default branch (ORC-209 C): it rejects on an invalid file. */
  private async repoConfigOf(project: ProjectRuntime, read?: RepoConfigRead): Promise<RepoConfig> {
    return this.d.repoConfig ? this.d.repoConfig(project, read) : parseRepoConfig(undefined);
  }

  /**
   * What the runner gets of the repository (ORC-211), from `config` when the caller has it (the launch's read, kept on
   * the run; `verify`'s), else read here without a fetch, for a run recorded before ORC-209 C: none when it cannot be
   * read, the caller goes on.
   */
  private async repoVariablesOf(project: ProjectRuntime, config?: RepoConfig): Promise<RepoVariables> {
    if (!this.d.repoVariables) return NO_REPO_VARIABLES;
    try {
      return await this.d.repoVariables(project, config ?? (await this.repoConfigOf(project, { fetch: false })));
    } catch (err) {
      this.log('warn', `${project.id}: repository variables not read: ${(err as Error).message}`);
      return NO_REPO_VARIABLES;
    }
  }

  /**
   * The `red` check of a finished `tests` run (ORC-123): the step's commits from the head it started on, read on the
   * factory's repository; its uncommitted files and its tests run in a sandbox of their own without network, on the
   * host as `verify` without sandboxes. A check that cannot run gives no verdict on the tests: `infra`.
   */
  private async checkRed(project: ProjectRuntime, run: RunRecord, command: string, alreadyFrozen: boolean): Promise<RedResult & { frozen?: FrozenTests }> {
    const sandboxes = this.d.sandboxes;
    const redRunId = `${run.id}-red`;
    let sandbox: Sandbox | undefined;
    try {
      const base = await this.d.store.getMeta(redBaseKey(project.id, run.ticketId));
      if (!base) throw new Error('the starting commit of the step is not recorded');
      const diff = await this.d.workspaces.stepDiff(project.repoPath, run.cwd, base);
      if (!diff) throw new Error(`no worktree at ${run.cwd}`);
      let uncommitted: string[];
      let runTests: RedDeps['run'];
      if (!sandboxes) {
        if (!this.d.hostChecks) throw new Error(HOST_CHECKS_OFF);
        uncommitted = await this.d.workspaces.uncommitted(run.cwd);
        const { env } = await this.repoVariablesOf(project, run.repoConfig);
        runTests = async (cmd) => {
          const res = await this.d.verify(run.cwd, [cmd], undefined, env);
          return res.ok ? { exitCode: 0, output: '' } : { exitCode: res.failures[0]!.exitCode, output: res.failures[0]!.output };
        };
      } else {
        // Not the ticket session: an empty per-run `~/.claude`, as any run that does not resume it.
        const box = (sandbox = await this.openSandbox(sandboxes, project, run.ticketId, { path: run.cwd }, redRunId, false, { level: 'none', allow: [] }));
        // The tests must fail on the missing behaviour, not on a variable the repository declares (ORC-211).
        const { env } = await this.repoVariablesOf(project, run.repoConfig);
        const status = await sandboxes.exec(box.id, ['git', 'status', '--porcelain', '-z', '--untracked-files=all']);
        if (status.code !== 0) throw new Error(`git status: ${status.stderr.trim()}`);
        uncommitted = parseStatus(status.stdout);
        runTests = async (cmd) => {
          const r = await sandboxes.exec(box.id, cappedCommand(cmd), { env });
          return { exitCode: r.code === 124 ? null : r.code, output: r.stdout + r.stderr };
        };
      }
      const red = await checkRed(command, { ...diff, uncommitted, run: runTests });
      // The freeze (ORC-131) on the same commit: the step's tests and the harness, whatever the red's verdict.
      // ponytail: committed files only; a test left uncommitted is not frozen (verify reads commits once ORC-151 lands).
      const tests = diff.changed.filter((f) => !f.deleted && isTestFile(f.path)).map((f) => f.path);
      const read = await freezeTests(tests, diff);
      return { ...red, frozen: alreadyFrozen ? newTestsOnly(read) : read };
    } catch (err) {
      return { verified: false, cause: 'infra', command: '', exitCode: null, detail: `The red check could not run: ${(err as Error).message}` };
    } finally {
      if (sandbox) await this.destroySandbox(sandbox.id, redRunId, run);
    }
  }

  /**
   * The commands of a job on what its run committed (ORC-151): out of the agent's worktree and the daemon, in
   * `runCleanVerify`. It throws when there is no verdict, an infrastructure failure the agent is not sent. Without
   * sandboxes, only under the explicit `hostChecks`: in the worktree, on the host, and without any of these guarantees.
   */
  private async verifyWork(project: ProjectRuntime, t: TicketState, run: RunRecord, job: JobSpec): Promise<Verified> {
    const { sandboxes, runsDir, originUrl } = this.d;
    // A job that checks what it did not write (a review) has nothing to add on a commit found green: one that wrote it asks again.
    const green = job.verifyFailure === 'block' ? t.verifiedSha : undefined;
    if (!sandboxes) {
      if (!this.d.hostChecks) throw new Error(HOST_CHECKS_OFF);
      // Read before the commands: what they would commit is not what they checked.
      const sha = await this.d.workspaces.head(run.cwd);
      if (sha && sha === green) return { ok: true, failures: [], sha };
      // As on the clone, before any command: a refused branch runs nothing.
      const paths = await this.checkPathsOnHost(project, t, run);
      const verified = paths.length || !job.verify.length ? { ok: true, failures: [] } : await this.d.verify(run.cwd, job.verify, undefined, (await this.repoVariablesOf(project, run.repoConfig)).env);
      // `factory/tests-gelés` (ORC-131), blocking from the first ticket, on top of the job's commands.
      const frozen = goesThroughFreeze(t, job) ? await this.checkFrozen(project, run.cwd, t.frozenTests!) : [];
      const blocking = [...paths, ...frozen];
      return { ...verified, ok: verified.ok && blocking.length === 0, failures: [...verified.failures, ...blocking], sha, commands: job.verify };
    }
    if (!runsDir || !originUrl) throw new Error('runsDir and originUrl are required with sandboxes');
    if (!t.branch || !t.worktreePath) throw new Error(`no branch or no worktree for ${t.ticketId}`);
    const untrusted = await this.untrustedMark(project, t);
    // A place the engine mounts from, new for each check: one cut can leave its own behind.
    const workDir = join(runsDir, run.id, `verify-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true });
    try {
      return await (this.d.cleanVerify ?? runCleanVerify)({
        sandboxes,
        runId: run.id,
        ticketId: t.ticketId,
        branch: t.branch,
        worktree: t.worktreePath,
        originUrl: await originUrl(project),
        workDir,
        setup: project.workflow.workspace.setup,
        commands: job.verify,
        gitleaks: true,
        ...(green ? { green } : {}),
        ...(goesThroughFreeze(t, job) ? { frozen: t.frozenTests! } : {}),
        ...(untrusted ? { untrusted } : {}),
        env: async (config) => (await this.repoVariablesOf(project, config)).env,
        log: (message) => this.log('warn', `verify of ${t.ticketId}: ${message}`),
      });
    } finally {
      // Under the run's dir, purged with it: what the attack left unremovable costs no verdict.
      await rm(workDir, { recursive: true, force: true }).catch((err: Error) => this.log('warn', `verify of ${t.ticketId}: ${workDir} not removed: ${err.message}`));
    }
  }

  /**
   * `factory/chemins-interdits` without sandboxes (ORC-338): `checkBranchPaths`, as on the clone, on the worktree's branch read
   * on the factory's repository against the forge's default branch. As on the clone, what gives no verdict throws, an
   * infrastructure or config failure the agent is not sent: no worktree, a read that fails, a config the default branch refuses.
   */
  private async checkPathsOnHost(project: ProjectRuntime, t: TicketState, run: RunRecord): Promise<VerifyFailure[]> {
    const reader = await this.d.workspaces.branchReader(project.repoPath, run.cwd);
    if (!reader) throw new Error(`the forbidden paths check could not run: no worktree with a commit at ${run.cwd}`);
    const untrusted = await this.untrustedMark(project, t);
    return checkBranchPaths(reader, untrusted && untrustedCheck(untrusted, parseRepoConfig(await reader.baseConfig())));
  }

  /**
   * The ticket's mark (ORC-338), with the heads humans pushed to its branch; none on a trusted branch. A ticket the mark
   * has not seen yet (`untrustedSince` absent: it came before the mark existed) is read once in its run records, and the
   * answer kept on it: `''` (its whole branch) when an untrusted run of a worktree job worked on it, the scope of the mark, else `null`.
   */
  private async untrustedMark(project: ProjectRuntime, t: TicketState): Promise<UntrustedMark | undefined> {
    const since = (await this.readUntrusted(project, t)).untrustedSince;
    return since === null || since === undefined ? undefined : { since, humanPushes: t.humanPushes ?? [] };
  }

  /** The ticket's journal, as a knowledge job reads the ticket: its taint (`historyTaint`, ORC-349), its conversation (ORC-361). */
  private async journalOf(project: ProjectRuntime, t: TicketState): Promise<FactoryEvent[]> {
    return (await this.d.store.ticketJournal(project.id, t.ticketId)).map((j) => upcast(j.event));
  }

  /** The one-time read of `untrustedMark`, for a ticket the mark has not seen; the ticket as it is otherwise. */
  private async readUntrusted(project: ProjectRuntime, t: TicketState): Promise<TicketState> {
    if (t.untrustedSince !== undefined) return t;
    const runs = await this.d.store.ticketRuns(t.projectId, t.ticketId);
    // A job gone from the workflow counts: fail closed.
    const read = runs.some((r) => !!r.sensitivePaths?.length && (project.workflow.jobs[r.job]?.workspace ?? 'worktree') === 'worktree') ? '' : null;
    return this.apply(t, { type: 'untrusted.read', since: read });
  }

  /**
   * `factory/tests-gelés` on a worktree's head (ORC-131): the commits since the freeze, read on the factory's repository.
   * A check that cannot read them fails: the freeze never opens on a breakdown.
   */
  private async checkFrozen(project: ProjectRuntime, cwd: string, frozen: FrozenTests): Promise<VerifyFailure[]> {
    const fail = (output: string) => [{ command: FREEZE_CHECK, exitCode: 1, output }];
    try {
      const diff = await this.d.workspaces.stepDiff(project.repoPath, cwd, frozen.sha);
      if (!diff) return fail(`The freeze check could not run: no worktree at ${cwd}.`);
      const r = await checkFrozen(frozen, diff);
      return r.ok ? [] : fail(r.summary);
    } catch (err) {
      return fail(`The freeze check could not run: ${(err as Error).message}`);
    }
  }

  /**
   * A `/refreeze` gets the freeze at its ticket's branch head before its decision (ORC-131), as roles are resolved:
   * `decide` stays pure and a replay regels the same files. The files frozen before, and the harness. No freeze or no
   * worktree, none: it is the way out of a freeze, not a way in. The head alone: the frozen commit may be gone after a rebase.
   */
  private async withFreeze(event: FactoryEvent): Promise<FactoryEvent> {
    if (event.type !== 'command' || event.payload.name !== REFREEZE || event.payload.frozen || !event.ticketId) return event;
    const t = await this.d.store.getTicket(event.projectId, event.ticketId);
    if (!t?.worktreePath || !t.frozenTests) return event;
    const head = await this.d.workspaces.head(t.worktreePath);
    const diff = head ? await this.d.workspaces.stepDiff(this.project(event.projectId).repoPath, t.worktreePath, head) : undefined;
    if (!diff) return event;
    return { ...event, payload: { ...event.payload, frozen: await freezeTests(Object.keys(t.frozenTests.files), diff) } };
  }

  /**
   * A block made out of a decision (a launch that failed, a refused pickup): the same comment as
   * any other, without an effect's key. A version frozen before ORC-196 says it the way it did (`frozen`).
   */
  private async tellBlock(project: ProjectRuntime, t: TicketState, facts: BlockFacts, frozen: (t: TicketState) => Promise<void>): Promise<void> {
    if (!project.workflow.blockComment) return frozen(t);
    // A key of its own: it carries the marker that tells a comment of the factory from a human's reply.
    await this.d.tracker.comment(t.ticketId, composeBlockComment(facts, await this.blockStatus(t)), `block:${this.newId()}`);
  }

  /** The state line of a block's comment. An unknown value is said as such: reading it must not stop the comment. */
  private async blockStatus(t: TicketState): Promise<BlockStatus> {
    const sha = t.worktreePath ? await this.d.workspaces.head(t.worktreePath).catch(() => undefined) : undefined;
    const runs = await this.d.store.ticketRuns(t.projectId, t.ticketId).catch((): RunRecord[] => []);
    const ended = runs.filter((r) => r.endedAt !== undefined);
    return {
      branch: t.branch,
      sha,
      ci: t.prChecks,
      // The figure of `per_ticket_tokens`: a budget block says the same number as its state line.
      tokens: codeRunTokens(runs),
      durationMs: ended.length ? ended.reduce((n, r) => n + r.endedAt! - r.startedAt, 0) : undefined,
    };
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
    for (const runId of [...this.handles.keys()]) {
      // Ended already, its end on its way, or stopped on request: drained() waits for its end, written here.
      if (this.liveRuns.has(runId) && !this.held.get(runId)?.stopped) this.letGo(runId);
      else this.liveRuns.delete(runId);
    }
  }

  project(id: string): ProjectRuntime {
    const p = this.d.projects.find((x) => x.id === id);
    if (!p) throw new Error(`unknown project ${id}`);
    return p;
  }

  async isPaused(): Promise<boolean> {
    return (await this.d.store.getMeta('paused')) === '1';
  }

  private account(): string {
    return this.d.claudeAccount?.() || 'default';
  }

  /**
   * Until when the usage limit of the active account holds every launch (`on_usage_limit: wait`, ORC-340); undefined when it holds none.
   * A launch before its reset would only hit it again; another account active is not held. The tick drains the queues once it passes.
   */
  async usageLimitedUntil(): Promise<number | undefined> {
    const until = Number((await this.d.store.getMeta(usageHoldKey(this.account()))) ?? 0);
    return until > this.d.clock.now() ? until : undefined;
  }

  private async usageLimited(): Promise<boolean> {
    return (await this.usageLimitedUntil()) !== undefined;
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.d.bus.publish({ kind: 'log', level, message, at: this.d.clock.now() });
  }

  private track(p: Promise<void>, runId?: string): void {
    const wrapped = p.catch((err: unknown) => this.log('error', (err as Error).message)).finally(() => this.background.delete(wrapped));
    this.background.set(wrapped, runId);
  }

  /**
   * The only way the orchestrator changes a ticket outside a decision (an effect recording what it
   * did): through `reduce`, on the projection read again under the ticket's lock.
   */
  private async apply(t: TicketState, ...events: InternalEvent[]): Promise<TicketState> {
    const now = this.d.clock.now();
    const step = (from: TicketState): TicketState => {
      let next = from;
      for (const e of events) next = reduce(next, e)!;
      return { ...next, updatedAt: now };
    };
    let before = t.blocked;
    let next = await this.d.store.updateTicket(t.projectId, t.ticketId, (from) => ((before = from.blocked), step(from)));
    if (!next) {
      next = step(t);
      await this.d.store.putTicket(next);
    }
    this.d.bus.publish({ kind: 'ticket', ticket: next });
    // Blocked or unblocked outside a decision (recover, a launch error, a refused pickup): the label
    // `decide` keeps in step with its own changes follows here (ORC-170). A failed write does not undo the change.
    const label = blockedLabelChange(before, next.blocked);
    if (label) {
      await this.setLabels(t.ticketId, label.add, label.remove).catch((e: Error) => this.log('warn', `could not set the label of ${t.ticketId}: ${e.message}`));
    }
    return next;
  }

  /** The version of a project's workflow now: a ticket's first decision freezes it (ORC-149). */
  private currentVersion(project: ProjectRuntime): WorkflowVersion {
    let v = this.versionOfWorkflow.get(project.workflow);
    if (!v) {
      v = workflowVersion(project.workflow);
      this.versionOfWorkflow.set(project.workflow, v);
      this.workflows.set(v.hash, project.workflow);
    }
    return v;
  }

  private workflowOf(version: WorkflowVersion): Workflow {
    let wf = this.workflows.get(version.hash);
    if (!wf) {
      wf = version.definition as Workflow;
      this.workflows.set(version.hash, wf);
    }
    return wf;
  }

  /** The project as a ticket sees it: with the workflow version the ticket is frozen on. */
  /** `known`: the ticket, when the caller has just read it (`null`: read, and not tracked). */
  private async runtimeFor(projectId: string, ticketId: string | undefined, known?: TicketState | null): Promise<ProjectRuntime | undefined> {
    const project = projectId === '*' ? this.d.projects[0] : this.project(projectId);
    if (!project || !ticketId) return project;
    const hash = (known === undefined ? await this.d.store.getTicket(project.id, ticketId) : known)?.workflowHash;
    if (!hash || hash === this.currentVersion(project).hash) return project;
    let workflow = this.workflows.get(hash);
    if (!workflow) {
      const stored = await this.d.store.getWorkflowVersion(hash);
      if (!stored) throw new Error(`workflow version ${hash} of ${ticketId} is not stored`);
      workflow = this.workflowOf(stored);
    }
    return { ...project, workflow };
  }

  private async ticket(projectId: string, ticketId: string): Promise<TicketState> {
    const t = await this.d.store.getTicket(projectId, ticketId);
    if (!t) throw new Error(`unknown ticket ${ticketId}`);
    return t;
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
   * What the decision of an event needs from outside. A repair that applies its event prepares that one: set
   * aside out of attempts, it may never have been (ORC-320), and an event without roles is not checked at all. A
   * `force` records facts without a decision: it needs the snapshot alone, not what may be down still. An event
   * already prepared stays as it is. One its upcast refuses is left to the decision, which throws too.
   */
  private async prepared(event: FactoryEvent): Promise<FactoryEvent> {
    const outside = async (e: FactoryEvent) => this.withFreeze(await this.withRoles(await this.withSnapshot(e)));
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
  private request(event: FactoryEvent): DecisionRequest {
    const project = event.projectId === '*' ? this.d.projects[0] : this.project(event.projectId);
    const now = this.d.clock.now();
    if (!project) return { event, workflow: { hash: '', definition: null }, decide: () => NO_PLAN };
    return {
      event,
      workflow: this.currentVersion(project),
      // By the ticket's team, not the event's project: a delegation may come here from a team believed to have no repo (ORC-171).
      peers: this.d.projects.filter((p) => p.id !== event.projectId && p.teamKey === event.ticketId?.split('-')[0]).map((p) => p.id),
      decide: (known, version) => planDecision({ event, known, workflow: this.workflowOf(version), hash: version.hash, now }),
    };
  }

  /**
   * A run result left waiting (behind a failed event, or failing itself past its last retry) or set
   * aside still frees its run's slot: otherwise, slot after slot, it would stop every launch for as long
   * as it stays. The slots are in memory, so the replay at the next start frees nothing twice.
   */
  private async freeSlot(row: StoredEvent): Promise<void> {
    if (row.type !== 'run.finished') return;
    const run = await this.d.store.getRun((row.payload as EventPayloads['run.finished']).runId).catch(() => undefined);
    if (run) this.d.scheduler.release(`${run.ticketId}:${run.queue}`);
  }

  /** After the commit, before the effects. */
  private async committed(event: FactoryEvent, outcome: Extract<DecisionOutcome, { status: 'committed' }>): Promise<void> {
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
  private async execute(row: OutboxRow): Promise<EffectOutcome | void> {
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

  private async settle(project: ProjectRuntime, ticketId: string): Promise<void> {
    const t = await this.ticket(project.id, ticketId);
    const pending = t.pendingJob;
    // A step waiting for a usage reset keeps the pending job behind it (ORC-340): nothing to start yet.
    if (!t.activeRunId && !t.verifyingRunId && !t.usageWait && pending) {
      // The job stays on the ticket until a run starts it (ORC-339): its `run.started` takes it off in the same
      // write (`reduce`), whoever launches it. A crash or a throw before leaves it to the retry of this effect.
      // Queued by a settle cut before the clear below: the queue holds that very start, a launch here would run it twice.
      const queued = await this.queueHolds(project.id, ticketId, (q) => samePending(q, pending));
      const outcome: StartOutcome = queued ? 'queued' : await this.startRun(project, ticketId, pending);
      // Set pending again behind a run that took the ticket meanwhile: it stays. Not launched otherwise (refused,
      // blocked, or the queue holds it now): it leaves the ticket, only if it is still the one started.
      if (outcome !== 'deferred') await this.apply(t, { type: 'pending.cleared', job: pending });
    }
    await this.drain('dev');
    await this.drain('questions');
  }

  /**
   * Whether a queue item of the ticket that `matches` is still the queue's to start (ORC-339): handed out or not, but
   * not one whose start is handled already (its run written), a leftover the next drain drops.
   */
  private async queueHolds(projectId: string, ticketId: string, matches: (q: QueueItem) => boolean): Promise<boolean> {
    for (const q of await this.d.store.queuedItems(projectId, ticketId)) {
      if (matches(q) && !(q.startMark !== undefined && (await this.startHandled(q.startMark)))) return true;
    }
    return false;
  }

  /** Starts queued items while slots are free, one drain at a time. */
  private drain(queue: QueueName): Promise<void> {
    const next = this.draining.then(() => this.drainNow(queue));
    this.draining = next.catch(() => undefined);
    return next;
  }

  /**
   * Each item starts in its own ticket's task, without waiting for it (a long `prepare` holds only
   * that ticket); `admitting` counts the starts not past their slot yet, so a drain hands out no
   * more items than free slots.
   *
   * An item is handed out under a lease (ORC-150), renewed while its start runs, and leaves the
   * queue only once its start is recorded (the run written) or it is dropped; it goes back in line
   * when it gets no slot. A crash between the two leaves it in the queue: the next start hands it
   * out again once the lease expires.
   */
  private async drainNow(queue: QueueName): Promise<void> {
    if (this.stopping) return;
    const leaseMs = this.d.effectLeaseMs ?? LEASE_MS;
    const n = (await this.d.store.listQueue()).filter((q) => q.queue === queue).length;
    for (let i = 0; i < n; i++) {
      if ((await this.isPaused()) || (await this.usageLimited()) || this.d.scheduler.free(queue) - this.admitting[queue] <= 0) return;
      const claim = await this.d.scheduler.next(queue, leaseMs);
      if (!claim) return;
      const item = claim.item;
      this.admitting[queue]++;
      let done = false;
      const admitted = () => {
        if (done) return;
        done = true;
        this.admitting[queue]--;
      };
      const renew = setInterval(() => {
        this.d.store.renewQueued(claim, leaseMs).catch((err: unknown) => this.log('warn', `lease of queued ${item.job} on ${item.ticketId}: ${(err as Error).message}`));
      }, Math.max(1, Math.floor(leaseMs / 3)));
      renew.unref();
      let finished = false;
      const taken = () => this.d.store.finishQueued(claim).then(() => void (finished = true));
      this.worker
        .exclusive(item, async () => {
          const project = await this.runtimeFor(item.projectId, item.ticketId);
          // Launched before a crash cut it before it left the queue: recover()'s, not launched again (ORC-277).
          const launched = item.startMark !== undefined && (await this.startHandled(item.startMark));
          let outcome: StartOutcome = 'done';
          try {
            if (project && !launched) outcome = await this.startRun(project, item.ticketId, item, { admitted, recorded: taken });
          } catch (err) {
            if (!(err instanceof RetryableStart) || !project) throw err;
            // A start that failed before its run.started: back in line, its failures counted on the item; past the
            // bound, the ticket is blocked as a launch error, and the item leaves the queue (ORC-339).
            const failed = (item.failedStarts ?? 0) + 1;
            const attempts = attemptsFor(START_RETRY, err);
            if (failed < attempts) {
              clearInterval(renew);
              // Not handed out again at once: the same drain would spend every attempt within milliseconds.
              const wait = backoff(START_RETRY, failed);
              this.log('warn', `start ${item.job} on ${item.ticketId} failed (${err.message}), ${failed} of ${attempts}: back in line in ${wait / 1000} s`);
              await this.d.store.releaseQueued(claim, { failedStarts: failed, notBefore: this.d.clock.now() + wait });
              return;
            }
            // No run of this start is the ticket's: whatever run the ticket holds is another launch's, left alone.
            const job = project.workflow.jobs[item.job];
            if (job) await this.launchFailed(project, item.ticketId, job, item, err.failure, undefined);
          }
          clearInterval(renew);
          // Deferred: set pending behind the run that holds the ticket, now the job's only holder.
          if (outcome === 'queued') await this.d.store.releaseQueued(claim);
          else if (!finished) await this.d.store.finishQueued(claim);
        })
        .catch(async (err: unknown) => {
          clearInterval(renew);
          this.log('error', `start ${item.job} on ${item.ticketId}: ${(err as Error).message}`);
          // Back in line: the item is tried again at the next drain.
          await this.d.store.releaseQueued(claim).catch(() => false);
        })
        .finally(admitted);
    }
  }

  /**
   * `key`: the idempotency key of the effect (ORC-162, docs/idempotency.md). Only a replay (a row
   * claimed before) looks for what an earlier execution wrote: a first execution has nothing to find.
   * A replay that finds the effect already made writes nothing and says so.
   */
  private async exec(project: ProjectRuntime, ticketId: string | undefined, c: Effect, key: EffectKey): Promise<EffectOutcome | void> {
    const { store, tracker, clock } = this.d;
    if (c.kind === 'set_paused') {
      await store.setMeta('paused', c.paused ? '1' : '0');
      if (!c.paused) {
        await this.drain('dev');
        await this.drain('questions');
      }
      return;
    }
    if (c.kind === 'reconcile') {
      // Never fails: a dead effect would disarm the next timer its decision armed, and stop the 5-minute chain.
      await this.d.reconcile?.(project).catch((err: Error) => this.log('warn', `reconcile ${project.id}: ${err.message}`));
      return;
    }
    if (!ticketId) return;
    const t = await this.ticket(project.id, ticketId);
    switch (c.kind) {
      case 'start_run': {
        // A replay (a lost lease) must not start again what was handled: launched, set pending
        // behind the run it started, or queued (`startHandled`).
        const mark = `effect:${key.id}:started`;
        if (key.replay && (await this.startHandled(mark))) return { deduplicated: true };
        await this.startRun(project, ticketId, { ...c, startMark: mark });
        await store.setMeta(mark, '1');
        return;
      }
      case 'stop_run': {
        if (c.linearSessionId) {
          for (const r of await store.runsByStatus('running')) {
            if (r.projectId === project.id && r.ticketId === ticketId && r.linearSessionId === c.linearSessionId) this.stopRun(r.id);
          }
          return;
        }
        // The ticket's timers were deleted by the decision itself (`clearTimers`).
        // The ticket's dev work only: a question waiting for its slot is still answered.
        await store.removeFromQueue(project.id, ticketId, 'dev');
        if (t.activeRunId) this.stopRun(t.activeRunId);
        return;
      }
      case 'run_verify': {
        const run = await store.getRun(c.runId);
        const job = project.workflow.jobs[c.job];
        // No longer awaited (a stop, a verdict): a replayed effect checks nothing, and moves no plan.
        if (!run || !job || t.verifyingRunId !== c.runId) return;
        if (planStepOfJob(job) === 'Build') await this.updatePlan(t, (plan) => advancePlan(plan, 'Verify'));
        this.track(
          (async () => {
            if (job.red) {
              const red = await this.checkRed(project, run, job.red.command, !!t.frozenTests);
              const base = { ...TRUSTED, at: clock.now(), projectId: project.id, ticketId, id: `check:${run.id}` };
              const failures = [{ command: red.command || 'factory/red', exitCode: red.exitCode, output: red.detail }];
              const common = { runId: run.id, job: job.name, red: red.cause, ...(red.frozen ? { frozen: red.frozen } : {}) };
              await this.submitResult(
                red.verified
                  ? { ...base, type: 'verify.passed', payload: { ...common, ...(c.output ? { output: c.output } : {}) } }
                  : { ...base, type: 'verify.failed', payload: { ...common, failures } },
              );
              return;
            }
            const base = { ...TRUSTED, at: clock.now(), projectId: project.id, ticketId, id: `check:${run.id}` };
            const payload = { runId: run.id, job: job.name };
            let res: Verified;
            try {
              res = await this.verifyWork(project, t, run, job);
            } catch (err) {
              await this.submitResult({ ...base, type: 'verify.errored', payload: { ...payload, error: (err as Error).message } });
              return;
            }
            const event: FactoryEvent = res.ok
              ? { ...base, type: 'verify.passed', payload: { ...payload, ...(res.sha ? { sha: res.sha } : {}), ...(res.commands ? { commands: res.commands } : {}), ...(c.output ? { output: c.output } : {}) } }
              : { ...base, type: 'verify.failed', payload: { ...payload, failures: res.failures.map((f) => ({ ...f, output: logExcerpt(f.output) })), ...(res.tree ? { tree: res.tree } : {}) } };
            await this.submitResult(event);
          })(),
        );
        return;
      }
      case 'move':
        await this.move(project, t, c.to, c.keepReviewSha);
        // The factory's own work ended; a move back after a refusal concludes nothing.
        if (c.to === 'human_review' && !c.keepReviewSha) {
          await this.prReady(project, t);
          await this.updatePlan(t, (plan) => closePlan(plan, t.prNumber !== undefined));
        }
        return;
      case 'publish':
        return this.publish(project, t, c, key);
      case 'merge':
        return this.merge(project, t, c.sha, key);
      case 'labels':
        return this.setLabels(ticketId, c.add, c.remove);
      case 'comment':
        return this.commentOnce(ticketId, c.body, key);
      case 'block_comment':
        return this.commentOnce(ticketId, async () => composeBlockComment(c.block, await this.blockStatus(t)), key);
      case 'ack':
        return this.ack(t, c, key);
      case 'activity': {
        const fromRun = c.runId ? (await store.getRun(c.runId))?.linearSessionId : undefined;
        const session = c.linearSessionId ?? fromRun ?? (await this.sessionFor(t));
        return this.activityOnce(session, c.type === 'elicitation' && c.options ? { type: c.type, body: c.body, options: c.options } : { type: c.type, body: c.body }, key);
      }
      case 'post_output': {
        const run = await store.getRun(c.runId);
        if (!run) return;
        const session = run.linearSessionId ?? (await this.sessionFor(t));
        // Composed from what the run submitted, never from its last text (ORC-214): a reply is its summary.
        return this.activityOnce(session, { type: 'response', body: composeResult(c.output, c.style) }, key);
      }
      case 'link_pr':
        if (t.linearSessionId) await tracker.addExternalUrl(t.linearSessionId, 'Pull request', c.url);
        // Seen during the run (the agent opened it), the PR waits for the end of the work: the move to Human Review closes the plan.
        if (!t.activeRunId && !t.verifyingRunId) await this.updatePlan(t, (plan) => advancePlan(plan, 'PR', 'completed'));
        return;
      case 'cleanup':
        await this.d.workspaces.cleanup(project.id, ticketId);
        await this.apply(await this.ticket(project.id, ticketId), { type: 'workspace.released' });
        return;
    }
  }

  /**
   * The ack of a trigger (ORC-171), best effort: a courtesy must not hold back or kill the run behind it, so a write
   * Linear refuses is logged, neither retried nor blocking. The one key on both writes: a replay finds what its first
   * execution wrote of each. The time a measure reads (ORC-235) is the human's first sign of life, before the plan.
   */
  private async ack(t: TicketState, c: Extract<Effect, { kind: 'ack' }>, key: EffectKey): Promise<EffectOutcome | void> {
    const outcomes: (EffectOutcome | void)[] = [];
    const attempt = async (what: string, write: () => Promise<EffectOutcome | void>) => {
      try {
        outcomes.push(await write());
      } catch (err) {
        this.log('warn', `${what} of the ack of ${t.ticketId} not written: ${(err as Error).message}`);
      }
    };
    if (c.comment) await attempt('comment', () => this.commentOnce(t.ticketId, c.body, key));
    await attempt('activity', () => this.activityOnce(c.linearSessionId, { type: 'thought', body: c.body }, key));
    if (outcomes.length > 0) await this.d.store.markAcked(key.eventId, this.d.clock.now()).catch((err: Error) => this.log('warn', `ack of ${key.eventId} posted, its time not recorded: ${err.message}`));
    if (c.plan) await this.openPlan(t, c.linearSessionId);
    // Already made only if nothing was written here.
    return outcomes.length > 0 && outcomes.every((o) => o?.deduplicated) ? outcomes[0] : undefined;
  }

  /** A comment of an outbox effect, written unless its first execution already wrote it (ORC-162). */
  private async commentOnce(ticketId: string, body: string | (() => Promise<string>), key: EffectKey): Promise<EffectOutcome | void> {
    const found = key.replay ? await this.d.tracker.findComment(ticketId, key.id) : undefined;
    if (found !== undefined) return { deduplicated: true, ref: found };
    await this.d.tracker.comment(ticketId, typeof body === 'string' ? body : await body(), key.id);
  }

  /** Opens the session's plan (ORC-171), in the session of the delegation that asks for it. */
  private openPlan(t: TicketState, sessionId: string): Promise<void> {
    return this.writePlan(t, async () => ({ sessionId, plan: startPlan() }));
  }

  /** Moves the session's plan on; a ticket whose delegation opened none gets none. */
  private updatePlan(t: TicketState, change: (plan: readonly PlanStep[]) => PlanStep[]): Promise<void> {
    return this.writePlan(t, async (key) => {
      const stored = await this.d.store.getMeta(key);
      if (!stored) return undefined;
      const { sessionId, plan } = JSON.parse(stored) as KeptPlan;
      return { sessionId, plan: change(plan) };
    });
  }

  /**
   * Keeps the plan in the store with its session, for the next update to build on, and writes it to Linear. Never
   * throws: Linear's plan API is a preview, and a plan it refuses must not stop the work.
   */
  private async writePlan(t: TicketState, next: (key: string) => Promise<KeptPlan | undefined>): Promise<void> {
    const key = `plan:${t.projectId}:${t.ticketId}`;
    try {
      const kept = await next(key);
      if (!kept) return;
      await this.d.store.setMeta(key, JSON.stringify(kept));
      await this.d.tracker.setSessionPlan(kept.sessionId, kept.plan);
    } catch (err) {
      this.log('warn', `plan of ${t.ticketId} not written: ${(err as Error).message}`);
    }
  }

  /** An activity of an outbox effect, written unless its first execution already wrote it (ORC-162). */
  private async activityOnce(session: string, a: ActivityInput, key: EffectKey): Promise<EffectOutcome | void> {
    const found = key.replay ? await this.d.tracker.findActivity(session, key.id) : undefined;
    if (found !== undefined) return { deduplicated: true, ref: found };
    await this.d.tracker.activity(session, a, key.id);
  }

  private async sessionFor(t: TicketState): Promise<string> {
    if (t.linearSessionId) return t.linearSessionId;
    const s = await this.d.tracker.ensureSession(t.ticketId);
    await this.apply(await this.ticket(t.projectId, t.ticketId), { type: 'session.linked', linearSessionId: s });
    return s;
  }

  /** Labels written by the factory, echoed so that their webhook is not read as a human's change. */
  private async setLabels(ticketId: string, add: string[], remove: string[]): Promise<void> {
    for (const l of add) await this.d.store.putEcho(labelEchoKey(ticketId, l, 'added'), this.d.clock.now() + ECHO_MS);
    for (const l of remove) await this.d.store.putEcho(labelEchoKey(ticketId, l, 'removed'), this.d.clock.now() + ECHO_MS);
    await this.d.tracker.setLabels(ticketId, add, remove);
  }

  /**
   * Plans each project's reconciliation in the store (ORC-185), in `RECONCILE_MS` (the connection to Linear passes
   * at once), unless a timer already plans it (a restart): its firings then arm the next ones. The timer of a
   * project gone from the configuration is deleted: it would fire for a project the factory no longer knows.
   */
  async armReconciliation(): Promise<void> {
    const timers = (await this.d.store.dueTimers(Number.MAX_SAFE_INTEGER)).filter((t) => t.kind === 'reconcile');
    for (const t of timers) if (!this.d.projects.some((p) => p.id === t.projectId)) await this.d.store.deleteTimersFor(t.projectId, t.ticketId);
    for (const p of this.d.projects) {
      const ticketId = reconcileTicket(p.id);
      if (timers.some((t) => t.ticketId === ticketId)) continue;
      await this.d.store.putTimer({ key: `${ticketId}:reconcile`, projectId: p.id, ticketId, kind: 'reconcile', payload: {}, fireAt: this.d.clock.now() + RECONCILE_MS });
    }
    this.wake();
  }

  private async move(project: ProjectRuntime, t: TicketState, to: LogicalState, keepReviewSha?: boolean): Promise<void> {
    const stateName = project.workflow.states[to];
    // The loader refuses a move to an undeclared status; a version frozen before it may still hold one.
    if (!stateName) throw new Error(`no status for "${to}" in the workflow of ${project.id}`);
    await this.d.store.putEcho(stateEchoKey(t.ticketId, stateName), this.d.clock.now() + ECHO_MS);
    await this.d.tracker.moveTo(t.ticketId, stateName);
    // Only a move that concludes the factory's work records the commit shown; a move back keeps the reviewed one.
    const reviewSha = to !== 'human_review' ? undefined : keepReviewSha ? t.reviewSha : await this.headShown(project, t);
    await this.apply(await this.ticket(project.id, t.ticketId), { type: 'status.recorded', to, ...(reviewSha ? { reviewSha } : {}) });
  }

  /**
   * The head of the ticket's open PR as the factory shows it in Human Review (ORC-148): the only commit a Done merges.
   * Recorded only when it is the commit the ticket's worktree ended its run on: a head pushed meanwhile, which the
   * run (a review) never read, is no reviewed commit. Unread (no branch, no PR, no worktree, the forge down) or
   * different, none is recorded: a Done is refused until the factory moves the ticket to Human Review again.
   */
  private async headShown(project: ProjectRuntime, t: TicketState): Promise<string | undefined> {
    if (!t.branch || !t.worktreePath) return undefined;
    try {
      const [pr, local] = await Promise.all([this.d.forge.findPr(project.repoPath, t.branch), this.d.workspaces.head(t.worktreePath)]);
      if (pr?.state !== 'OPEN' || !pr.headSha) return undefined;
      if (pr.headSha === local) return pr.headSha;
      this.log('warn', `head of ${t.ticketId}'s PR (${pr.headSha}) is not the commit its run ended on (${local ?? 'unread'}): no reviewed commit`);
      return undefined;
    } catch (err) {
      this.log('warn', `head of ${t.ticketId}'s PR unread at Human Review: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * The draft goes to its human reviewer with the ticket: GitHub merges no draft. Best effort: a human can do it, and until then the merge
   * refused says why. No PR, nothing to do.
   */
  private async prReady(project: ProjectRuntime, t: TicketState): Promise<void> {
    if (t.prNumber === undefined || t.prState !== 'OPEN' || !this.d.forgeWriter) return;
    await this.d.forgeWriter.markPrReady(project.repoPath, t.prNumber).catch((err: Error) => this.log('warn', `PR #${t.prNumber} of ${t.ticketId} still a draft: ${err.message}`));
  }

  /**
   * The `publish` effect (ORC-125): the commit `verify` found green, out to the forge by the factory. A ticket that let go of the
   * attempt meanwhile (a stop) publishes nothing. Its result comes back through the inbox, keyed by the effect: `pr.opened` under the id
   * the webhook gives it, so that the first of the two counts, then `publish.done`. A refusal is decided once, as the merge's: its mark makes
   * a replay send the same one again instead of reading a forge that changed. Anything else throws, and the outbox retries it:
   * a push already made is found by the publisher, and the PR by its branch.
   */
  private async publish(project: ProjectRuntime, t: TicketState, c: Extract<Effect, { kind: 'publish' }>, key: EffectKey): Promise<void> {
    if (t.verifyingRunId !== c.runId) {
      this.log('info', `publish of ${t.ticketId} dropped: the ticket let go of run ${c.runId}`);
      return;
    }
    const mark = `effect:${key.id}:refused`;
    const payload = { runId: c.runId, job: c.job, sha: c.sha };
    const base = { ...TRUSTED, projectId: project.id, ticketId: t.ticketId };
    const refuse = async (reason: string) => void (await this.accept({ ...base, id: `publish-refused:${key.id}`, type: 'publish.refused', at: this.d.clock.now(), payload: { ...payload, reason } }));
    const published = async () => void (await this.accept({ ...base, id: `publish-done:${key.id}`, type: 'publish.done', at: this.d.clock.now(), payload: { ...payload, ...(c.output ? { output: c.output } : {}) } }));
    const known = key.replay ? await this.d.store.getMeta(mark) : undefined;
    if (known) return refuse(known);
    let reason: string;
    const { publisher } = this.d;
    if (!mayPublish(t, c.sha, project.workflow)) reason = `the commit ${c.sha.slice(0, 12)} has no green verification, the last one is on ${t.verifiedSha?.slice(0, 12) ?? 'no commit'}.`;
    else if (!publisher) reason = "the factory publishes through a GitHub App from its sandboxes, and this instance has none (docs/github.md).";
    else if (!t.branch || !t.worktreePath) reason = `no branch or no worktree for ${t.ticketId}.`;
    else {
      try {
        // A rebase may replace what the factory published last on the branch, and nothing else (ORC-146).
        const [mark, rewrites] = await Promise.all([this.untrustedMark(project, t), c.rewrite ? this.lastPublished(project.id, t.ticketId) : undefined]);
        const untrusted = mark ? { untrusted: mark } : {};
        const text = await this.policy.pr(prText(t));
        const pr = await publisher.publish({ projectId: project.id, repoPath: project.repoPath, ticketId: t.ticketId, runId: c.runId, worktree: t.worktreePath, branch: t.branch, sha: c.sha, ...untrusted, ...(rewrites ? { rewrites } : {}), ...text });
        await this.accept({ ...base, id: prEventId(t.ticketId, pr.prNumber, 'opened'), type: 'pr.opened', at: this.d.clock.now(), payload: { number: pr.prNumber, url: pr.url, branch: t.branch } });
        await this.publishChecks(project, t, c);
        return published();
      } catch (err) {
        if (err instanceof OutputRefused) reason = `the PR's text does not pass the output policy: ${err.refusals.map((r) => r.detail).join('; ')}.`;
        else if (err instanceof PublishRefused) {
          // A run that committed nothing has nothing to show: it ends as it would have, without a PR.
          if (err.code === 'empty') return published();
          reason = err.message;
        } else throw err;
      }
    }
    await this.d.store.setMeta(mark, reason);
    await refuse(reason);
  }

  /**
   * The head the factory published last on the ticket's branch (ORC-146), read from its journal: the sha of its last
   * `publish.done`, which is journaled once the push is on the forge. The one head a rebase may replace.
   */
  private async lastPublished(projectId: string, ticketId: string): Promise<string | undefined> {
    const done = (await this.d.store.ticketJournal(projectId, ticketId)).findLast((e) => e.event.type === 'publish.done');
    return (done?.event.payload as EventPayloads['publish.done'] | undefined)?.sha;
  }

  /**
   * The checks `verify` found green, on the commit just pushed (ORC-151): only a pushed commit can carry one, so a red
   * verdict, never pushed, has none. Keyed by the sha and the check: a replay, or a second publication of the same commit,
   * updates them, never doubles them. Best effort, as `prReady`: the PR is out, and a check that fails to go out blocks nothing.
   */
  private async publishChecks(project: ProjectRuntime, t: TicketState, c: Extract<Effect, { kind: 'publish' }>): Promise<void> {
    const writer = this.d.forgeWriter;
    if (!writer) return;
    const { sha, commands } = c;
    const frozen = Object.keys(t.frozenTests?.files ?? {}).length;
    const verify =
      commands === undefined
        ? ({ conclusion: 'success', summary: `${sha.slice(0, 12)} already found green by an earlier verification.` } as const)
        : commands.length
          ? ({ conclusion: 'success', summary: `Green on ${sha.slice(0, 12)}, in a fresh clone, without network:\n${commands.map((cmd) => `- ${mdCode(cmd)}`).join('\n')}` } as const)
          : ({ conclusion: 'neutral', summary: 'No verification command declared: nothing ran.' } as const);
    const checks = [
      { name: VERIFY_CHECK, ...verify },
      { name: FREEZE_CHECK, conclusion: frozen ? 'success' : 'neutral', summary: frozen ? `${frozen} frozen file(s) intact.` : 'No frozen test for this ticket.' },
      { name: ANTI_CHEAT_CHECK, conclusion: 'success', summary: ANTI_CHEAT_OK },
    ] as const;
    await Promise.all(
      checks.map(({ name, conclusion, summary }) =>
        writer.upsertCheckRun(project.repoPath, { sha, name, externalId: `${name}@${sha}`, status: 'completed', conclusion, summary }).catch((err: Error & { status?: number }) => {
          const hint = err.status === 403 ? ': the GitHub App lacks the Checks write permission (docs/github.md)' : '';
          this.log('warn', `check ${name} of ${t.ticketId} not published on ${sha.slice(0, 12)}${hint}: ${err.message}`);
        }),
      ),
    );
  }

  /**
   * The `merge` effect (ORC-148). The forge is read first, as only it knows the checks of the reviewed commit: the
   * PR still open, its head still that commit, its checks green. Then merged with that head imposed, so a push in
   * between is refused by GitHub itself. A refusal reaches the human through `pr.merge_refused`, and is decided once:
   * its mark, written before the event, makes a replay (a lost lease, a failed inbox write) send the same refusal
   * again (the inbox drops the copy by its id) instead of reading the forge anew, where checks green since would merge.
   */
  private async merge(project: ProjectRuntime, t: TicketState, sha: string, key: EffectKey): Promise<EffectOutcome | void> {
    if (t.prNumber === undefined) return;
    const mark = `effect:${key.id}:refused`;
    const saved = key.replay ? await this.d.store.getMeta(mark) : undefined;
    if (saved) return this.refuseMerge(project, t, key, upcastMergeRefusal(saved));
    const writer = this.d.forgeWriter;
    const pr = t.branch ? await this.d.forge.findPr(project.repoPath, t.branch) : undefined;
    let reason: string;
    // Said by the forge (`head_moved`) or seen here, never read back from the sentence (ORC-345).
    let headMoved = false;
    if (pr?.number === t.prNumber && pr.state === 'MERGED') {
      if (pr.headSha === sha) return { deduplicated: true };
      // Merged on GitHub meanwhile, on another head: no refusal to answer, the merge's own events deliver the ticket.
      this.log('info', `merge of ${t.ticketId} dropped: PR #${pr.number} already merged on ${pr.headSha}`);
      return;
    }
    if (!t.branch) reason = 'the ticket\'s branch is unknown';
    else if (pr && pr.number !== t.prNumber) reason = `the branch's PR (#${pr.number}) is not the ticket's (#${t.prNumber})`;
    else if (!writer) reason = "the factory's GitHub App is required to merge";
    else if (pr?.state !== 'OPEN') reason = 'the PR is no longer open';
    else if (pr.headSha !== sha) {
      reason = MERGE_PUSHED;
      headMoved = true;
    }
    else if (pr.checks !== 'pass' && pr.checks !== 'none') reason = `the checks of the reviewed commit are not green (${pr.failedChecks.join(', ') || pr.checks})`;
    else {
      // No check at all: the forge merges only in a repository with no CI (`mergePr`, `unchecked`).
      // GitHub merges no draft: a Done is a merge decision, whatever became of the move's best effort (`prReady`).
      await writer.markPrReady(project.repoPath, t.prNumber);
      const res: MergeResult = await writer.mergePr(project.repoPath, t.prNumber, sha, pr.checks === 'none' ? { unchecked: true } : undefined);
      if (res.merged) return res.deduplicated ? { deduplicated: true } : undefined;
      headMoved = res.reason === 'head_moved';
      reason = res.reason === 'head_moved'
        ? MERGE_PUSHED
        : res.reason === 'checks_missing'
          ? 'no check ran on the reviewed commit, while the repository has a CI or the factory cannot check that it has none (CI not started yet, checks just appearing, or a GitHub App without the Actions read permission)'
          : `GitHub refuses the merge (${res.message})`;
    }
    const refusal: MergeRefusal = { reason, headMoved };
    await this.d.store.setMeta(mark, JSON.stringify(refusal));
    await this.refuseMerge(project, t, key, refusal);
  }

  /** The `pr.merge_refused` of a merge effect, keyed by it. A failed write throws, so that the outbox retries the effect. */
  private async refuseMerge(project: ProjectRuntime, t: TicketState, key: EffectKey, { reason, headMoved }: MergeRefusal): Promise<void> {
    await this.accept({
      ...TRUSTED,
      id: `merge-refused:${key.id}`,
      type: 'pr.merge_refused',
      at: this.d.clock.now(),
      projectId: project.id,
      ticketId: t.ticketId,
      payload: { number: t.prNumber!, url: t.prUrl ?? '', branch: t.branch ?? '', reason, headMoved },
    });
  }

  /**
   * `admitted` is called once the start took its slot, or will not take one (`drainNow`); `recorded`
   * once the run is written. Resolves `queued` when the start went to the queue, `deferred` when it was set pending
   * behind a run that holds the ticket, `done` otherwise (started, refused or blocked). Throws `RetryableStart` when
   * its launch failed before its `run.started`.
   */
  private async startRun(
    project: ProjectRuntime,
    ticketId: string,
    opts: StartOpts,
    from: StartFrom = {},
  ): Promise<StartOutcome> {
    const { admitted, recorded } = from;
    const job = project.workflow.jobs[opts.job];
    if (!job) {
      this.log('error', `unknown job ${opts.job}`);
      return 'done';
    }
    const t = await this.ticket(project.id, ticketId);
    // As decide refuses it, also for the starts it does not see: the pending job by settle, the queue by drain.
    const refused = refusesDevWork(t, job);
    if (refused === 'undelegated') {
      this.log('warn', `refused ${job.name} on ${ticketId}: the ticket is not delegated to ${PRODUCT_NAME}`);
      return 'done';
    }
    if (refused === 'merged') {
      this.log('info', `refused ${job.name} on ${ticketId}: its PR is merged`);
      return 'done';
    }
    // A decision that starts a dev job unblocks the ticket first: blocked now, it was blocked since
    // (a failed launch whose notice failed, a stop, recover()), and a retried or queued start must
    // not launch a run on it.
    if (job.queue === 'dev' && t.blocked) {
      this.log('warn', `refused ${job.name} on ${ticketId}: the ticket is blocked (${t.blockReason ?? 'no reason'})`);
      return 'done';
    }
    if (job.workspace === 'knowledge' && this.d.knowledgeConfigured === false) {
      this.log('info', `skipped ${job.name} on ${ticketId}: no knowledge repo configured`);
      if (opts.linearSessionId) {
        await this.d.tracker
          .activity(opts.linearSessionId, { type: 'response', body: `No knowledge base is configured for ${PRODUCT_NAME}: I cannot remember anything.` })
          .catch((err: Error) => this.log('warn', `could not answer ${ticketId}: ${err.message}`));
      }
      return 'done';
    }
    // Handed out of the queue: back in line through its claim (`releaseQueued`), not as a new request.
    const fromQueue = recorded !== undefined;
    const item = {
      projectId: project.id,
      ticketId,
      job: job.name,
      queue: job.queue,
      input: opts.input,
      inputText: opts.inputText,
      linearSessionId: opts.linearSessionId,
      resume: opts.resume,
      sensitivePaths: opts.sensitivePaths,
      relaunchOf: opts.relaunchOf,
      priority: t.priority,
      enqueuedAt: opts.enqueuedAt ?? this.d.clock.now(),
      // Its own mark, not the effect's: the effect's is `1` once the start is queued. A start of no effect (a pending
      // job by `settle`) gets one too: cut once launched, handed out again, it must not run beside its relaunch (ORC-220).
      startMark: fromQueue ? opts.startMark : `${opts.startMark ?? `start:${project.id}:${ticketId}:${job.name}:${this.d.clock.now()}`}:queued`,
    };
    // Back in line: through its claim for a start handed out of the queue, as a new request otherwise.
    const requeue = async (): Promise<'queued'> => {
      if (!fromQueue) await this.d.scheduler.enqueue(item);
      return 'queued';
    };
    // A step the usage limit cut holds the ticket's next ones too (ORC-340): it resumes first, at the reset, and they follow it.
    if (job.queue === 'dev' && (t.activeRunId || t.verifyingRunId || t.usageWait)) {
      const start = pendingOf({ ...opts, job: job.name });
      // Handed out of the queue to a ticket that holds another pending job: it stays in line, never in that one's place (ORC-339).
      if (fromQueue && t.pendingJob && !samePending(t.pendingJob, start)) return requeue();
      await this.apply(t, { type: 'pending.set', job: start });
      return 'deferred';
    }
    if (this.stopping || (await this.isPaused()) || (await this.usageLimited())) return requeue();
    const key = `${ticketId}:${job.queue}`;
    // A start from a decision leaves alone the slots a drain promised to the items it dequeued.
    const promised = admitted ? 0 : this.admitting[job.queue];
    const slot = this.d.scheduler.free(job.queue) > promised ? this.d.scheduler.tryAcquire(job.queue, key) : null;
    admitted?.();
    if (slot === null) return requeue();
    // Drawn here: a launch that fails lets go of its own run only, never another launch's (ORC-339).
    const runId = this.newId();
    try {
      const launched = await this.launch(project, ticketId, job, opts, slot, key, runId, recorded);
      // Lost to another job while the ticket holds yet another pending one: back in line.
      return launched === 'queued' ? await requeue() : (launched ?? 'done');
    } catch (err) {
      this.d.scheduler.release(key);
      // Failed before its `run.started` (ORC-339): nothing of the run is the ticket's, the start is tried again (the
      // effect's retry, the drain's bounded one). Past it, the run may be the ticket's: a launch error, as before.
      if (err instanceof RetryableStart) throw err;
      await this.launchFailed(project, ticketId, job, opts, err, runId);
      return 'done';
    }
  }

  /**
   * A launch that failed: the run it put on the ticket (`runId`, its own) is let go, and the ticket is blocked on its
   * job, said once. A run of another launch the ticket holds stays as it is (ORC-339).
   */
  private async launchFailed(project: ProjectRuntime, ticketId: string, job: JobSpec, opts: StartOpts, err: unknown, runId: string | undefined): Promise<void> {
    let fresh = await this.ticket(project.id, ticketId);
    const events: InternalEvent[] = [];
    if (runId !== undefined && fresh.activeRunId === runId) {
      const r = await this.d.store.getRun(fresh.activeRunId);
      if (r && r.status === 'running' && !this.handles.has(r.id)) await this.d.store.putRun({ ...r, status: 'failure', endedAt: this.d.clock.now() }, r.leaseToken ?? 0);
      if (!this.handles.has(fresh.activeRunId)) events.push({ type: 'run.cleared' });
    }
    // A file the repository has to fix is not a breakdown of the factory: the Flow shows it as such (`repo_config`).
    const [kind, reason]: [BlockKind, string] =
      err instanceof RepoConfigError ? ['repo_config', `${REPO_CONFIG_REFUSED}${err.message}`] : err instanceof TicketBudgetError ? ['budget', err.message] : ['infra', `Launch error: ${(err as Error).message}`];
    fresh = await this.apply(fresh, ...events, blockedOn(project.workflow, kind, reason, job.name));
    // The ticket is blocked: a failed notice must not fail the effect, whose retry would start again.
    try {
      await this.tellBlock(project, fresh, blockFacts({ reason, step: stepOf(project.workflow, job.name), tried: [`The launch of ${job.name}.`] }), async (failed) => {
        const session = opts.linearSessionId ?? (await this.sessionFor(failed));
        await this.d.tracker.activity(session, { type: 'error', body: reason });
      });
    } catch (e) {
      this.log('warn', `could not post the launch error of ${ticketId}: ${(e as Error).message}`);
    }
  }

  /**
   * Whether the start a mark (`StartOpts.startMark`) names was handled (ORC-277). A launch writes the
   * mark with its run's id before it puts the run on the ticket and writes it; an outbox effect sets
   * it to `1` once its start is handled. A run id whose run was never written is a launch cut before
   * it, which nothing launched: the start runs again. A written run, even never started by the
   * runner, is recover()'s (`run.lost`: its step started again by a start of its own, a question
   * to ask again): this start never launches it again.
   */
  private async startHandled(mark: string): Promise<boolean> {
    const value = await this.d.store.getMeta(mark);
    if (value === undefined) return false;
    return value === '1' || (await this.d.store.getRun(value)) !== undefined;
  }

  /** Tokens the ticket's code runs spent (`budgets.per_ticket_tokens`, ORC-340), cache reads left out: its questions (`ask`, `learn`) do not count. */
  private async codeTokensSpent(projectId: string, ticketId: string): Promise<number> {
    return codeRunTokens(await this.d.store.ticketRuns(projectId, ticketId)) ?? 0;
  }

  /** What is left under `cap` (ORC-340), undefined without one. Spent, it throws: the launch is refused and the ticket blocked with the reason. */
  private tokensLeft(spent: number, cap: number | undefined): number | undefined {
    if (cap === undefined) return undefined;
    if (spent >= cap) throw new TicketBudgetError(`${TICKET_TOKENS_REACHED}${spent} tokens spent of ${cap} by its code runs (budgets.per_ticket_tokens). Raise the cap (factory.yml counts once the daemon restarts, the repository's .factory/config.yml at the next launch) or split the ticket, then reply here.`);
    return cap - spent;
  }

  /**
   * `launchRun`, whose transient failure before its `run.started` (Linear, GitHub or the database down: `isTransient`)
   * is a start to try again (ORC-343), as its failed reads and writes of the factory's state are (ORC-339).
   */
  private async launch(
    project: ProjectRuntime,
    ticketId: string,
    job: JobSpec,
    opts: StartOpts,
    slot: number,
    key: string,
    runId: string,
    recorded?: () => Promise<void>,
  ): Promise<StartOutcome | undefined> {
    const at = { started: false };
    try {
      return await this.launchRun(project, ticketId, job, opts, slot, key, runId, at, recorded);
    } catch (err) {
      if (!at.started && !(err instanceof RetryableStart) && isTransient(err)) throw new RetryableStart(err);
      throw err;
    }
  }

  /** `at.started`: set once the launch writes its `run.started`; from there, the run may be the ticket's. */
  private async launchRun(
    project: ProjectRuntime,
    ticketId: string,
    job: JobSpec,
    opts: StartOpts,
    slot: number,
    key: string,
    runId: string,
    at: { started: boolean },
    recorded?: () => Promise<void>,
  ): Promise<StartOutcome | undefined> {
    const { tracker, store, clock, workspaces, forge } = this.d;
    const wf = project.workflow;
    // What the launch starts, in the shape of a pending job: its `run.started` names it (ORC-339).
    const start = pendingOf({ ...opts, job: job.name });
    /** The ticket holds another dev run (another worker's launch won the race). */
    const taken = (x: TicketState): boolean => job.queue === 'dev' && !!x.activeRunId;
    /**
     * Another launch took the ticket (ORC-339). Its run is this very start, all of it (a settle taken up by another
     * worker after a lost lease): nothing more to start. Another start: this one waits behind it, pending, as
     * `startRun` sets a start that meets a busy ticket, unless the ticket holds another pending job, which it never
     * replaces: then it goes back in line (`queued`).
     */
    const lose = async (holder: TicketState): Promise<StartOutcome> => {
      this.d.scheduler.release(key);
      if (samePending(holder.activeStart, start)) {
        this.log('warn', `${job.name} on ${ticketId} not launched: run ${holder.activeRunId} of the same start took the ticket first`);
        return 'done';
      }
      if (holder.pendingJob && !samePending(holder.pendingJob, start)) {
        this.log('warn', `${job.name} on ${ticketId} not launched: run ${holder.activeRunId} took the ticket first, and another job waits behind it: back in line`);
        return 'queued';
      }
      this.log('warn', `${job.name} on ${ticketId} not launched: run ${holder.activeRunId} took the ticket first, it waits behind it`);
      if (!holder.pendingJob) await this.apply(holder, { type: 'pending.set', job: start });
      return 'deferred';
    };
    /** The factory's own state, read or written before the `run.started`: its failure is a start to try again. */
    const state = <T>(io: Promise<T>): Promise<T> =>
      io.catch((err: unknown) => {
        throw new RetryableStart(err);
      });

    // Before any workspace (ORC-340): factory.yml's cap now, the repository's, read from its config, once the worktree is there.
    // Read only under a cap: without one, a launch reads no run of the ticket.
    let spent = job.queue === 'dev' && this.d.perTicketTokens !== undefined ? await state(this.codeTokensSpent(project.id, ticketId)) : undefined;
    if (spent !== undefined) this.tokensLeft(spent, this.d.perTicketTokens);

    // Read while the workspace is prepared; a pack it cannot read gives null fingerprints (ORC-226).
    const pack = packFingerprints(this.d.packDir, (err) => this.log('warn', `attempt labels: pack not fingerprinted: ${err.message}`));

    // Up to the workspace: a launch that lost does nothing.
    const head = await (async () => {
      const t = await state(this.ticket(project.id, ticketId));
      if (taken(t)) return { lost: t } as const;
      const issue = await tracker.getIssue(ticketId);
      // The deterministic checks, before the ticket's first run: at intake, inputs of its guard, journaled with its end
      // (ORC-206); else they block a job that picks up the ticket. The « blocked by » tickets not done likewise (ORC-363),
      // except that they make the job wait instead of blocking it.
      const intake = job.step === 'intake';
      const guarded = (intake || job.pickup) && !t.claudeSessionId;
      const failures = guarded ? await pickupFailures(wf.tracker.pickup.checks, issue, project.repoPath, workspaces) : [];
      const blockers = guarded ? openBlockers(issue) : [];
      if (!intake && failures.length) {
        this.d.scheduler.release(key);
        const reason = failures.join(' ');
        const refused = await this.apply(t, blockedOn(project.workflow, 'pickup', reason, job.name));
        await this.tellBlock(project, refused, blockFacts({ reason, step: 'intake', tried: failures, question: 'Can you fix this, then reply here?' }), async (blocked) => {
          const session = await this.sessionFor(blocked);
          await tracker.activity(session, {
            type: 'elicitation',
            body: `I cannot start this ticket:\n${failures.map((f) => `- ${f}`).join('\n')}\nFix it, then reply in this thread.`,
          });
        });
        return undefined;
      }
      if (!intake && blockers.length) {
        this.d.scheduler.release(key);
        const waiting = await state(this.apply(t, waitingOn(blockers, start)));
        this.log('info', `${job.name} on ${ticketId} waits for ${blockers.map((b) => b.identifier).join(', ')} to be done`);
        try {
          await tracker.activity(await this.sessionFor(waiting), { type: 'thought', body: waitingBody(blockers) });
        } catch (err) {
          this.log('warn', `could not tell ${ticketId}'s session that it waits: ${(err as Error).message}`);
        }
        return undefined;
      }
      const asked = { projectId: project.id, repoPath: project.repoPath, ticketId, title: issue.title, kind: job.workspace, slot, portBase: wf.workspace.portBase, runId };
      let ws = await workspaces.prepare(asked);
      // Left by a daemon killed before the end of its setup (ORC-211): half installed, perhaps holding a secret the
      // configuration no longer names, so sealing it again proves nothing. It is made anew; no agent has worked in it.
      if (await state(store.getMeta(setupPendingKey(ws.path)))) {
        await workspaces.cleanup(project.id, ticketId);
        await state(store.setMeta(setupPendingKey(ws.path), ''));
        ws = await workspaces.prepare(asked);
      }
      return { issue, ws, lost: undefined, pickup: intake && failures.length ? failures : undefined, blockedBy: intake && blockers.length ? blockers : undefined };
    })();
    if (!head) return undefined;
    if (head.lost) return lose(head.lost);
    const { issue, ws, pickup, blockedBy } = head;
    // Read again before the first write: the workspace took time.
    let t: TicketState;
    // A fresh worktree is not set up until its setup succeeds: a launch ending before removes it, or
    // the next prepare would find it there (not fresh) and setup would never run.
    let setUp = !ws.fresh;
    let sandbox: Sandbox | undefined;
    // Until pump has it, the sandbox is the launch's: whatever ends the launch before destroys it.
    let handedOver = false;
    try {
      // Read once, on the default branch (ORC-209 C): an invalid file refuses the launch, and a fresh worktree goes with
      // it. A fresh worktree's `prepare` has just fetched the forge, as a question's trunk always does.
      const config = await this.repoConfigOf(project, { fetch: !ws.fresh && job.workspace !== 'trunk-readonly' });
      const setup = config.setup ? [config.setup] : wf.workspace.setup;
      setUp ||= !setup.length;
      const cap = ticketTokenCap(this.d.perTicketTokens, config);
      if (job.queue === 'dev' && cap !== undefined) spent ??= await state(this.codeTokensSpent(project.id, ticketId));
      const tokensLeft = spent === undefined ? undefined : this.tokensLeft(spent, cap);
      // The ticket's budget left caps the attempt too: past it, a `limit` blocks the ticket. Kept on the run, for a reattach (ORC-340).
      const limits = tokensLeft === undefined ? job.limits : { ...job.limits, tokens: Math.min(job.limits.tokens ?? Infinity, tokensLeft) };
      t = await state(this.ticket(project.id, ticketId));
      if (taken(t)) {
        // Lost while the workspace was prepared, before the first write of the launch: the worktree is the winner's now.
        setUp = true;
        return await lose(t);
      }
      if (job.queue === 'dev') t = await state(this.apply(t, { type: 'workspace.prepared', path: ws.path, port: ws.port, branch: ws.branch }));
      if (job.onStart.move && t.logical !== job.onStart.move) await this.move(project, t, job.onStart.move);
      t = await state(this.ticket(project.id, ticketId));

      // A relaunch reads what the lost attempt read, whatever came in since stays for the next run (ORC-220).
      const from = opts.relaunchOf ? await state(store.getRun(opts.relaunchOf)) : undefined;
      // A question asked again (a usage reset, ORC-340) answers in the thread it was asked in.
      const linearSessionId = opts.linearSessionId ?? (job.queue === 'questions' ? from?.linearSessionId : undefined) ?? (await this.sessionFor(t));
      t = await state(this.ticket(project.id, ticketId));
      // The feedback the run reads, taken at the launch whoever started it (a decision, settle, the queue):
      // its taint completes the one the start was decided with (I12, ORC-274).
      const kind = from ? undefined : (opts.input ?? job.input);
      // The implementer's run (a `dev` from scratch or a resume) runs the ticket session: resumed when the
      // ticket has one, else made here and taken by the ticket. A review or a question never does (ORC-217).
      // A relaunch runs the session the lost attempt ran. Cut before Claude wrote it, that session does not
      // exist yet: it starts under the id the ticket already holds (ORC-128).
      const ticketSession = job.queue === 'dev' && (from?.sessionRole ? from.sessionRole === 'implementer' : (opts.resume ?? (job.session === 'resume' || job.pickup)));
      // Its step boundary (ORC-180): the agent that implements starts a step, it reads what came in since its last one.
      const carried = !from && kind !== 'feedback' && ticketSession ? carriedAtLaunch(t.humanInbox) : [];
      const read: FeedbackItem[] = [...carried];
      if (kind === 'feedback') {
        read.push(...forAgent(t.humanInbox));
        // Review comments are external content: whoever can comment on the PR wrote them, and nothing
        // authenticates them as the team's (ORC-160). Untrusted, whatever the forge says.
        if (t.prNumber) {
          const comments = await forge.unresolvedReviewComments(project.repoPath, t.prNumber);
          read.push(...comments.map((c) => ({ ...c, taint: 'untrusted' as const })));
        }
      }
      const held = ticketSession ? t.claudeSessionId : undefined;
      const resume = !!held && (!opts.relaunchOf || !this.d.sessionsDir || sessionSaved(join(this.d.sessionsDir, project.id, ticketId), held));
      // A launch that empties the inbox takes the taint of all it empties, what the agent is not given included (`runTaint`).
      const consumes = kind === 'feedback' || carried.length > 0;
      const fedUntrusted = sensitivePathsAtLaunch(opts.sensitivePaths ?? from?.sensitivePaths, consumes ? [...read, ...t.humanInbox] : read);
      // What the run reads beyond its input takes the mark of who wrote it, not of who started the run (ORC-349): a resumed
      // session, what its earlier attempts read, which the branch's mark keeps (ORC-338); a knowledge job, whatever its
      // input, the ticket and its PR (`gh`, `/agent/issue`), so their whole history too. The mark read here serves below.
      const knowledge = job.workspace === 'knowledge';
      const readsTicket = !fedUntrusted && (resume || knowledge);
      const seen = readsTicket ? await state(this.readUntrusted(project, t)) : t;
      const marked = typeof seen.untrustedSince === 'string';
      const journal = readsTicket && knowledge ? await state(this.journalOf(project, t)) : undefined;
      const history = readsTicket && (marked || (!!journal && historyTaint(journal) === 'untrusted'));
      const sensitivePaths = fedUntrusted ?? (history ? SENSITIVE_PATHS : undefined);
      if (sensitivePaths && knowledge) {
        // As decide refuses it (I12), for what it could not see: untrusted content read at the launch.
        this.d.scheduler.release(key);
        this.log('warn', `refused ${job.name} on ${ticketId}: it would write the knowledge base from untrusted content`);
        await tracker
          .activity(linearSessionId, { type: 'response', body: taintedKnowledge(job.name, fedUntrusted ? 'read' : 'history') })
          .catch((err: Error) => this.log('warn', `could not answer ${ticketId}: ${err.message}`));
        return;
      }

      const claudeSessionId = held ?? this.newId();
      const sessionRole = roleOf(job, ticketSession);

      const vars = await this.repoVariablesOf(project, config);
      if (!setUp) {
        await state(store.setMeta(setupPendingKey(ws.path), '1'));
        await this.runSetup(project, ticketId, ws, runId, vars, setup);
        await state(store.setMeta(setupPendingKey(ws.path), ''));
      }
      setUp = true;
      // Opened after the cheap exits above and after the setup, whose container is gone by now (ORC-211).
      sandbox = this.d.sandboxes && (await this.openSandbox(this.d.sandboxes, project, ticketId, ws, runId, ticketSession, agentPolicy(config)));
      // In each run's prompt, not the system prompt: read again at each attempt, never frozen at a resume
      // (ORC-128). The reset below keeps `.claude/CLAUDE.md`: the order does not matter.
      const conventions = readConventions(ws.path);
      // After the setup, which is the repository's and could write one; the session loads none anyway
      // (`--setting-sources ""`): defence in depth, for what ORC-128 did not trap (ORC-284).
      await workspaces.resetClaudeDir(ws.path);
      // The head the tests step starts on (ORC-123): its red check reads the step's own commits from it. A return
      // to the step, a reply or a relaunch keeps the first one, so its earlier commits still count; only a step that has none takes one.
      if (job.red && ((!kind && !opts.relaunchOf) || !(await state(store.getMeta(redBaseKey(project.id, ticketId)))))) await state(store.setMeta(redBaseKey(project.id, ticketId), (await workspaces.head(ws.path)) ?? ''));

      let input: { kind: InputKind; text: string } | undefined;
      if (from) {
        input = from.input;
      } else if (kind === 'feedback') {
        input = { kind, text: read.length ? formatFeedback(read) : '(no written feedback: read the PR and the Linear thread again)' };
      } else if (kind === 'verify_failures') {
        input = { kind, text: formatVerifyFailures(JSON.parse(opts.inputText ?? '[]') as VerifyFailure[]) };
      } else if (kind === 'ci_failures') {
        input = { kind, text: opts.inputText ?? 'The PR\'s CI is failing. Run `gh pr checks` for the details.' };
      } else if (kind === 'thread') {
        input = { kind, text: opts.inputText ?? '' };
      }
      if (carried.length) input = withHumanInbox(input, carried);

      const promptInput = {
        skill: job.skill,
        issue: { identifier: issue.identifier, title: issue.title, description: issue.description, url: issue.url },
        branch: job.queue === 'dev' ? t.branch : undefined,
        prUrl: t.prUrl,
        // What `clarify`'s answers decided (ORC-210), for the steps after the guard: intake reads them as its feedback.
        decisions: job.queue === 'dev' && job.step !== 'intake' && t.decisions?.length ? t.decisions : undefined,
        conventions,
        input,
        // A knowledge job without an input (`learn` after a merge) is given what the factory ingested of the ticket, and reads
        // nothing else of the forge but the merged diff (ORC-361): a comment never ingested carries no taint.
        conversation: journal && !input ? ingestedConversation(journal) : undefined,
        reviewRounds: wf.limits.reviewRounds,
        resumedAfterCut: !!opts.relaunchOf && resume,
      };
      const prompt = buildPrompt(promptInput);
      const labels = attemptLabels({ job, prompt, promptInput, workflow: wf, pack: await pack, factoryCommit: this.d.factoryCommit, risk: t.risk ?? null });

      const run: RunRecord = {
        id: runId,
        projectId: project.id,
        ticketId,
        job: job.name,
        queue: job.queue,
        status: 'running',
        claudeSessionId,
        sessionRole,
        linearSessionId,
        startedAt: clock.now(),
        costUsd: 0,
        turns: 0,
        lastText: '',
        token: this.newId(),
        leaseToken: 1,
        cwd: ws.path,
        labels,
        sensitivePaths,
        ...(input ? { input } : {}),
        repoConfig: config,
        ...(limits !== job.limits ? { limits } : {}),
        ...(pickup ? { pickup } : {}),
        ...(blockedBy ? { blockedBy } : {}),
      };
      // The mark, then the ticket, then the run (`startHandled`, ORC-277): a dev ticket holds its run before
      // the run is written, so recover() finds it whichever write a crash falls after. The feedback stays
      // on the ticket until the run that read it is written: a launch cut before reads it again. The pending job this
      // run starts leaves the ticket with its `run.started` (`reduce`, ORC-339).
      if (opts.startMark) await state(store.setMeta(opts.startMark, runId));
      // In the ticket's worktree by its job, whatever the ticket still says of its path (ORC-338). A ticket from before the
      // mark is read first, so that its earlier untrusted commits keep its whole branch checked (`reduce`). `t` is kept: the
      // feedback this launch consumes is what it read.
      const marks = !!sensitivePaths && job.workspace === 'worktree';
      if (marks) await state(this.readUntrusted(project, seen));
      const untrusted = marks ? { untrusted: { head: (await workspaces.head(ws.path)) ?? '' } } : {};
      at.started = true;
      const took = await this.apply(t, {
        type: 'run.started',
        runId,
        job: job.name,
        queue: job.queue,
        claudeSessionId,
        ...(ticketSession ? {} : { ticketSession: false as const }),
        starts: start,
        ...untrusted,
      });
      // Taken in the same write by another launch (`reduce` refuses this one): it waits behind that run.
      if (job.queue === 'dev' && took.activeRunId !== runId) return await lose(took);
      await store.putRun(run);
      // Only what this launch read: a message that came in since stays for the next run (ORC-339).
      if (consumes) await this.apply(await this.ticket(project.id, ticketId), { type: 'feedback.consumed', items: t.humanInbox });
      const step = planStepOfJob(job);
      if (step) await this.updatePlan(t, (plan) => advancePlan(plan, step));
      // The run is written: a queued item it came from leaves the queue now (a crash from here on is recover()'s).
      // Logged, not thrown: the run is launched either way, and a queue item left behind is refused
      // when handed out again (its ticket has a run, or is blocked, or its mark names this run).
      await recorded?.().catch((err: Error) => this.log('warn', `queued ${job.name} on ${ticketId} not taken out of the queue: ${err.message}`));
      if (this.d.beforeRun) await this.d.beforeRun(run).catch((err: Error) => this.log('warn', `beforeRun: ${err.message}`));

      // Its lease starts here: until now the launch is alive by itself, however long `beforeRun` took. A failure leaves it to the next beat.
      await store.renewRun(runId, clock.now() + RUN_LEASE_MS, run.leaseToken).catch((err: Error) => this.log('warn', `lease of run ${runId} not written: ${err.message}`));
      const bounds = stagnationBounds(wf, job);
      const handle = this.d.runner.start({
        runId,
        cwd: sandbox ? WORKSPACE_TARGET : ws.path,
        prompt,
        claudeSessionId,
        resume,
        model: job.model,
        ...(job.effort ? { effort: job.effort } : {}),
        ...bounds,
        pluginDir: sandbox ? PACK_TARGET : this.d.packDir,
        settingsPath: sandbox ? SETTINGS_TARGET : this.settingsPath(),
        readOnly: job.workspace === 'trunk-readonly',
        limits,
        env: {
          // First: a variable of the repository never replaces one of the factory. Never its secrets (ORC-211).
          ...vars.env,
          ...this.d.agentEnv(run),
          // In a sandbox, the run's refusals log, on the host: it outlives the sandbox (ORC-217).
          ...(sandbox ? { FACTORY_REFUSALS_LOG: `${REFUSALS_TARGET}/refusals.jsonl` } : {}),
          // Read by the pack's PreToolUse hook: a knowledge run reads of the forge only the merged diff (ORC-361).
          ...(knowledge ? { FACTORY_KNOWLEDGE_RUN: '1' } : {}),
          ...this.fullReadEnvOf(t, sandbox ? WORKSPACE_TARGET : resolve(ws.path)),
          ...(ws.port !== undefined ? { PORT: String(ws.port) } : {}),
          ...CLAUDE_RUN_ENV,
          // The ticket's session dir (out of the ticket session, the run's own) as Claude's whole config dir (ORC-128 point 4), login by the env
          // (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY). On the host, the daemon's own, as before.
          ...(sandbox ? { CLAUDE_CONFIG_DIR: `${SANDBOX_HOME}/.claude` } : {}),
        },
        sensitivePaths,
        ...(sandbox ? { sandboxId: sandbox.id } : {}),
      });
      this.follow(runId, handle, run.leaseToken!, bounds.stagnation?.silentMs);
      this.liveRuns.add(runId);
      this.track(this.pump(run, job.step ?? job.name, handle, sandbox?.id), runId);
      handedOver = true;
    } finally {
      // The sandbox first: it mounts the worktree.
      if (sandbox && !handedOver) await this.destroySandbox(sandbox.id, runId);
      if (!handedOver) await workspaces.release(project.id, runId).catch((err: Error) => this.log('warn', `trunk of run ${runId} not removed after a launch cut short: ${err.message}`));
      if (!setUp) {
        await workspaces
          .cleanup(project.id, ticketId)
          .catch((err: Error) => this.log('warn', `worktree of ${ticketId} not removed after a launch that did not set it up: ${err.message}`));
      }
    }
  }

  /** A saving of tokens, never a reason to block a ticket: whatever goes wrong, the run starts without the list. */
  private fullReadEnvOf(t: TicketState, cwd: string): Record<string, string> {
    try {
      return fullReadEnv(cwd, this.d.fullReadPaths?.(t) ?? []);
    } catch (err) {
      this.log('warn', `no whole-read list for ${t.ticketId}: ${(err as Error).message}`);
      return {};
    }
  }

  /**
   * Streams a run to its end, destroys its sandbox whatever the outcome, then writes its result to the inbox. Each event
   * is progress, which keeps its lease (ORC-344). Its writes carry its lease token: refused once another daemon took it
   * over. Let go of (a shutdown, a takeover), it ends here: nothing written, its sandbox and its workspace kept.
   */
  private async pump(run: RunRecord, step: string, handle: RunHandle, sandboxId?: string): Promise<void> {
    try {
      await this.stream(run, step, handle, sandboxId);
    } finally {
      this.held.delete(run.id);
    }
  }

  private async stream(run: RunRecord, step: string, handle: RunHandle, sandboxId?: string): Promise<void> {
    const { bus, store, clock } = this.d;
    let result: RunResult | undefined;
    let fence = run.leaseToken ?? 0;
    /**
     * Its stream over: no beat renews it and none takes it over until its end is delivered. Its token, as a `leaseExpired`
     * of this process may have raised it before, is what it writes under.
     */
    const ending = () => {
      const held = this.held.get(run.id);
      if (held) held.ending = true;
      fence = held?.token ?? fence;
      this.handles.delete(run.id);
    };
    try {
      // The relay composes from the factory's words alone, a closed table and the step (ORC-214): nothing of the agent to check, and no sandbox per activity.
      const relay = new ActivityRelay(
        (a) => (run.linearSessionId ? this.relayTracker.activity(run.linearSessionId, a) : Promise.resolve()),
        step,
        this.d.activityIntervalMs ?? 2000,
        () => clock.now(),
      );
      for await (const ev of handle.events) {
        const held = this.held.get(run.id);
        if (held) held.seenAt = clock.now();
        // Its result given, a process that lingers is not silent: its end comes, whatever it writes until then.
        if (held && ev.kind === 'result') held.silentMs = Infinity;
        bus.publish({ kind: 'run', runId: run.id, ticketId: run.ticketId, ev });
        relay.push(ev);
      }
      this.liveRuns.delete(run.id);
      if (!this.held.has(run.id)) return;
      result = await handle.done;
      await relay.flush().catch((err: Error) => this.log('warn', `run ${run.id}: last activities not relayed: ${err.message}`));
      ending();
    } catch (err) {
      const message = (err as Error).message;
      this.liveRuns.delete(run.id);
      if (!this.held.has(run.id)) return;
      this.log('error', `run ${run.id} failed: ${message}`);
      try {
        handle.stop();
      } catch {
        /* best effort */
      }
      ending();
      try {
        const rec = (await store.getRun(run.id)) ?? run;
        if (rec.status !== 'running') return;
        if (!(await store.putRun({ ...rec, status: 'failure', endedAt: clock.now(), lastText: message, infra: true }, fence))) return;
      } catch (e) {
        this.log('error', `could not record failure of run ${run.id}: ${(e as Error).message}`);
      }
      // The runner broke (stream, sandbox): nothing for the agent to fix (ORC-289).
      result = { outcome: 'failure', costUsd: 0, turns: 0, lastText: message, infra: true };
    } finally {
      if (this.held.has(run.id)) {
        if (sandboxId) await this.destroySandbox(sandboxId, run.id, run);
        await this.d.workspaces.release(run.projectId, run.id).catch((err: Error) => this.log('warn', `trunk of run ${run.id} not removed: ${err.message}`));
      }
    }
    const ended = result;
    // Recording the attempt and sending its result is the store's work, not the agent's nor the runner's (ORC-289):
    // delivered until the database takes it (ORC-343). Recorded once: a retry sends only the result still missing.
    // Read once: a retry after a write whose answer was lost must not take its own record for a lease that expired.
    let end: { record?: RunRecord; send: boolean } | undefined = ended.infra ? { send: true } : undefined;
    // Made once too: a retry sends the event as first made, its time and its usage hold.
    let finished: FactoryEvent | undefined;
    await this.deliver(endKey(run.id), `the end of run ${run.id}`, async () => {
      try {
        end ??= await this.endOf(run, ended);
        if (end.record && !(await this.d.store.putRun(end.record, fence))) {
          // Another daemon took it over (ORC-344): what this one saw of it is not written, nor sent.
          this.log('warn', `run ${run.id} ended, but another daemon holds its lease: neither recorded nor sent here`);
          end.send = false;
        }
        end.record = undefined;
      } catch (err) {
        if (isTransient(err)) throw err;
        // Not recorded for good: its result still goes, the attempt did end.
        this.log('error', `run ${run.id} ended, but was not recorded: ${(err as Error).message}`);
        end = { send: true };
      }
      if (end.send) await this.accept((finished ??= await this.finishedFor(run, ended)));
    });
  }

  /**
   * An ended attempt's record, its status and what it spent, and whether its result is to be sent: not for an attempt
   * closed before its end (`leaseExpired`: `run.lost` speaks for it). A shutdown stops no attempt any more (ORC-344): one
   * that ends `stopped` meanwhile was stopped for its own sake, and its result goes.
   */
  private async endOf(run: RunRecord, result: RunResult): Promise<{ record: RunRecord; send: boolean }> {
    const rec = (await this.d.store.getRun(run.id)) ?? run;
    const closed = rec.status !== 'running';
    const record: RunRecord = {
      ...rec,
      status: closed ? rec.status : result.outcome,
      endedAt: rec.endedAt ?? this.d.clock.now(),
      costUsd: result.costUsd,
      turns: result.turns,
      lastText: result.lastText,
      ...(result.tokens ? { tokens: result.tokens } : {}),
      ...endFacts(result),
    };
    return { record, send: !closed };
  }

  /** The result of an attempt, whoever sends it: its pump, or recover() when the process died between the two (ORC-220). */
  private async finishedFor(run: RunRecord, result: RunResult): Promise<FactoryEvent<'run.finished'>> {
    let output: AgentOutput | undefined;
    let unreadable = false;
    try {
      output = await storedOutput(this.d.store, run.id);
    } catch (err) {
      // The database down: read again once it is back (`deliver`), not taken for an output the agent never gave.
      if (isTransient(err)) throw err;
      this.log('error', `output of run ${run.id} not read: ${(err as Error).message}`);
      unreadable = true;
    }
    // Only when the factory waits on it (`on_usage_limit: wait`): otherwise the run ends as any failure (ORC-340).
    // A reset already past, or none told: never sooner than `USAGE_MIN_WAIT_MS`, an hour when none was told.
    const now = this.d.clock.now();
    const account = this.account();
    const usageLimit =
      result.usageLimit && this.d.onUsageLimit === 'wait' ? { resetAt: Math.max(result.usageLimit.resetAt ?? now + USAGE_RETRY_MS, now + USAGE_MIN_WAIT_MS), account } : undefined;
    if (usageLimit) {
      const until = new Date(usageLimit.resetAt).toISOString();
      this.log('warn', `usage limit of the Claude account ${account} reached (run ${run.id}): launches held until ${until}`);
      // The account's limit: every launch on it waits for its reset (`usageLimited`), the latest one heard of. A store that fails
      // here must not hold back the result: logged, and recover() sets the hold again from the run's record.
      try {
        const key = usageHoldKey(account);
        await this.d.store.setMeta(key, String(Math.max(Number((await this.d.store.getMeta(key)) ?? 0), usageLimit.resetAt)));
      } catch (err) {
        this.log('error', `usage hold until ${until} not recorded: ${(err as Error).message}`);
      }
    }
    return {
      ...TRUSTED,
      id: endKey(run.id),
      type: 'run.finished',
      at: this.d.clock.now(),
      projectId: run.projectId,
      ticketId: run.ticketId,
      payload: {
        runId: run.id,
        job: run.job,
        outcome: result.outcome,
        costUsd: result.costUsd,
        turns: result.turns,
        lastText: result.lastText,
        attempt: attemptOutcome({ outcome: result.outcome, infraError: result.infra || unreadable }, output),
        ...(output ? { output } : {}),
        ...(result.stagnation ? { stagnation: result.stagnation } : {}),
        ...(run.pickup ? { pickup: run.pickup } : {}),
        ...(run.blockedBy ? { blockedBy: run.blockedBy } : {}),
        ...(usageLimit ? { usageLimit } : {}),
        ...(result.overBudget ? { overBudget: result.overBudget } : {}),
      },
    };
  }
}
