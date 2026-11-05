import type { AgentOutput, AttemptOutcome } from './agent-output.js';
import type { Role } from './authz.js';
import type { StoredEvent } from './upcast.js';
import type { FrozenTests } from '../checks/freeze.js';
import type { RedCause } from '../checks/red.js';

export const LOGICAL_STATES = ['todo', 'dev', 'human_review', 'ai_review', 'ready', 'done'] as const;
export type LogicalState = (typeof LOGICAL_STATES)[number];
export function isLogicalState(v: string): v is LogicalState {
  return (LOGICAL_STATES as readonly string[]).includes(v);
}

export type RunOutcome = 'success' | 'failure' | 'stopped' | 'limit';

/**
 * Tokens of a run as `claude -p` reports them in its `result` line (`usage`), never as the agent
 * writes them (ORC-235). `cacheRead` and `cacheCreation` are input tokens read from or written to
 * the prompt cache, apart from `input`.
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export const NO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheCreation: a.cacheCreation + b.cacheCreation };
}

export type InputKind = 'feedback' | 'ci_failures' | 'thread' | 'verify_failures';
export type QueueName = 'dev' | 'questions';

export interface FeedbackItem {
  /** The author's name, for the prompt. */
  author: string;
  /** Signed actor of the event that brought the item (ORC-186); absent on items from the forge or written before. */
  authorId?: string;
  body: string;
  at: number;
  source: 'session' | 'review' | 'label' | 'verify' | 'ci';
  /**
   * Taint of the event that brought the item; a run that consumes the pending feedback is as untrusted
   * as its least trusted item (I12). Absent on items written before ORC-269, when no source marked an
   * event untrusted (ORC-160): `decide` reads them as trusted, as `upcast` reads a version 1 event.
   */
  taint?: Taint;
}

export interface VerifyFailure {
  command: string;
  exitCode: number | null;
  output: string;
}

export interface PrPayload {
  number: number;
  url: string;
  branch: string;
}

/** A commit of a push on the default branch, and what it is to the ticket's PRs (ORC-278). */
export interface PushedCommit {
  sha: string;
  message: string;
  author: string;
  /** Number of the ticket's PR this commit lands on the default branch (its merge or squash commit), when known. */
  merges?: number;
  /** Number of the ticket's merged PR this commit reverts, read from its message (`This reverts commit <sha>`, `Reverts owner/repo#N`). */
  reverts?: number;
}

/**
 * One attempt of a workflow run (ORC-278). `durationMs` is `completedAt - startedAt`: the run's
 * `run_started_at` (the start of this attempt) to its `updated_at` on the `completed` webhook.
 */
