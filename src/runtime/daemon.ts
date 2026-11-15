import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Forge, ForgeWriter } from '../adapters/forge/types.js';
import type { SecretRef } from '../adapters/secrets/types.js';
import type { Publisher } from '../adapters/publisher/types.js';
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
  type SandboxProvider,
  type SpawnCommand,
} from '../adapters/sandbox/types.js';
import { ExecFailure } from '../adapters/exec.js';
import { ActivityRelay, composedActivity } from '../adapters/tracker/activity-relay.js';
import { IssueNotFoundError, type LabelsWritten, type Tracker, type TrackerIssue } from '../adapters/tracker/types.js';
import type { ReplayedTicket, ReplaySource } from '../ghost/delegate.js';
import type { Workspace, WorkspaceManager } from '../adapters/workspace/types.js';
import type { RepoVariables } from '../config/repo-variables.js';
import { RepoConfigError, ticketTokenCap, type RepoConfig, type RepoConfigRead } from '../config/repo-config.js';
import type { JobSpec, Workflow } from '../core/workflow.js';
import type { AckMode } from '../config/factory-yml.js';
import type { EffectRetry } from './outbox.js';
import { attemptsFor, backoff, isTransient, TRANSIENT_WINDOW_MS, type RetryPolicy } from './transient.js';
import { LEASE_MS, PAUSE_ACCEPTED, RUN_LEASE_MS, type DecisionOutcome, type DecisionRequest, type EffectOutcome, type OutboxRow, type QueueItem, type RunRecord, type SessionRole, type Store } from '../store/types.js';
import { agentOutputKey, attemptOutcome, parseAgentOutput, type AgentOutput } from '../core/agent-output.js';
import { OutputPolicy } from '../publish/output-policy.js';
import type { EventBus } from '../server/live-feed.js';
import type { Clock } from '../core/clock.js';
import type { Effect } from '../core/decision.js';
import { deadLetteredEvent, repairedEvent } from '../core/dead-letter.js';
import type { HeldRow } from '../core/diagnosis.js';
import { NO_PLAN, planDecision } from '../core/decision-plan.js';
import { blockFacts } from '../core/block-comment.js';
import { HUMAN_EVENTS, isAnswerer, mayCheck, refusesDevWork, SENSITIVE_PATHS, sensitivePathsAtLaunch, staleRelaunch, stepOf, waitingBody, waitingOn } from '../core/engine.js';
import { codeRunTokens } from '../core/measures.js';
import { attemptLabels, packFingerprints } from '../core/attempt-labels.js';
import { formatReuse, ownWork, ticketBranches } from '../core/intake-checks.js';
import { branchName, namesTicket } from '../core/naming.js';
import { openBlockers, pickupFailures, searchDuplicates } from '../core/pickup.js';
import { buildPrompt, formatFeedback, formatVerifyFailures, readConventions, withHumanInbox, type PromptInput } from '../core/prompt.js';
import { knowledgePrompt, type KbIndex } from '../knowledge/kb.js';
import { searchAsked, searchCounted, type PreviewRecipes } from '../knowledge/preview-recipe.js';
import { formatLinked, formatRunState, formatTranscript } from '../core/answer-context.js';
import { transcriptTail } from '../adapters/runner/transcript.js';
import { carriedAtLaunch, forAgent } from '../core/human-message.js';
import { branchAnew, heldByOther, pendingOf, samePending } from '../core/reduce.js';
import { advancePlan, planStepOfJob } from '../core/session-plan.js';
import { startMove } from '../core/chain.js';
import { formatSpec } from '../core/spec.js';
import type { StoredEvent } from '../core/upcast.js';
import type { Scheduler } from './capacity.js';
import { CREATES_TICKET, type Blocker, type EventPayloads, type FeedbackItem, type InputKind, type InternalEvent, type IssueSnapshot, type LogicalState, type PendingJob, type QueueName, type RelayedQuestion, type FactoryEvent, type RunOutcome, type TicketState, type VerifyFailure, TRUSTED } from '../core/types.js';
import { runSealedSetup } from '../core/sealed-setup.js';
import type { RegistryOpener } from '../checks/registry.js';
import { servicesUnavailable, type CleanVerifier } from '../core/clean-verify.js';
import type { Verifier } from '../core/verify.js';
import { blockingFindings, contestedInput, findingsInput } from '../core/review.js';
import { PRODUCT_NAME } from '../product.js';
import type { VisualShooter } from '../adapters/browser/types.js';
import { agentPolicy, runTools, type EgressPolicy } from '../network/levels.js';
import { isTakenOver, REPO_CONFIG_REFUSED, TICKET_TOKENS_REACHED, type BlockKind } from '../core/block-cause.js';
import { DECLARED_READS, declaredReads, type DeclaredReads } from '../network/reads.js';
import { readSecurityLog, refusalSummary } from '../network/security-log.js';
import { type EffectKey, redBaseKey, type StateIo, takeOverKey } from './daemon-base.js';
import { DaemonEffects } from './effects.js';

/** The contested findings as the first lens of a round read them (ORC-184): its own end replaces its findings on the commit, which the ids name by rank. */
const contestedKey = (projectId: string, ticketId: string): string => `contested-input:${projectId}:${ticketId}`;

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
 * What a launch error tells the ticket (Linear): a failed command names the server's paths and its command line, which
 * stay in the daemon's log (ORC-364); the ticket gets the command's name, without its directory (a CLI configured by
 * its path), and its code.
 */

const launchErrorTold = (err: unknown): string =>
  err instanceof ExecFailure ? `${basename(err.cmd)} failed (code ${err.code}); the command and its output are in the daemon log.` : (err as Error).message;

/** An error's message, then each of its causes', as the daemon's log keeps them. */
const causeChain = (err: unknown): string => {
  const parts: string[] = [];
  for (let e: unknown = err; e instanceof Error && parts.length < 5; e = e.cause) parts.push(e.message);
  return parts.join(' ← ') || String(err);
};

/**
 * What a run's stagnation is watched against (ORC-136, ORC-187). Only a dev job has its worktree read for a loop: `decide`
 * blocks no ticket on a question, whose checkout stays out of it.
 */

function stagnationBounds(wf: Workflow, job: JobSpec): { stagnation: StagnationBounds & { silentMs: number } } {
  return { stagnation: { silentMs: wf.limits.silentAfterMs, ...(job.queue === 'dev' ? { repeats: wf.limits.repeatedFailures } : {}) } };
}

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