export interface CiRunPayload {
  /** The PR the run is for: the one GitHub lists on the run for the branch, else the ticket's PR when the run came in. */
  number?: number;
  branch: string;
  headSha: string;
  runId: number;
  attempt: number;
  workflow: string;
  conclusion: string | null;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

/** What the factory needs to start tracking a ticket, read from the tracker when the event comes in. */
export interface IssueSnapshot {
  title: string;
  logical: LogicalState;
  priority: number;
}

/** The result of an outbox effect, back through the inbox as `effect:<id>` (ORC-150). */
export interface EffectResultPayload {
  /** Outbox id of the effect, `ticket:seq:i`. */
  effectId: string;
  kind: string;
  /** The event whose decision wrote the effect. */
  eventId: string;
  attempts: number;
  /**
   * Set when this execution found the effect already made by an earlier one (a replay, ORC-162):
   * nothing was written again, and `ref` names what was found (ORC-138, option B3).
   */
  deduplicated?: true;
  /** The external object the effect made or found (a comment id, a PR number…), when the adapter tells it. */
  ref?: string;
}

/**
 * What each kind of timer carries (ORC-161). `decide` arms a timer (`Decision.timers`), the decision
 * transaction writes it to `timers`, and its firing comes back through the inbox as `timer.fired`.
 *
 * - `debounce`: a rule with `debounce` regroups the messages that come in before it fires, then starts `job`.
 * - `clarify.remind` / `clarify.expire`: the reminder of a `clarify` question at 24 h, then the block at
 *   72 h, in the question's session; the rules that arm and decide them are ORC-210's.
 * - `usage.reset`: the reset of a subscription's usage limit, after which the waiting runs resume; the
 *   rule is ORC-215's.
 */
export interface TimerPayloads {
  debounce: { job: string };
  'clarify.remind': { linearSessionId?: string };
  'clarify.expire': { linearSessionId?: string };
  'usage.reset': { account?: string };
  /** The project's reconciliation (ORC-185), every 5 minutes, on its own pseudo-ticket (`reconcileTicket(project)`). */
  reconcile: Record<string, never>;
}

export type TimerKind = keyof TimerPayloads;

/** A timer's kind and what it carries: what `timer.fired` brings back to `decide`. */
export type TimerFired = { [K in TimerKind]: { kind: K; payload: TimerPayloads[K] } }[TimerKind];

export interface EventPayloads {
  'ticket.delegated': { linearSessionId?: string; promptContext?: string; issue?: IssueSnapshot };
  'ticket.undelegated': Record<string, never>;
  'session.mentioned': { linearSessionId: string; body: string; author: string; issue?: IssueSnapshot };
  'session.prompted': { linearSessionId: string; body: string; author: string; issue?: IssueSnapshot };
  'session.stopped': { linearSessionId?: string };
  /** `cancelled`: the new status is of type canceled in Linear (ORC-170). */
  'status.changed': { from: LogicalState | null; to: LogicalState | null; cancelled?: true };
  'label.changed': { label: string; change: 'added' | 'removed' };
  /** A commit pushed by a human on the ticket's branch. */
  'push.human': { branch: string; sha: string; author: string };
  /** `frozen`: for a `/refreeze`, the freeze at the branch's head, read before the decision (ORC-131); absent without a freeze or a branch. */
  command: { name: string; body: string; linearSessionId: string; author: string; issue?: IssueSnapshot; frozen?: FrozenTests };
  'pr.opened': PrPayload;
  'pr.checks_passed': PrPayload;
  'pr.checks_failed': PrPayload & { failures: string[] };
  /**
   * `mergeSha` (the commit the merge put on the base branch) and `headSha` (the PR's head when merged),
   * when the source reads them (ORC-278): a revert on the default branch names one of them. `mergedAt`:
   * when GitHub merged it, on GitHub's clock, as the push of a revert is. Optional: no version bump,
   * older rows and a forge that does not read them lack them.
   */
  'pr.merged': PrPayload & { mergeSha?: string; headSha?: string; mergedAt?: number };
  /** The PR is closed without merge: the ticket's dev work is cancelled (ORC-134). */
  'pr.closed': PrPayload;
  /**
   * A human review on the PR, or a comment on its diff, from the GitHub webhook (ORC-134). Untrusted:
   * its body is written by whoever can review. No reaction yet: `decide` traces it (ORC-190).
   */
  'pr.reviewed': PrPayload & { kind: 'review' | 'comment'; author: string; body: string; state?: string };
  /** The PR conflicts with its base branch, seen by the GitHub webhook (ORC-134). No reaction yet: `decide` traces it (ORC-146). */
  'pr.conflicted': PrPayload & { headSha: string; baseRef: string };
  /**
   * The factory's merge refused (ORC-148): a push since the review, a PR not mergeable. `reason` is for the human;
   * `headMoved`: refused for a push since the review, whose new commits go through the AI review again.
   */
  'pr.merge_refused': PrPayload & { reason: string; headMoved?: boolean };
  /**
   * A push on the project's default branch that concerns the ticket (ORC-278): only its commits that merge
   * the ticket's PR (`merges`) or revert it (`reverts`), by number. Untrusted: messages are written by
   * whoever commits. No reaction: the measures read it (`revertedWithin14Days`).
   */
  'default_branch.pushed': { branch: string; before: string; after: string; pushedAt?: number; commits: PushedCommit[] };
  /**
   * A completed attempt of a GitHub Actions workflow run on the ticket's branch (ORC-278), one per run id
   * and attempt. Untrusted: the workflow is a file of the branch. No reaction: the measures sum it (`ciCost`).
   */
  'ci.run_completed': CiRunPayload;
  /**
   * `attempt`: the closed outcome of the attempt (ORC-289), from `outcome`, the runner's own failure and
   * what `submit_result` recorded (`output`, when valid). Optional: no version bump, rows written before
   * it lack both and decide on `outcome` as before.
   */
  'run.finished': { runId: string; job: string; outcome: RunOutcome; costUsd: number; turns: number; lastText: string; attempt?: AttemptOutcome; output?: AgentOutput };
  /**
   * `red`: the cause of the `red` check's verdict (ORC-123), for a job checked by it instead of `verify`. `frozen`: the
   * freeze read with it (ORC-131), on both verdicts, recorded once the run goes on to the build. `sha`: the commit it
   * found green (ORC-151), the only one a merge may then carry; absent on the `red` check and on older rows.
   */
  'verify.passed': { runId: string; job: string; output?: AgentOutput; red?: RedCause; frozen?: FrozenTests; sha?: string };
  /** `tree`: fingerprint of the content checked when the check failed: the commit's tree in a clean check, absent outside git (ORC-187). */
  'verify.failed': { runId: string; job: string; failures: VerifyFailure[]; tree?: string; red?: RedCause; frozen?: FrozenTests };
  /**
   * An attempt gone without a result (ORC-220): `restart`, cut by a restart of the factory, and no
   * container left to reattach to; `lease`, its lease expired under a living factory. `decide` starts
   * the step again; only `lease` counts against the bound of one relaunch, a restart being no fault of the attempt.
   */
  'run.lost': { runId: string; job: string; cause: 'restart' | 'lease' };
  /** The check of an attempt cut by a restart of the factory (ORC-220): run again, its verdict keeps its id `check:<run>`. */
  'verify.lost': { runId: string; job: string; output?: AgentOutput };
  /**
   * The check could not run (ORC-151): engine down, a sandbox that never started or stopped answering, a bundle
   * refused. No verdict on the agent's work: the ticket is blocked, the agent never resumed for it.
   */
  'verify.errored': { runId: string; job: string; error: string };
  /** A timer armed by a decision, fired through the inbox with id `timer:<key>:<fireAt>` (ORC-161). */
  'timer.fired': TimerFired;
  'control.pause': Record<string, never>;
  'control.resume': Record<string, never>;
  'control.stop': Record<string, never>;
  /** An outbox effect carried out (ORC-150). */
  'effect.done': EffectResultPayload;
  /** An outbox effect that failed on its last attempt (ORC-150): the ticket is blocked. */
  'effect.failed': EffectResultPayload & { error: string };
  /** An event whose decision threw, set aside in `dead_letter` (ORC-175): the ticket is blocked. */
  'dead_letter.added': { eventId: string; eventType: string; error: string; failures: number };
  /**
   * A dead-lettered event repaired by `factory run repair` (ORC-175): `replay` decides `event` again,
   * `force` records its facts without its decision, `skip` drops it. Its block is lifted. `event` is
   * the event as the inbox held it, upcast when applied (`repairedEvent`).
   */
  'dead_letter.repaired': { eventId: string; action: 'replay' | 'skip' | 'force'; by: string; event: StoredEvent };
}

export type EventType = keyof EventPayloads;

/** Events that start tracking a ticket the factory does not track yet; their payload carries its `issue` snapshot. */
export const CREATES_TICKET: ReadonlySet<EventType> = new Set<EventType>(['ticket.delegated', 'session.mentioned', 'command', 'session.prompted']);

/** Event names of schema version 1, renamed in version 2. */
export const RENAMED_V1: Readonly<Record<string, EventType>> = { 'ticket.moved': 'status.changed', 'label.added': 'label.changed' };

/**
 * Version of the event shape; `upcast` brings older journal rows up to it. Version 3 (ORC-161):
 * `debounce.fired { job }` became `timer.fired { kind: 'debounce', payload: { job } }`.
 */
export const SCHEMA_VERSION = 3;

/** `untrusted`: the event carries content from a source the factory does not trust. */
export type Taint = 'trusted' | 'untrusted';

/** Version and taint of an event produced by the factory itself or a source it trusts. */
export const TRUSTED = { schemaVersion: SCHEMA_VERSION, taint: 'trusted' } as const;

export type FactoryEvent<T extends EventType = EventType> = {
  [K in T]: {
    id: string;
    type: K;
    at: number;
    projectId: string;
    ticketId?: string;
    schemaVersion: typeof SCHEMA_VERSION;
    taint: Taint;
    /**
     * Tracker id of the signed actor (the Linear user who replied, delegated, moved…), from the signed
     * webhook body (ORC-160); absent on an untrusted event and on what the factory produces itself.
     * Authorizations are checked on it, never on a name quoted in the text (ORC-186). Optional: no
     * version bump, older rows lack it.
     */
    actor?: string;
    /**
     * Roles of `actor` on the project, resolved before the decision for a human event (ORC-186) and
     * journaled with it, so that a replay checks the matrix on the same roles. Empty without an actor.
     * Absent on what the factory produces and on rows journaled before ORC-186: `decide` checks no
     * authorization on them.
     */
    roles?: readonly Role[];
    payload: EventPayloads[K];
  };
}[T];

/** State changes decided by `decide`, applied to the ticket by `reduce`. */
export type DecidedEvent =
  | { type: 'ticket.blocked'; reason: string }
  | { type: 'ticket.unblocked' }
  | {
      type: 'ticket.patched';
      patch: Partial<Pick<TicketState, 'verifyAttempts' | 'redAttempts' | 'repeatedFailure' | 'ciFixAttempts' | 'prNumber' | 'prUrl' | 'prChecks' | 'prState' | 'linearSessionId' | 'initiatorId' | 'leaseRelaunches' | 'cutRelaunches' | 'frozenTests' | 'verifiedSha'>>;
    }
  | { type: 'feedback.appended'; item: FeedbackItem }
  /** The ticket's dev work is stopped: nothing pending, no verification awaited. */
  | { type: 'work.cancelled' }
  | { type: 'verify.started'; runId: string };

/**
 * A dev start kept for when the slot frees. `sensitivePaths`: those its start was decided with; the launch
 * adds them when what the run reads then is untrusted (I12, ORC-274).
 */
export type PendingJob = { job: string; input?: InputKind; inputText?: string; resume?: boolean; sensitivePaths?: readonly string[]; relaunchOf?: string };

/** Facts the orchestrator records around an effect it carried out, applied to the ticket by `reduce`. */
export type ShellEvent =
  /** The factory itself moved the ticket in the tracker. */
  /** `reviewSha`: the PR's head when the factory moves the ticket to Human Review, the commit the human reviews (ORC-148). */
  | { type: 'status.recorded'; to: LogicalState; reviewSha?: string }
  | { type: 'session.linked'; linearSessionId: string }
  | { type: 'pending.set'; job: PendingJob }
  | { type: 'pending.cleared' }
  | { type: 'workspace.prepared'; path: string; port?: number; branch?: string }
  | { type: 'workspace.released' }
  | {
      type: 'run.started';
      runId: string;
      job: string;
      queue: QueueName;
      claudeSessionId: string;
      /** `false` on a run out of the ticket session (a review): the ticket does not take its session (ORC-217). Absent before. */
      ticketSession?: false;
    }
  /**
   * The pending feedback was given to a run, recorded once that run is written (ORC-220): a launch cut
   * before it keeps the replies for the start taken up again.
   */
  | { type: 'feedback.consumed' }
  /** The active run is gone without a `run.finished` (launch failure, or a launch cut before its run was written). */
  | { type: 'run.cleared' };

export type InternalEvent = DecidedEvent | ShellEvent;

export interface TicketState {
  projectId: string;
  ticketId: string;
  title: string;
  logical: LogicalState;
  /** True only while the ticket is delegated to the app user: only then does it get dev-queue work. */
  delegated: boolean;
  /** Linear sessions opened by a mention or a command on this ticket: replies there are questions, never feedback. */
  questionSessionIds: string[];
  blocked: boolean;
  blockReason?: string;
  claudeSessionId?: string;
  linearSessionId?: string;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  prChecks?: 'pending' | 'pass' | 'fail' | 'none';
  prState?: 'OPEN' | 'MERGED' | 'CLOSED';
  /** The commit shown to the human reviewer, recorded at the move to Human Review: the only one a Done merges (ORC-148). */
  reviewSha?: string;
  /** The status the factory itself moved the ticket to, while no human moved it since: its late webhook is an echo (ORC-148). */
  recordedStatus?: LogicalState;
  worktreePath?: string;
  port?: number;
  activeRunId?: string;
  /** Job of `activeRunId`, read by `when: job == …` conditions. */
  activeJob?: string;
  verifyingRunId?: string;
  /** The last commit `verify` found green (ORC-151): nothing else is published. Absent before it. */
  verifiedSha?: string;
  pendingJob?: PendingJob;
  verifyAttempts: number;
  /** Unverified reds in blocking mode since the last verified one, bounded by the job's `red.attempts` (ORC-123). Absent before it. */
  redAttempts?: number;
  /** The frozen tests and harness (ORC-131): a file leaves the freeze only by a maintainer's `/refreeze`. Absent before it. */
  frozenTests?: FrozenTests;
  /** The last failed check (worktree and failed commands) and how many times in a row it came back (ORC-187). */
  repeatedFailure?: { signature: string; count: number } | null;
  /**
   * Runs started by red CI (`pr.checks_failed`) since the last green CI or human relaunch, bounded by
   * `limits.ciFixAttempts` (I5, ORC-270). The AI review loop does not share it yet (ORC-184, ORC-187).
   */
  ciFixAttempts: number;
  /** Relaunches of an expired lease since an attempt last ended or a human relaunched (ORC-220). Absent before it. */
  leaseRelaunches?: number;
  /**
   * When each automatic relaunch after a cut was decided (`run.lost`, `verify.lost`), those still in the window
   * at the last one (ORC-220). Only a human relaunch empties it. Absent until the first: journals from before it replay as they were.
   */
  cutRelaunches?: number[];
  /**
   * Signed actor of the last authorized delegation (ORC-186): the run's initiator, who never validates
   * its spec, and its requester, who may answer it.
   */
  initiatorId?: string;
  pendingFeedback: FeedbackItem[];
  priority: number;
  costUsd: number;
  updatedAt: number;
  /** Hash of the workflow version the ticket was decided on first, read for all its later decisions (ORC-149). */
  workflowHash?: string;
}

/** Fills fields added after a row was first persisted. */
export function normalizeTicket(t: TicketState): TicketState {
  return { ...t, delegated: t.delegated ?? false, questionSessionIds: t.questionSessionIds ?? [], ciFixAttempts: t.ciFixAttempts ?? 0 };
}

export function newTicketState(
  projectId: string,
  ticketId: string,
  title: string,
  logical: LogicalState,
  now: number,
  priority = 0,
): TicketState {
  return {
    projectId,
    ticketId,
    title,
    logical,
    delegated: false,
    questionSessionIds: [],
    blocked: false,
    verifyAttempts: 0,
    ciFixAttempts: 0,
    pendingFeedback: [],
    priority,
    costUsd: 0,
    updatedAt: now,
  };
}