export interface StartOpts {
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

/** Where a launch is (`launchRun`): past its `run.started`, holding the ticket (ORC-359), and what keeps its hold. */
interface LaunchAt {
  started: boolean;
  renew?: ReturnType<typeof setInterval>;
}

/** A drain's hooks on a start it hands out of the queue (`startRun`). */
export interface StartFrom {
  admitted?: () => void;
  recorded?: () => Promise<void>;
}

/**
 * A launch that failed before its `run.started`, and nothing of the run is the ticket's yet: its read or write of the
 * factory's own state failed (ORC-339), or anything it called failed transiently (`isTransient`: GitHub, Linear or the
 * database down, ORC-343). The start is tried again (the effect's retry, the drain's bounded one) instead of blocking
 * the ticket. A launch's own failure (a worktree, a setup, the repository's config) still blocks it at once: retried,
 * it would fail again. `failure`: what failed, also its `cause`, which `isTransient` reads. Its message is what a launch
 * error tells the ticket (`launchErrorTold`): its retries spent, the effect's failure reaches it as such (ORC-364).
 */

class RetryableStart extends Error {
  constructor(readonly failure: unknown) {
    super(failure instanceof Error ? launchErrorTold(failure) : String(failure), { cause: failure });
  }
}

/**
 * Starts of a queue item that failed before their `run.started` (ORC-339): handed out again after 2 s, 4 s, 8 s, 16 s,
 * doubled up to 5 min; past 5 attempts, or 14 (about 33 min) when the failure is transient (ORC-343), the ticket is blocked.
 */

export const START_RETRY = { attempts: 5, transientWindowMs: TRANSIENT_WINDOW_MS, baseMs: 2_000, capMs: 300_000 } satisfies RetryPolicy;

/** A start behind another daemon's launch not started yet (ORC-359): that very start is that launch's, another goes back in line. */
const behindLaunch = (launch: NonNullable<TicketState['launching']>, start: PendingJob): 'deferred' | 'queued' => (samePending(launch.start, start) ? 'deferred' : 'queued');

/** What a start came to: queued, set pending behind a run that holds the ticket (`deferred`), or anything else. */
export type StartOutcome = 'queued' | 'deferred' | 'done';

/** The `meta` key of the installation's id (`instanceId`). */
const INSTANCE_KEY = 'instance-id';

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
  return isAnswerer(job) ? 'answerer' : undefined;
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

/**
 * `factory/preuve-visuelle` (ORC-176): the captures the factory took, or that there is none to take. A required proof the instance
 * could not take is neutral, indicative until the application starts reliably in the sandbox (ORC-152): it blocks nothing.
 */

/** A block made out of a decision, its step to resume as the engine's `block` journals it (ORC-196). */
const blockedOn = (kind: BlockKind, reason: string, job: string): InternalEvent => ({ type: 'ticket.blocked', reason, kind, job });

/** What the dashboard reaches of a take-over (ORC-234): absent without sandboxes, where there is none. */
export interface TakeOverDesk {
  /** The host command of a shell in the ticket's take-over container; undefined when none is open. */
  attach(projectId: string, ticketId: string): Promise<SpawnCommand | undefined>;
  /** A bundle handed back, kept where the factory reads it (`<runsDir>/bundle-<project>-<ticket>/`): its path. */
  keepBundle(projectId: string, ticketId: string, bytes: Uint8Array): Promise<string>;
}

export class Daemon extends DaemonEffects {
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
  private follow(runId: string, handle: RunHandle, token: number, silentMs: number): void {
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

  /**
   * Logged, never thrown: a sandbox left behind is recover()'s at the next start. The run's own
   * `~/.claude` goes with it (a dir left by a failed removal is purged with the run's dir, at 30 days).
   * Then the security log of the attempt `owner` ran there, if any (ORC-296): its journals are complete.
   */
  protected async destroySandbox(id: string, runId: string, owner?: RunRecord): Promise<void> {
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
        {
          ...(this.d.egressJournal ? { egress: this.d.egressJournal(runId) } : {}),
          refusals: join(this.d.runsDir!, runId, 'refusals', 'refusals.jsonl'),
          declared: join(this.d.runsDir!, runId, DECLARED_READS),
        },
      );
      if (!(await this.d.store.putSecurityLog(log))) return;
      const { egress, refusals } = log.skipped;
      if (egress + refusals) this.log('warn', `security log of ${runId}: ${egress} egress and ${refusals} refusal lines skipped (malformed or forged)`);
      const summary = refusalSummary(log);
      if (summary && owner.linearSessionId && !this.silenced(owner.projectId, `the security summary of ${runId}`)) await this.d.tracker.activity(owner.linearSessionId, { type: 'thought', body: summary });
    } catch (err) {
      this.log('error', `security log of ${runId} not recorded: ${(err as Error).message}`);
    }
  }

  /**
   * The reads the lockfiles declare at the ticket's base commit (ORC-396), read on the factory's repository, never in the
   * worktree, where an earlier attempt may have declared what it means to read (`baseReader`). A worktree whose base cannot
   * be read gets no declaration: none of its reads is judged unusual, and the daemon's log says why.
   */
  private async declaredAtBase(project: ProjectRuntime, ws: Workspace): Promise<DeclaredReads | undefined> {
    try {
      const show = await this.d.workspaces.baseReader(project.repoPath, ws.path);
      if (!show) throw new Error('no worktree with a commit');
      return await declaredReads(show);
    } catch (err) {
      this.log('warn', `the lockfiles of ${ws.path} at its base commit are not read: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * The attempt's sandbox (ORC-204): the worktree, its git dir inside (ORC-317), the ticket's
   * Claude session dir as `~/.claude` (`--resume` across attempts) when the attempt runs the ticket
   * session, else an empty per-run dir there, removed with the sandbox: a review or a question starts in
   * a fresh context that never sees the ticket's (ORC-217). The run's refusals dir, read-write, so the
   * hook's log outlives the sandbox. The pack and the run settings read-only.
   * A `trunk-readonly` job gets its worktree read-write too: only `--permission-mode plan` keeps it
   * from writing, as on the host, or for `intake` its tools, `Read`, `Grep` and `Glob` (ORC-367). The network is applied by the egress proxy (ORC-213): the repository's
   * level for the agent (`agentPolicy`, from the config read at the launch); `none` for a check (the red sandbox).
   * The repository's `services` (ORC-309), for the agent: those its setup filled, owned by this sandbox and gone with it.
   */
  protected async openSandbox(sandboxes: SandboxProvider, project: ProjectRuntime, ticketId: string, ws: Workspace, runId: string, ticketSession: boolean, policy: EgressPolicy, services: readonly string[] = []): Promise<Sandbox> {
    if (!this.d.sessionsDir || !this.d.runsDir) throw new Error('sessionsDir and runsDir are required with sandboxes');
    const runDir = join(this.d.runsDir, runId);
    const claudeDir = ticketSession ? join(this.d.sessionsDir, project.id, ticketId) : join(runDir, 'claude');
    const refusalsDir = join(runDir, 'refusals');
    for (const dir of [claudeDir, refusalsDir]) mkdirSync(dir, { recursive: true });
    // What the repository's lockfiles declare, out of its mounts: its security log judges its reads by it (ORC-370). Below
    // `limited`, the run reaches no registry nor forge.
    const declared = policy.level === 'limited' ? await this.declaredAtBase(project, ws) : undefined;
    if (declared) await writeFile(join(runDir, DECLARED_READS), JSON.stringify(declared));
    return sandboxes.create({
      runId,
      ticketId,
      workspacePath: ws.path,
      network: policy.level,
      ...(policy.allow.length ? { allow: policy.allow } : {}),
      requirements: { ...DEFAULT_REQUIREMENTS, services },
      // Its git dir is in its worktree, its own (ORC-317): the repository's, which git reads on the host, is never mounted.
      mounts: [
        { host: claudeDir, target: `${SANDBOX_HOME}/.claude`, readOnly: false },
        { host: refusalsDir, target: REFUSALS_TARGET, readOnly: false },
        { host: this.d.packDir, target: PACK_TARGET, readOnly: true },
        { host: this.settingsPath(), target: SETTINGS_TARGET, readOnly: true },
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
  private async runSetup(project: ProjectRuntime, ticketId: string, ws: Workspace, runId: string, vars: RepoVariables, commands: string[], services: readonly string[]): Promise<void> {
    const sandboxes = this.d.sandboxes;
    if (!sandboxes) {
      const res = await this.d.verify(ws.path, commands, undefined, vars.env);
      if (!res.ok) throw new Error(`The worktree setup failed: ${res.failures[0]!.command}`);
      return;
    }
    // On commits a previous agent wrote, or in a worktree an earlier attempt worked in (its services new, ORC-309), `setup`
    // runs code nobody reviewed: no secret for it. A setup that needs one fails.
    const unreviewed = ws.ahead || !ws.fresh;
    const declared = Object.keys(vars.setupSecrets).length > 0;
    if (unreviewed && declared) {
      this.log('warn', `setup of ${ticketId}: ${ws.ahead ? 'its branch has commits beyond the default branch' : "its worktree holds an earlier attempt's work"}, the repository's secrets are withheld`);
    }
    // Read before its container exists: a source that fails leaves nothing to destroy, and no silent fallback.
    const secrets = unreviewed || !declared ? {} : await this.readSetupSecrets(vars.setupSecrets);
    const { purged } = await runSealedSetup(sandboxes, {
      runId,
      ticketId,
      workspacePath: ws.path,
      mounts: [{ host: join(ws.path, '.git'), target: `${WORKSPACE_TARGET}/.git`, readOnly: true }],
      commands,
      env: vars.env,
      secrets,
      services,
      now: new Date(this.d.clock.now()),
    });
    if (purged.length) this.log('warn', `setup of ${ticketId}: secret found and purged in ${purged.join(', ')}`);
  }

  private async readSetupSecrets(refs: Readonly<Record<string, SecretRef>>): Promise<Record<string, string>> {
    if (!this.d.readSecrets) throw new Error('The worktree setup failed: no secret source is configured');
    return this.d.readSecrets(refs).catch((err: Error) => {
      throw new Error(`The worktree setup failed: ${err.message}`, { cause: err });
    });
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

  /** Paused by `set_paused`, or by a pause accepted whose `set_paused` has not run yet (`PAUSE_ACCEPTED`, ORC-335): its lane and a ticket's go side by side. */
  async isPaused(): Promise<boolean> {
    const flags = await Promise.all([this.d.store.getMeta('paused'), this.d.store.getMeta(PAUSE_ACCEPTED)]);
    return flags.includes('1');
  }

  /** The failed inbox rows of this process's worker that hold the ticket (ORC-350), for its diagnosis. */
  heldRows(ticketId: string): HeldRow[] {
    return this.worker.held(ticketId);
  }

  private account(): string {
    return this.d.claudeAccount?.() || 'default';
  }

  /**
   * Until when the usage limit of the active account holds every launch (`on_usage_limit: wait`, ORC-340); undefined when it holds none.
   * A launch before its reset would only hit it again; another account active is not held. The tick drains the queues once it passes.
   */
  async usageLimitedUntil(): Promise<number | undefined> {
    await this.readUsageHold(this.account());
    return this.heldUntil();
  }

  /** The account's hold as the store has it, kept as this daemon's: an operator who lowers it lifts the hold. */
  private async readUsageHold(account: string): Promise<number> {
    const until = Number((await this.d.store.getMeta(usageHoldKey(account))) ?? 0);
    this.usageHolds.set(account, until);
    return until;
  }

  /** `usageLimitedUntil` on what this daemon knows already, without reading the store. */
  private heldUntil(): number | undefined {
    const account = this.account();
    const until = Math.max(this.usageHolds.get(account) ?? 0, this.unrecordedHolds.get(account) ?? 0);
    return until > this.d.clock.now() ? until : undefined;
  }

  /** An invalid configuration holds every launch, as the pause does (ORC-350). */
  private configHeld(): boolean {
    return !!this.d.configProblems?.length;
  }

  /** The knowledge index for a session's system prompt (ORC-232), its cut logged: a read that fails launches without it, and says so. */
  private knowledgePromptOf(index: KbIndex | Error, ticketId: string, job: string): string | undefined {
    if (index instanceof Error) {
      this.log('warn', `${ticketId} ${job}: knowledge index not read, the session starts without it: ${index.message}`);
      return undefined;
    }
    if (index.warning) this.log('warn', `${ticketId} ${job}: ${index.warning}`);
    const prompt = knowledgePrompt(index);
    if (prompt && index.more) this.log('warn', `${ticketId} ${job}: INDEX.md over its cap, ${index.more} characters left out of the knowledge index the session reads (kb_search reaches the notes)`);
    return prompt;
  }
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
      decide: (known, version) => planDecision({ event, known, workflow: this.workflowOf(version, event.ticketId), hash: version.hash, now }),
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
    if (!t.activeRunId && !t.verifyingRunId && pending) {
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
  protected drain(queue: QueueName): Promise<void> {
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
    // Read once per drain: its starts, and a limit heard of meanwhile, are held on what this daemon knows (`heldUntil`).
    if (n > 0) await this.readUsageHold(this.account());
    for (let i = 0; i < n; i++) {
      if (this.configHeld() || (await this.isPaused()) || this.heldUntil() !== undefined || this.d.scheduler.free(queue) - this.admitting[queue] <= 0) return;
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

  /** What the lenses of a round read of the contested findings (ORC-184), resolved on the commit they were found on, kept for the round. */
  private async contestedText(projectId: string, ticketId: string, contested: NonNullable<TicketState['contested']>): Promise<string | undefined> {
    const { store } = this.d;
    const id = JSON.stringify(contested);
    const kept = await store.getMeta(contestedKey(projectId, ticketId));
    const was = kept ? (JSON.parse(kept) as { id: string; text: string }) : undefined;
    if (was?.id === id) return was.text || undefined;
    const text = contestedInput(await store.findingsOf(projectId, ticketId, contested.sha), contested.items);
    await store.setMeta(contestedKey(projectId, ticketId), JSON.stringify({ id, text: text ?? '' }));
    return text;
  }

  /**
   * The `review` effect (ORC-183): a lens's findings kept on the commit it read, in place of what that lens kept there before.
   * The publishing one then posts every lens's findings on that commit as one GitHub review, each on its line, or listed in its
   * text when GitHub cannot place one, and `factory/review`, failed on a blocking finding. Every text through the
   * `OutputPolicy`, a refused one replaced by its notice. Keyed: a replay finds its review by the effect's id, and the check by
   * the commit's. Any failure throws, and the outbox retries it: its move to Human Review waits behind it, and a dead one blocks the ticket.
   */
  protected async startRun(
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
    if (staleRelaunch(t, job, opts.input)) {
      this.log('info', `refused ${job.name} on ${ticketId}: a check passed since the failures it was to fix`);
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
    const busy = t.activeRunId || t.verifyingRunId;
    // Behind another daemon's launch alone, which may end with no run whose end starts what waits (ORC-359).
    const launch = this.heldByOther(t);
    if (job.queue === 'dev' && !busy && launch) return behindLaunch(launch, pendingOf({ ...opts, job: job.name })) === 'deferred' ? 'deferred' : requeue();
    if (job.queue === 'dev' && busy) {
      const start = pendingOf({ ...opts, job: job.name });
      // Handed out of the queue to a ticket that holds another pending job: it stays in line, never in that one's place (ORC-339).
      if (fromQueue && t.pendingJob && !samePending(t.pendingJob, start)) return requeue();
      await this.apply(t, { type: 'pending.set', job: start });
      return 'deferred';
    }
    // The account's usage limit holds every launch on it until its reset (ORC-340), a step it cut too (ORC-357): in line meanwhile.
    if (this.stopping || this.configHeld() || (await this.isPaused()) || (fromQueue ? this.heldUntil() : await this.usageLimitedUntil()) !== undefined) return requeue();
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
      err instanceof RepoConfigError ? ['repo_config', `${REPO_CONFIG_REFUSED}${err.message}`] : err instanceof TicketBudgetError ? ['budget', err.message] : ['infra', `Launch error: ${launchErrorTold(err)}`];
    // The whole of it in the daemon's log, what each error wraps included: the ticket may have been told less.
    if (kind === 'infra') this.log('error', `launch of ${job.name} on ${ticketId}: ${causeChain(err)}`);
    fresh = await this.apply(fresh, ...events, blockedOn(kind, reason, job.name));
    // The ticket is blocked: a failed notice must not fail the effect, whose retry would start again.
    try {
      await this.tellBlock(project, fresh, blockFacts({ reason, step: stepOf(project.workflow, job.name), tried: [`The launch of ${job.name}.`] }));
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
  protected async startHandled(mark: string): Promise<boolean> {
    const value = await this.d.store.getMeta(mark);
    if (value === undefined) return false;
    return value === '1' || (await this.d.store.getRun(value)) !== undefined;
  }

  /** Tokens the ticket's code runs spent (`budgets.per_ticket_tokens`, ORC-340), cache reads left out: its questions (`ask`) do not count. */
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
    const at: LaunchAt = { started: false };
    try {
      return await this.launchRun(project, ticketId, job, opts, slot, key, runId, at, recorded);
    } catch (err) {
      if (!at.started && !(err instanceof RetryableStart) && isTransient(err)) {
        // The whole of it in the daemon's log: the start's own message, which may reach the ticket, says less.
        this.log('warn', `launch of ${job.name} on ${ticketId}, to try again: ${causeChain(err)}`);
        throw new RetryableStart(err);
      }
      throw err;
    } finally {
      // Ended without taking the ticket: the next launch need not wait for the hold to run out (ORC-359), which it does if this write fails.
      if (at.renew) {
        clearInterval(at.renew);
        await this.ticket(project.id, ticketId)
          .then((t) => this.apply(t, { type: 'launch.released', runId }))
          .catch((err: Error) => {
            // Its own next launch takes it over at once; another daemon's waits for it to run out.
            this.droppedHolds.add(runId);
            this.log('warn', `${job.name} on ${ticketId}: the launch's hold on the ticket not let go of (${err.message}), taken over by this daemon's next launch`);
          });
      }
    }
  }

  /** Another dev launch's hold on the ticket (ORC-359), not over, unless it is a hold this daemon dropped (`droppedHolds`). */
  private heldByOther(t: TicketState, runId?: string): TicketState['launching'] {
    const held = heldByOther(t, this.d.clock.now(), runId);
    return held && !this.droppedHolds.has(held.runId) ? held : undefined;
  }

  /**
   * `at.started`: set once the launch writes its `run.started`; from there, the run may be the ticket's. `at.renew`: while the
   * launch holds the ticket (ORC-359), what keeps its hold.
   */
  private async launchRun(
    project: ProjectRuntime,
    ticketId: string,
    job: JobSpec,
    opts: StartOpts,
    slot: number,
    key: string,
    runId: string,
    at: LaunchAt,
    recorded?: () => Promise<void>,
  ): Promise<StartOutcome | undefined> {
    const { tracker, store, clock, workspaces, forge } = this.d;
    const wf = project.workflow;
    // What the launch starts, in the shape of a pending job: its `run.started` names it (ORC-339).
    const start = pendingOf({ ...opts, job: job.name });
    /** The factory's own state, read or written before the `run.started`: its failure is a start to try again. */
    const state: StateIo = (io) =>
      io.catch((err: unknown) => {
        throw new RetryableStart(err);
      });
    /** The ticket holds another dev run, or another launch holds it (another daemon's launch won the race). */
    const taken = (x: TicketState): boolean => job.queue === 'dev' && (!!x.activeRunId || !!this.heldByOther(x, runId));
    /**
     * Another launch took the ticket (ORC-339). Its run is this very start, all of it (a settle taken up by another
     * worker after a lost lease): nothing more to start. Another start: this one waits behind it, pending, as
     * `startRun` sets a start that meets a busy ticket, unless the ticket holds another pending job, which it never
     * replaces: then it goes back in line (`queued`). Behind another daemon's launch not started yet (ORC-359), as
     * `startRun` does: that very start stays where it is, its launch's; another goes back in line.
     */
    const lose = async (holder: TicketState): Promise<StartOutcome> => {
      this.d.scheduler.release(key);
      const launch = holder.activeRunId ? undefined : this.heldByOther(holder, runId);
      if (launch) {
        const behind = behindLaunch(launch, start);
        this.log('warn', `${job.name} on ${ticketId} not launched: the launch of ${launch.runId} took the ticket first${behind === 'queued' ? ': back in line' : ', for the same start'}`);
        return behind;
      }
      if (samePending(holder.activeStart, start)) {
        this.log('warn', `${job.name} on ${ticketId} not launched: run ${holder.activeRunId} of the same start took the ticket first`);
        return 'done';
      }
      if (holder.pendingJob && !samePending(holder.pendingJob, start)) {
        this.log('warn', `${job.name} on ${ticketId} not launched: run ${holder.activeRunId} took the ticket first, and another job waits behind it: back in line`);
        return 'queued';
      }
      this.log('warn', `${job.name} on ${ticketId} not launched: run ${holder.activeRunId} took the ticket first, it waits behind it`);
      if (!holder.pendingJob) await state(this.apply(holder, { type: 'pending.set', job: start }));
      return 'deferred';
    };
    const leaseMs = this.d.effectLeaseMs ?? LEASE_MS;
    const hold = (over?: string): InternalEvent => ({ type: 'launch.reserved', runId, start, at: clock.now(), until: clock.now() + leaseMs, ...(over ? { over } : {}) });

    // Before any workspace (ORC-340): factory.yml's cap now, the repository's, read from its config, once the worktree is there.
    // Read only under a cap: without one, a launch reads no run of the ticket.
    let spent = job.queue === 'dev' && this.d.perTicketTokens !== undefined ? await state(this.codeTokensSpent(project.id, ticketId)) : undefined;
    if (spent !== undefined) this.tokensLeft(spent, this.d.perTicketTokens);

    // Read while the workspace is prepared; a pack it cannot read gives null fingerprints (ORC-226).
    const pack = packFingerprints(this.d.packDir, (err) => this.log('warn', `attempt labels: pack not fingerprinted: ${err.message}`));
    // Likewise the knowledge index (ORC-232), its failure kept for the launch to say: a launch that stops early drops it.
    // A replayed ticket's (ORC-376): the knowledge base at its start, never the one of now, which may hold a note learned from its
    // own PR; none with `--memory off`.
    const replayed = project.replayed;
    const index = replayed ? replayed.knowledge !== undefined ? this.d.knowledgeIndex?.(replayed.knowledge) : undefined : this.d.knowledgeIndex?.();
    const knowledge = index?.catch((err: Error) => err);

    // Up to the workspace: a launch that lost does nothing.
    const head = await (async () => {
      let t = await state(this.ticket(project.id, ticketId));
      if (taken(t)) return { lost: t } as const;
      // A dev launch takes the ticket before any effect (ORC-359): of two daemons' launches, the second does nothing.
      if (job.queue === 'dev') {
        const dropped = t.launching && this.droppedHolds.has(t.launching.runId) ? t.launching.runId : undefined;
        t = await state(this.apply(t, hold(dropped)));
        if (dropped) this.droppedHolds.delete(dropped);
        if (t.launching?.runId !== runId) return { lost: t } as const;
        at.renew = setInterval(() => {
          this.apply(t, hold())
            .then((x) => x.launching?.runId === runId || this.log('warn', `${job.name} on ${ticketId}: the launch's hold on the ticket was taken over`))
            .catch((err: Error) => this.log('warn', `${job.name} on ${ticketId}: the launch's hold on the ticket not kept: ${err.message}`));
        }, Math.max(1, Math.floor(leaseMs / 3)));
        at.renew.unref();
      }
      const issue = project.replayed?.issue ?? (await tracker.getIssue(ticketId));
      // The deterministic checks, before the ticket's first run: at intake, inputs of its guard, journaled with its end
      // (ORC-206); else they block a job that picks up the ticket. The « blocked by » tickets not done likewise (ORC-363),
      // except that they make the job wait instead of blocking it.
      const intake = job.step === 'intake';
      const guarded = (intake || job.pickup) && !t.claudeSessionId;
      const checks = wf.tracker.pickup.checks;
      // The repository's branch naming (ORC-283), from its config on the default branch: a worktree's branch, and the
      // ticket's own branches on the forge. A worktree's launch reads it here once, fetching the forge for the launch,
      // which its `prepare` then does not do again; another launch reads the config again once its workspace is there.
      const worktree = job.workspace === 'worktree';
      const early = worktree || guarded ? await this.repoConfigOf(project, { fetch: worktree }) : undefined;
      // Fetched by that read only when a reader of the repository is wired: without one, `prepare` fetches as before.
      const fetched = worktree && !!this.d.repoConfig;
      const naming = early?.branches;
      // The duplicate search of intake (ORC-207), and the ticket's own branches for `not_started`, read together. Neither for a
      // replayed ticket (ORC-376): the forge and the tracker hold now the human's PR and branch, the very work it is compared with.
      const [search, ownBranches] = guarded && !project.replayed
        ? await Promise.all([
            intake ? searchDuplicates(issue, project.repoPath, { forge, tracker }, naming) : undefined,
            checks.includes('not_started') ? ticketBranches(forge, project.repoPath, issue.identifier, naming) : undefined,
          ])
        : [];
      const failures = guarded ? pickupFailures(checks, issue, ownBranches && ownWork(issue.identifier, ownBranches, search?.prs ?? [], naming)) : [];
      const blockers = guarded ? openBlockers(issue) : [];
      if (!intake && failures.length) {
        this.d.scheduler.release(key);
        const reason = failures.join(' ');
        const refused = await state(this.apply(t, blockedOn('pickup', reason, job.name)));
        // The ticket is blocked: a failed notice must not make the block a launch error, nor its retry find the ticket blocked.
        await this.tellBlock(project, refused, blockFacts({ reason, step: 'intake', tried: failures, question: 'Can you fix this, then reply here?' })).catch((err: Error) => this.log('warn', `could not post the refused pickup of ${ticketId}: ${err.message}`));
        return undefined;
      }
      if (!intake && blockers.length) {
        this.d.scheduler.release(key);
        const waiting = await state(this.apply(t, waitingOn(blockers, start)));
        this.log('info', `${job.name} on ${ticketId} waits for ${blockers.map((b) => b.identifier).join(', ')} to be done`);
        try {
          if (!this.silenced(project.id, `the wait of ${ticketId}`)) await tracker.activity(await this.sessionFor(waiting), { type: 'thought', body: waitingBody(blockers) });
        } catch (err) {
          this.log('warn', `could not tell ${ticketId}'s session that it waits: ${(err as Error).message}`);
        }
        return undefined;
      }
      // An AI review reads the commit the factory published, the one `verify` found green (ORC-183): never the agent's worktree.
      const reviewed = job.workspace === 'published' ? t.verifiedSha : undefined;
      // A worktree's branch: the one recorded on the ticket, so that a label or a naming changed since opens no second PR (ORC-283),
      // when it names the ticket: the agent's HEAD is recorded as it left it, detached or on a branch of its own.
      const recorded = t.branch && namesTicket(issue.identifier, t.branch) ? t.branch : undefined;
      const branch = worktree ? (recorded ?? branchName(issue.identifier, issue.title, issue.labels, naming)) : undefined;
      const asked = { projectId: project.id, repoPath: project.repoPath, ticketId, title: issue.title, kind: job.workspace, slot, portBase: wf.workspace.portBase, runId, ...(reviewed ? { sha: reviewed } : {}), ...(branch ? { branch, fetched } : {}) };
      let ws = await workspaces.prepare(asked);
      // Left by a daemon killed before the end of its setup (ORC-211): half installed, perhaps holding a secret the
      // configuration no longer names, so sealing it again proves nothing. It is made anew; no agent has worked in it.
      if (await state(store.getMeta(setupPendingKey(ws.path)))) {
        await workspaces.cleanup(project.id, ticketId);
        await state(store.setMeta(setupPendingKey(ws.path), ''));
        ws = await workspaces.prepare(asked);
      }
      return { issue, ws, lost: undefined, pickup: intake && failures.length ? failures : undefined, blockedBy: intake && blockers.length ? blockers : undefined, reviewed, activeWork: search?.activeWork, config: worktree ? early : undefined };
    })();
    if (!head) return undefined;
    if (head.lost) return lose(head.lost);
    const { issue, ws, pickup, blockedBy, reviewed, activeWork } = head;
    // Read again before the first write: the workspace took time.
    let t: TicketState;
    // A fresh worktree is not set up until its setup succeeds: a launch ending before removes it, or
    // the next prepare would find it there (not fresh) and setup would never run.
    let setUp = !ws.fresh;
    let sandbox: Sandbox | undefined;
    // Until pump has it, the sandbox is the launch's: whatever ends the launch before destroys it.
    let handedOver = false;
    try {
      // Read once, on the default branch (ORC-209 C): an invalid file refuses the launch. A worktree's launch read it before
      // its `prepare`, for the branch's name (ORC-283); a question's or a review's trunk has just been fetched.
      const config = head.config ?? (await this.repoConfigOf(project, { fetch: false }));
      // Provided, or no run starts (ORC-282): never a setup nor an agent in an environment poorer than the repository declares.
      const declared = [...new Set(config.services)];
      const unprovided = this.d.sandboxes ? this.d.sandboxes.unprovided(declared) : declared;
      if (unprovided.length) throw new Error(servicesUnavailable(unprovided, !!this.d.sandboxes));
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
      // The ticket's own worktree only: a review's clone is the run's, gone with it. Made anew on the default branch, its
      // branch holds nothing of the old one's: the old mark and human pushes end (ORC-358).
      const newBranch = ws.fresh && !ws.ahead && branchAnew(t) !== t;
      if (job.queue === 'dev' && job.workspace === 'worktree') t = await state(this.apply(t, { type: 'workspace.prepared', path: ws.path, port: ws.port, branch: ws.branch, ...(newBranch ? { newBranch } : {}) }));
      const moves = startMove(wf, job);
      if (moves && t.logical !== moves) await this.move(project, t, moves, undefined, state);
      t = await state(this.ticket(project.id, ticketId));

      // A relaunch reads what the lost attempt read, whatever came in since stays for the next run (ORC-220).
      const from = opts.relaunchOf ? await state(store.getRun(opts.relaunchOf)) : undefined;
      // A question asked again (a usage reset, ORC-340) answers in the thread it was asked in.
      const linearSessionId = opts.linearSessionId ?? (job.queue === 'questions' ? from?.linearSessionId : undefined) ?? (await this.sessionFor(t, state));
      t = await state(this.ticket(project.id, ticketId));
      // The feedback the run reads, taken at the launch whoever started it (a decision, settle, the queue):
      // its taint completes the one the start was decided with (I12, ORC-274).
      // An AI review reads the diff alone, whatever relaunched it (ORC-183): a reply that lifted its block waits for the implementer.
      // An AI review reads the published commit's diff alone, whatever relaunched it (ORC-183): a reply that lifted its block waits for the implementer.
      const kind = from ? undefined : job.lens ? 'diff' : (opts.input ?? job.input);
      // The implementer's run (a `dev` from scratch or a resume) runs the ticket session: resumed when the
      // ticket has one, else made here and taken by the ticket. A review or a question never does (ORC-217).
      // A relaunch runs the session the lost attempt ran. Cut before Claude wrote it, that session does not
      // exist yet: it starts under the id the ticket already holds (ORC-128).
      const ticketSession = job.queue === 'dev' && (from?.sessionRole ? from.sessionRole === 'implementer' : (opts.resume ?? (job.session === 'resume' || job.pickup)));
      // Its step boundary (ORC-180): the agent that implements starts a step, it reads what came in since its last one.
      const stepInbox = !from && kind !== 'feedback' && ticketSession ? carriedAtLaunch(t.humanInbox) : [];
      // Review comments are external content: whoever can comment on the PR wrote them, and nothing
      // authenticates them as the team's (ORC-160). Untrusted, whatever the forge says. The fix of the review loop reads
      // them too, as they are, with the review's findings (ORC-184).
      const threadsOf = kind === 'feedback' || kind === 'findings' ? t.prNumber : undefined;
      // An inline comment of a review is read in its thread, unresolved still, not as the inbox kept it (ORC-190): emptied all the same.
      const carried = threadsOf ? stepInbox.filter((i) => !i.thread) : stepInbox;
      const read: FeedbackItem[] = [...carried];
      if (kind === 'feedback') read.push(...forAgent(t.humanInbox).filter((i) => !threadsOf || !i.thread));
      const threads: FeedbackItem[] = threadsOf ? (await forge.unresolvedReviewComments(project.repoPath, threadsOf)).map((c) => ({ ...c, taint: 'untrusted' as const })) : [];
      read.push(...threads);
      const held = ticketSession && !t.newSession ? t.claudeSessionId : undefined;
      const resume = !!held && (!opts.relaunchOf || !this.d.sessionsDir || sessionSaved(join(this.d.sessionsDir, project.id, ticketId), held));
      // The questions relayed to the agent that implements (ORC-182): any launch of its session takes them all, whatever run they
      // were handed to before is over. Their taint, the one each question came in with, is part of what the launch reads.
      const relayed = ticketSession && t.relayed?.length ? await state(this.relayedQuestions(t.relayed)) : [];
      // A launch that empties the inbox takes the taint of all it empties, what the agent is not given included (`runTaint`).
      const consumes = kind === 'feedback' || stepInbox.length > 0;
      const fedUntrusted = sensitivePathsAtLaunch(opts.sensitivePaths ?? from?.sensitivePaths, consumes ? [...read, ...t.humanInbox] : read) ?? (relayed.some((q) => q.untrusted) ? SENSITIVE_PATHS : undefined);
      // What the run reads beyond its input takes the mark of who wrote it, not of who started the run (ORC-349): a resumed
      // session, what its earlier attempts read, which the branch's mark keeps (ORC-338). The mark read here serves below.
      const seen = !fedUntrusted && resume ? await state(this.readUntrusted(project, t)) : t;
      const marked = typeof seen.untrustedSince === 'string';
      const sensitivePaths = fedUntrusted ?? (resume && marked ? SENSITIVE_PATHS : undefined);

      const claudeSessionId = held ?? this.newId();
      const sessionRole = roleOf(job, ticketSession);
      // The answer agent reads the run beside the question (ORC-182).
      const runContext = sessionRole === 'answerer' ? await this.answerContext(project, t, issue.blockedBy) : undefined;

      const vars = await this.repoVariablesOf(project, config);
      // A set-up worktree's setup runs again for each attempt's new services (ORC-309), without the secrets (the worktree
      // is an agent's), unmarked: the worktree stays if it fails.
      if (!setUp || (this.d.sandboxes && config.services.length && setup.length)) {
        if (!setUp) await state(store.setMeta(setupPendingKey(ws.path), '1'));
        await this.runSetup(project, ticketId, ws, runId, vars, setup, config.services);
        if (!setUp) await state(store.setMeta(setupPendingKey(ws.path), ''));
      }
      setUp = true;
      // Opened after the cheap exits above and after the setup, whose container is gone by now (ORC-211).
      sandbox = this.d.sandboxes && (await this.openSandbox(this.d.sandboxes, project, ticketId, ws, runId, ticketSession, agentPolicy(config, job.network), config.services));
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
      } else if (kind === 'diff') {
        // The findings the fix contested stay open (ORC-184): the lens judges them again on this commit. Resolved once per contest,
        // so that the second lens reads what the first did, even when the first replaced its findings on the same commit.
        const open = t.contested && (await state(this.contestedText(project.id, ticketId, t.contested)));
        input = { kind, text: open ? `${ws.diff ?? ''}\n\n## Contested findings\n${open}` : (ws.diff ?? '') };
      } else if (kind === 'findings') {
        // The fix of the review loop (ORC-184): the review's blocking findings, then the PR's unresolved threads as they are.
        const sha = t.reviewBlocking?.sha ?? t.verifiedSha ?? '';
        const findings = findingsInput(sha, blockingFindings(sha ? await state(store.findingsOf(project.id, ticketId, sha)) : []));
        input = { kind, text: threads.length ? `${findings}\n\n## Unresolved review threads\n${formatFeedback(threads)}` : findings };
      } else if (kind === 'feedback') {
        input = { kind, text: read.length ? formatFeedback(read) : '(no written feedback: read the PR and the Linear thread again)' };
      } else if (kind === 'verify_failures') {
        input = { kind, text: formatVerifyFailures(JSON.parse(opts.inputText ?? '[]') as VerifyFailure[]) };
      } else if (kind === 'ci_failures') {
        input = { kind, text: opts.inputText ?? 'The PR\'s CI is failing. Run `gh pr checks` for the details.' };
      } else if (kind === 'thread' || kind === 'spec_check') {
        input = { kind, text: opts.inputText ?? '' };
      }
      if (carried.length) input = withHumanInbox(input, carried);

      // The approved spec for the steps after its gate, the version not approved for the step that rewrites it (ORC-212).
      const specShown = !!t.spec && job.queue === 'dev' && (job.step === 'spec_draft' ? !t.spec.approval : !!t.spec.approval);
      // Nothing declares how to start the application, nothing learned it (ORC-386): the build agent finds it.
      const recipe = job.step === 'build' ? await this.recipeOf(project, t) : undefined;
      // Read with the config, on the default branch (ORC-406), and kept on the run: its check counts a failed search against it.
      // Only where a search could be asked, with no recipe in the way: never on a dormant instance, a declared start, a learned recipe.
      const counted = !!recipe && searchCounted(this.searchContext(project, job, config, undefined), recipe.note);
      const startFingerprint = counted ? await this.d.startFingerprint?.(project) : undefined;
      const previewSearch = !!recipe && searchAsked(this.searchContext(project, job, config, startFingerprint), recipe.note);
      const promptInput = {
        skill: job.skill,
        issue: { identifier: issue.identifier, title: issue.title, description: issue.description, url: issue.url },
        ...(project.replayed?.history ? { history: project.replayed.history } : {}),
        branch: job.queue === 'dev' ? t.branch : undefined,
        prUrl: t.prUrl,
        spec: specShown && t.spec ? { version: t.spec.version, approved: !!t.spec.approval, text: formatSpec(t.spec.spec) } : undefined,
        // What `clarify`'s answers decided (ORC-210), for the steps after the guard: intake reads them as its feedback.
        decisions: job.queue === 'dev' && job.step !== 'intake' && t.decisions?.length ? t.decisions : undefined,
        conventions,
        input,
        activeWork,
        // intake's leads to existing code (ORC-207), for the dev work that follows it.
        reuse: job.queue === 'dev' && job.step !== 'intake' && t.reuse?.length ? formatReuse(t.reuse) : undefined,
        ...(job.lens ? { lens: job.lens } : {}),
        ...(reviewed ? { commit: reviewed } : {}),
        resumedAfterCut: !!opts.relaunchOf && resume,
        ...(runContext ? { run: runContext } : {}),
        ...(relayed.length ? { relayed } : {}),
        ...(previewSearch ? { previewSearch: true } : {}),
      };
      const prompt = buildPrompt(promptInput);
      const systemPrompt = knowledge && this.knowledgePromptOf(await knowledge, ticketId, job.name);
      const labels = attemptLabels({ job, prompt, promptInput, workflow: wf, pack: await pack, factoryCommit: this.d.factoryCommit, risk: t.risk ?? null, ...(systemPrompt ? { knowledgeIndex: systemPrompt } : {}) });
      // What the relay job's end compares its head with, to tell an answer from a commit (ORC-375).
      const startHead = job.name === wf.relayJob ? await workspaces.head(ws.path).catch(() => undefined) : undefined;

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
        account: this.account(),
        sensitivePaths,
        ...(input ? { input } : {}),
        repoConfig: config,
        ...(limits !== job.limits ? { limits } : {}),
        ...(pickup ? { pickup } : {}),
        ...(blockedBy ? { blockedBy } : {}),
        ...(startHead ? { startHead } : {}),
        ...(startFingerprint ? { startFingerprint } : {}),
        ...(recipe ? { previewSearch } : {}),
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
      // Its hold written again in the same write (ORC-359): one run out never refuses it, another launch's live one does.
      const took = await this.apply(t, ...(job.queue === 'dev' ? [hold()] : []), {
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
      // Its run.started ended its hold.
      clearInterval(at.renew);
      at.renew = undefined;
      await store.putRun(run);
      // Only what this launch read: a message that came in since stays for the next run (ORC-339).
      if (consumes) await this.apply(await this.ticket(project.id, ticketId), { type: 'feedback.consumed', items: t.humanInbox });
      // Handed to this run: its end answers them (`decide`), a question relayed since waits for the next launch.
      if (relayed.length) await this.apply(await this.ticket(project.id, ticketId), { type: 'relay.handed', runIds: relayed.map((q) => q.id), to: runId });
      const step = planStepOfJob(job, wf);
      if (step) await this.updatePlan(t, (plan) => advancePlan(plan, step));
      // The run is written: a queued item it came from leaves the queue now (a crash from here on is recover()'s).
      // Logged, not thrown: the run is launched either way, and a queue item left behind is refused
      // when handed out again (its ticket has a run, or is blocked, or its mark names this run).
      await recorded?.().catch((err: Error) => this.log('warn', `queued ${job.name} on ${ticketId} not taken out of the queue: ${err.message}`));
      // Its lease starts here: until now the launch is alive by itself. A failure leaves it to the next beat.
      await store.renewRun(runId, clock.now() + RUN_LEASE_MS, run.leaseToken).catch((err: Error) => this.log('warn', `lease of run ${runId} not written: ${err.message}`));
      const bounds = stagnationBounds(wf, job);
      // The repository's list only restricts them (ORC-383).
      const tools = runTools(job.tools, config, job.step, job.network);
      const handle = this.d.runner.start({
        runId,
        cwd: sandbox ? WORKSPACE_TARGET : ws.path,
        prompt,
        ...(systemPrompt ? { systemPrompt } : {}),
        claudeSessionId,
        resume,
        model: job.model,
        ...(job.effort ? { effort: job.effort } : {}),
        ...bounds,
        pluginDir: sandbox ? PACK_TARGET : this.d.packDir,
        settingsPath: sandbox ? SETTINGS_TARGET : this.settingsPath(),
        // Plan mode, for a question that has every tool. A job held to its tools needs none, and plan mode could refuse its `submit_result`.
        readOnly: job.workspace === 'trunk-readonly' && !tools,
        // A read-only step reads and searches, nothing else: no write tool, no shell (ORC-183, ORC-367).
        ...(tools ? { tools } : {}),
        limits,
        env: {
          // First: a variable of the repository never replaces one of the factory. Never its secrets (ORC-211).
          ...vars.env,
          ...this.d.agentEnv(run),
          // In a sandbox, the run's refusals log, on the host: it outlives the sandbox (ORC-217).
          ...(sandbox ? { FACTORY_REFUSALS_LOG: `${REFUSALS_TARGET}/refusals.jsonl` } : {}),
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
      this.follow(runId, handle, run.leaseToken!, bounds.stagnation.silentMs);
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

  /** Each relayed question as the answer agent's run recorded it (ORC-182): its input is the question, its mark the question's. */
  private async relayedQuestions(relayed: readonly RelayedQuestion[]): Promise<{ id: string; question: string; untrusted: boolean }[]> {
    const runs = await Promise.all(relayed.map((r) => this.d.store.getRun(r.runId)));
    return relayed.map((r, i) => ({ id: r.runId, question: runs[i]?.input?.text ?? '(the question is no longer recorded)', untrusted: !!runs[i]?.sensitivePaths }));
  }

  /**
   * What the answer agent reads beside the question (ORC-182): the run's state, the ticket's last diff, the end of the transcript
   * of the implementer's last session (the one at work, if it is), the linked tickets. A read that fails is said or left out:
   * the answer starts all the same.
   */
  private async answerContext(project: ProjectRuntime, t: TicketState, blockers: readonly Blocker[] | undefined): Promise<NonNullable<PromptInput['run']>> {
    const quiet = <T>(what: string, io: Promise<T>): Promise<T | undefined> =>
      io.catch((err: Error) => {
        this.log('warn', `answer of ${t.ticketId}: ${what} not read: ${err.message}`);
        return undefined;
      });
    const dir = this.d.transcriptsDir;
    // Ordered by their start: the last implementer's is the session at work, or the one that worked last.
    const lastTranscript = async (from: string) => {
      const run = (await this.d.store.ticketRuns(project.id, t.ticketId)).findLast((r) => r.sessionRole === 'implementer');
      return run && transcriptTail(from, run.id);
    };
    const [lines, diff] = await Promise.all([
      dir ? quiet('the transcript', lastTranscript(dir)) : undefined,
      t.worktreePath ? quiet('the diff', this.d.workspaces.ticketDiff(project.repoPath, t.worktreePath)).then((d) => d ?? '(the diff could not be read)') : undefined,
    ]);
    const transcript = lines && formatTranscript(lines);
    const linked = formatLinked(blockers);
    return { state: formatRunState(t), ...(diff ? { diff } : {}), ...(transcript ? { transcript } : {}), ...(linked ? { linked } : {}) };
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
      const session = run.linearSessionId && !this.silenced(run.projectId, `the activities of run ${run.id}`) ? run.linearSessionId : undefined;
      const relay = new ActivityRelay(
        (a) => (session ? this.relayTracker.activity(session, a) : Promise.resolve()),
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
        const activity = composedActivity(ev, step);
        if (activity) {
          bus.publish({ kind: 'activity', projectId: run.projectId, runId: run.id, ticketId: run.ticketId, activity, at: clock.now() });
          relay.pushActivity(activity);
        }
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
    // A reset already past, or none told: never sooner than `USAGE_MIN_WAIT_MS` after the run's end, an hour when none was told.
    // From its end, not from now (ORC-357): a result recover() sends after a long stop holds nothing once its reset is past.
    const now = this.d.clock.now();
    const end = run.endedAt ?? now;
    const account = run.account ?? this.account();
    const usageLimit =
      result.usageLimit && this.d.onUsageLimit === 'wait' ? { resetAt: Math.max(result.usageLimit.resetAt ?? end + USAGE_RETRY_MS, end + USAGE_MIN_WAIT_MS), account } : undefined;
    if (usageLimit && usageLimit.resetAt > now) {
      const until = new Date(usageLimit.resetAt).toISOString();
      this.log('warn', `usage limit of the Claude account ${account} reached (run ${run.id}): launches held until ${until}`);
      // The account's limit: every launch on it waits for its reset, the latest one heard of. A store that fails to record it must not
      // hold back the result, and this daemon still holds its launches (`unrecordedHolds`). Only a restart before the reset loses it
      // then: the next launch meets the limit again, and waits as this one did.
      try {
        const held = Math.max(await this.readUsageHold(account), usageLimit.resetAt);
        await this.d.store.setMeta(usageHoldKey(account), String(held));
        this.usageHolds.set(account, held);
      } catch (err) {
        this.unrecordedHolds.set(account, Math.max(this.unrecordedHolds.get(account) ?? 0, usageLimit.resetAt));
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
        ...(await this.answerCommitted(run)),
      },
    };
  }

  /**
   * The relay job's attempt moved the head of its worktree since its launch (ORC-375): the engine sends that commit the
   * reply rule's way. Nothing for an attempt launched without a head (any other job), nor for a head it cannot read.
   */
  private async answerCommitted(run: RunRecord): Promise<{ committed?: true }> {
    if (run.startHead === undefined) return {};
    const head = await this.d.workspaces.head(run.cwd).catch(() => undefined);
    return head && head !== run.startHead ? { committed: true } : {};
  }
}
