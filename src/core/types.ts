import type { AgentOutput, AttemptOutcome } from './agent-output.js';
import type { Role } from './authz.js';
import type { BlockKind } from './block-cause.js';
import type { ClassifiedDiff } from './diff-class.js';
import type { StoredEvent } from './upcast.js';
import type { SpecVersion } from './spec.js';
import type { FlakyTest } from '../checks/flaky.js';
import type { FrozenTests } from '../checks/freeze.js';
import type { RedCause } from '../checks/red.js';
import type { VisualProof } from '../checks/visual-proof.js';
import type { ReviewLens } from '../config/workflow-schema.js';

export const LOGICAL_STATES = ['todo', 'dev', 'human_review', 'ai_review', 'ready', 'done'] as const;
export type LogicalState = (typeof LOGICAL_STATES)[number];
export function isLogicalState(v: string): v is LogicalState {
  return (LOGICAL_STATES as readonly string[]).includes(v);
}

/** The size of a ticket as `intake` estimates it (ORC-206). */
export const TICKET_SIZES = ['xs', 's', 'm', 'l', 'xl'] as const;
export type TicketSize = (typeof TICKET_SIZES)[number];

/** A question of `clarify` (ORC-210): its options, none for a free one. */
export interface ClarifyQuestion {
  question: string;
  options: string[];
}

/** An accepted answer to a `clarify` question (ORC-210), signed as the reply that gave it: a decision, as an approval is. */
export type ClarifyAnswer = Pick<FeedbackItem, 'author' | 'authorId' | 'at'> & { question: string; answer: string };
/** A lead to existing code `intake` found close to the request (ORC-207): a file or module, a symbol in it, and why. */
export interface ReuseLead {
  path: string;
  symbol?: string | undefined;
  why: string;
}
/** The risk of a run, lowest first (ORC-206): the order I4 keeps from going down. */
export const RISKS = ['low', 'medium', 'high'] as const;
export type Risk = (typeof RISKS)[number];
/** The higher of two risks: a proposal never lowers the run's (I4). A risk cleared by a new run (`null`, ORC-365) is none. */
export const higherRisk = (held: Risk | null | undefined, proposed: Risk): Risk => (held && RISKS.indexOf(held) > RISKS.indexOf(proposed) ? held : proposed);

export type RunOutcome = 'success' | 'failure' | 'stopped' | 'limit';

/** A Linear ticket the ticket is « blocked by » (ORC-363), as read: its status name, for the human. */
export interface Blocker {
  identifier: string;
  stateName: string;
}

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

/** What a token cap counts: what the model read anew and wrote. A cache read costs next to nothing, and grows with each turn. */
export const spentTokens = (u: TokenUsage): number => u.input + u.output + u.cacheCreation;

/** What the dashboard counts as a ticket's tokens: all four kinds, cache reads included. web/src/Flow.tsx has its twin: the web project cannot import this module, whose types reach Node. */
export const totalTokens = (u: TokenUsage): number => u.input + u.output + u.cacheRead + u.cacheCreation;

export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheCreation: a.cacheCreation + b.cacheCreation };
}

/**
 * What the runner saw of an attempt that no longer moves (ORC-136), journaled with its end so that `decide` judges it
 * and a replay judges the same. `loop`: the same Bash command, the same normalized failure (`failure`, its hash) and the
 * same content of the worktree (`tree`), `count` times. `silent`: nothing written on its stream for `silentMs`.
 */
/** The budget an attempt spent (ORC-216): its tokens (`budgets.per_step_tokens`, or what the ticket had left) or its turns (`max_turns`). */
export type OverBudget = 'tokens' | 'turns';

export type Stagnation =
  | { kind: 'loop'; command: string; failure: string; tree: string; count: number }
  | { kind: 'silent'; silentMs: number };

/**
 * `spec_check`: what the factory's check of a spec found wrong, with the refused draft (ORC-212).
 * `diff`: the published commit's diff an AI review reads (ORC-183). `findings`: the blocking findings of the last AI review,
 * which the fix of the review loop reads, with the PR's unresolved threads (ORC-184).
 */
export type InputKind = 'feedback' | 'ci_failures' | 'thread' | 'verify_failures' | 'spec_check' | 'diff' | 'findings';
export type QueueName = 'dev' | 'questions';

/** A finding of the AI review the fix contests (ORC-184): its id in the fix's input (`correctness-1`), and why it does not apply. */
export type ContestedFinding = NonNullable<AgentOutput['contested']>[number];

/** What a human message asks for (ORC-180), classified at its arrival and journaled with it. */
export type MessageKind = 'question' | 'instruction' | 'command';

export interface FeedbackItem {
  /** The author's name, for the prompt. */
  author: string;
  /** Signed actor of the event that brought the item (ORC-186); absent on items from the forge or written before. */
  authorId?: string;
  body: string;
  at: number;
  /** `session`: the ticket's dev conversation, in its session or by a comment that replies to a block (ORC-196). `thread`: a question of a question thread, or a message on a ticket not delegated: answered there, no agent asked for it (ORC-180). */
  source: 'session' | 'thread' | 'review' | 'label' | 'verify' | 'ci';
  /** Its class when it came in; absent on items written before ORC-180, which only a run that reads the feedback takes. */
  kind?: MessageKind;
  /**
   * An inline comment of a review on the PR (ORC-190): its thread is what the agent reads, from the PR at the launch, so a thread
   * resolved meanwhile is not fixed. Kept in the inbox all the same, as what started the round.
   */
  thread?: true;
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
 *   `inbox`: armed by a classified message (ORC-180): it starts nothing while work is in flight, the messages wait for its end.
 * - `clarify.remind` / `clarify.expire`: the reminder of the `clarify` questions still open at 24 h, then the block at
 *   72 h (ORC-210), armed when intake's guard asks them; one of a round answered or left since does nothing.
 * - `usage.reset`: the reset of a subscription's usage limit, armed by a question's `run.finished` the limit stopped
 *   (`on_usage_limit: wait`, ORC-340): `job` is asked again then, as a relaunch of `runId`. A code step waits as a pending
 *   relaunch instead (ORC-357); its timer, armed by an earlier version, relaunches it the same way.
 */
export interface TimerPayloads {
  debounce: { job: string; inbox?: true };
  /** `at`: when the questions were asked, which tells this round's timers from an earlier one's (`TicketState.clarify`). */
  'clarify.remind': { linearSessionId?: string; at?: number };
  'clarify.expire': { linearSessionId?: string; at?: number };
  'usage.reset': { job?: string; runId?: string };
  /** The project's reconciliation (ORC-185), every 5 minutes, on its own pseudo-ticket (`reconcileTicket(project)`). */
  reconcile: Record<string, never>;
}

export type TimerKind = keyof TimerPayloads;

/** A timer's kind and what it carries: what `timer.fired` brings back to `decide`. */
export type TimerFired = { [K in TimerKind]: { kind: K; payload: TimerPayloads[K] } }[TimerKind];

/** A human message in a Linear session, a mention or a reply. */
interface SessionMessage {
  linearSessionId: string;
  body: string;
  author: string;
  issue?: IssueSnapshot;
  ack?: true;
  kind?: MessageKind;
  masked?: true;
  repos?: string[];
  waitedIn?: string;
}

export interface EventPayloads {
  /**
   * `ack`: brought by the webhook, to acknowledge (ORC-171). `noRepo`: the Linear team no project takes: the ticket waits blocked under the first project.
   * `repos`: the team has several and the ticket names none (ORC-291); the delegation then waits for a human's choice.
   * `waitedIn`: the project where the ticket waited for that choice.
   */
  'ticket.delegated': { linearSessionId?: string; promptContext?: string; issue?: IssueSnapshot; ack?: true; noRepo?: string; repos?: string[]; waitedIn?: string };
  /** `keepLabel`: another project's ticket for the same issue is blocked, the label stays (ORC-291). */
  'ticket.undelegated': { keepLabel?: true };
  /**
   * `kind`: the class of the message at its arrival, journaled so that a replay decides on the same one (ORC-180); absent on
   * rows written before, which decide as they did. `masked`: a secret was masked out of `body` before it was journaled.
   */
  'session.mentioned': SessionMessage;
  'session.prompted': SessionMessage;
  'session.stopped': { linearSessionId?: string; repos?: string[]; waitedIn?: string };
  /**
   * The agent's question through `/agent/ask` (ORC-196), journaled when it asks: told once the block is committed, by
   * the same comment as any block, so that a reply always finds it. `job`: the job of the run that asks;
   * `linearSessionId`: its session, where a question thread hears it.
   */
  'agent.asked': { question: string; job: string; linearSessionId?: string };
  /**
   * The reconciliation read every ticket a waiting ticket is « blocked by » done, or no such relation left (ORC-363): the start
   * it waited for is made. `blockers`: those it waited on. Trusted: no human content, and the start keeps its own restrictions.
   */
  'blockers.done': { blockers: string[] };
  /**
   * A human's comment on the ticket, out of any session (ORC-196): the reply to a block's comment. Decided only while the ticket is
   * blocked. `kind`, `masked`: as a session's message (ORC-180); this event never existed without them.
   */
  'ticket.commented': { body: string; author: string; kind: MessageKind; masked?: true };
  /** `cancelled`: the new status is of type canceled in Linear (ORC-170). */
  'status.changed': { from: LogicalState | null; to: LogicalState | null; cancelled?: true };
  /** `otherRepo`: the label names another repo of the ticket's team (ORC-291). */
  'label.changed': { label: string; change: 'added' | 'removed'; otherRepo?: true };
  /** A commit pushed by a human on the ticket's branch. */
  /** `before`: the branch's head before the push (all zeros for a new branch); absent on events recorded before ORC-338. */
  'push.human': { branch: string; sha: string; author: string; before?: string };
  /** `frozen`: for a `/refreeze`, the freeze at the branch's head, read before the decision (ORC-131); absent without a freeze or a branch. */
  command: { name: string; body: string; linearSessionId: string; author: string; issue?: IssueSnapshot; ack?: true; kind?: MessageKind; masked?: true; frozen?: FrozenTests; repos?: string[]; waitedIn?: string };
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
   * its body is written by whoever can review. Human review feedback (ORC-190): signed by the sender's GitHub login, checked
   * on the matrix, kept in `humanInbox` and read through the reply rules.
   */
  'pr.reviewed': PrPayload & { kind: 'review' | 'comment'; author: string; body: string; state?: string };
  /** The PR conflicts with its base branch, seen by the GitHub webhook (ORC-134). No reaction yet: `decide` traces it (ORC-146). */
  'pr.conflicted': PrPayload & { headSha: string; baseRef: string };
  /**
   * The factory's merge refused (ORC-148): a push since the review, a PR not mergeable. `reason` is for the human;
   * `headMoved`: refused for a push since the review, whose new commits go through the AI review again.
   */
  'pr.merge_refused': PrPayload & { reason: string; headMoved?: boolean };
  /** The verified commit is on the forge and its PR open (ORC-125), or the branch holds nothing to publish. The job's `on_success` applies. */
  'publish.done': { runId: string; job: string; sha: string; output?: AgentOutput };
  /** The factory did not publish, and says why (ORC-125): nothing was written on the forge. The ticket is blocked. */
  'publish.refused': { runId: string; job: string; sha: string; reason: string };
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
   * it lack both and decide on `outcome` as before. `stagnation` (ORC-136): optional likewise, absent on rows written before it.
   */
  'run.finished': {
    runId: string;
    job: string;
    outcome: RunOutcome;
    costUsd: number;
    turns: number;
    lastText: string;
    attempt?: AttemptOutcome;
    output?: AgentOutput;
    stagnation?: Stagnation;
    /** The deterministic checks of the ticket that failed at the launch of `intake` (ORC-206): inputs of the guard before In Progress. Absent when none failed. */
    pickup?: string[];
    /** The tickets not done that the ticket was « blocked by » at the launch of `intake` (ORC-363): an input of the guard. Absent when none. */
    blockedBy?: Blocker[];
    /** The usage limit of `account` stopped it and the factory waits on it (`on_usage_limit: wait`, ORC-340): resumed at `resetAt`. */
    usageLimit?: { resetAt: number; account?: string };
    /** The cap of its budget that stopped it (ORC-216), with `outcome: limit`. Absent on rows written before it, and for its duration cap. */
    overBudget?: OverBudget;
  };
  /**
   * `red`: the cause of the `red` check's verdict (ORC-123), for a job checked by it instead of `verify`. `frozen`: the
   * freeze read with it (ORC-131), on both verdicts, recorded once the run goes on to the build. `sha`: the commit it
   * found green (ORC-151), the only one a merge may then carry; absent on the `red` check and on older rows.
   */
  /** `commands`: what `verify` ran on `sha`, for its check on the forge (ORC-151); absent when it ran nothing again. */
  /** `visualProof`: what `verify` decided and took of the visual proof (ORC-176), the captures by their hash. */
  /** `flaky`: the failing tests `verify` reran (ORC-164), with the cause of each attempt; on a pass, only indicative ones. */
  /** `diffClass`: the class of the diff of `sha` against the default branch (ORC-198); absent on a commit found green again, or before ORC-198. */
  'verify.passed': { runId: string; job: string; output?: AgentOutput; red?: RedCause; frozen?: FrozenTests; sha?: string; commands?: readonly string[]; visualProof?: VisualProof; flaky?: FlakyTest[]; diffClass?: ClassifiedDiff };
  /** `tree`: fingerprint of the content checked when the check failed: the commit's tree in a clean check, absent outside git (ORC-187). */
  'verify.failed': { runId: string; job: string; failures: VerifyFailure[]; tree?: string; red?: RedCause; frozen?: FrozenTests; flaky?: FlakyTest[] };
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
  /**
   * `runId`: the run the dashboard's inspection stops (ORC-301), nothing once it has ended; absent, the ticket's work
   * (the CLI, a row journaled before). `pause`: a pause of that run, a stop that says so. `takeOver`: a human takes
   * that run over (ORC-234): stopped, then a container of their own opens on its worktree.
   */
  'control.stop': { runId?: string; pause?: true; takeOver?: true };
  /** A bundle an operator hands back for a ticket taken over (ORC-234): `file`, where the daemon kept it, checked before any push. */
  'control.bundle': { file: string };
  /** The bundle handed back is refused (ORC-234): nothing was pushed, and the take-over stays open. */
  'bundle.refused': { file: string; reason: string };
  /** An outbox effect carried out (ORC-150). */
  'effect.done': EffectResultPayload;
  /** An outbox effect that failed on its last attempt (ORC-150): the ticket is blocked. */
  /** `queued`: a dead `settle` whose pending job the queue holds, read before its decision (ORC-359): nothing is lost, nothing blocked. */
  'effect.failed': EffectResultPayload & { error: string; queued?: true };
  /** An event whose decision threw, set aside in `dead_letter` (ORC-175): the ticket is blocked. */
  /** `refused`: the store refused the event, this notice goes to the project holding the ticket (ORC-316). */
  'dead_letter.added': { eventId: string; eventType: string; error: string; failures: number; attempts?: number; refused?: { projectId: string; linearSessionId?: string } };
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
  /** `job`: the step a reply resumes (ORC-196); none when no job of the workflow stands for it, then the rule's runs. */
  /**
   * `kind`: what the block is, set by the code that builds it (ORC-345); the engine decides on it, `reason` is only shown.
   * `eventId`: the event a `dead_letter` block sets aside, which its repair lifts.
   */
  | { type: 'ticket.blocked'; reason: string; kind: BlockKind; eventId?: string; job?: string }
  | { type: 'ticket.unblocked' }
  | {
      type: 'ticket.patched';
      patch: Partial<Pick<TicketState, 'verifyAttempts' | 'redAttempts' | 'repeatedFailure' | 'ciFixAttempts' | 'prNumber' | 'prUrl' | 'prChecks' | 'prState' | 'linearSessionId' | 'initiatorId' | 'leaseRelaunches' | 'cutRelaunches' | 'frozenTests' | 'verifiedSha' | 'diffClass' | 'awaitingRepo' | 'owedMove' | 'usageRelaunches' | 'usageAsks' | 'size' | 'risk' | 'visualProof' | 'clarify' | 'decisions' | 'waitingOn' | 'spec' | 'specCheckReturns' | 'specChanges' | 'reviewSha' | 'reviewBlocking' | 'contested' | 'humanReviewRounds' | 'reuse'>>;
    }
  | { type: 'feedback.appended'; item: FeedbackItem }
  /** The ticket's dev work is stopped: nothing pending, no verification awaited. */
  | { type: 'work.cancelled' }
  | { type: 'verify.started'; runId: string }
  /** `job`: only that pending job leaves the ticket, not one set since (ORC-339); absent, whichever is there. */
  | { type: 'pending.cleared'; job?: PendingJob }
  /** The ticket's Linear session: the delegation's that chose its repo (ORC-171), or the one a launch opened. */
  | { type: 'session.linked'; linearSessionId: string };

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
  | { type: 'pending.set'; job: PendingJob }
  /**
   * A dev launch takes the ticket before any effect (ORC-359), until `until`: refused while another launch holds it, its
   * hold not expired at `at`, or a run does. Written again by its holder to keep it; its `run.started` ends it. `over`: a hold
   * of the same daemon's launch that ended without letting go of it, taken over whatever its time.
   */
  | { type: 'launch.reserved'; runId: string; start: PendingJob; at: number; until: number; over?: string }
  /** A launch that ends before its `run.started` lets go of the ticket, if it still holds it. */
  | { type: 'launch.released'; runId: string }
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
      /**
       * A run launched with sensitive paths (it read untrusted content, I12) in the ticket's worktree: the head it starts on,
       * `''` when none is read. Marks the ticket's branch (`untrustedSince`, ORC-338).
       */
      untrusted?: { head: string };
      /** What the run starts, in the shape of a pending job: the run that starts the ticket's pending job takes it off (ORC-339). */
      starts?: PendingJob;
    }
  /**
   * The pending feedback was given to a run, recorded once that run is written (ORC-220): a launch cut
   * before it keeps the replies for the start taken up again. `items`: those the launch read, a message that came
   * in since stays for the next run (ORC-339); absent, the whole inbox.
   */
  | { type: 'feedback.consumed'; items?: readonly FeedbackItem[] }
  /** The active run is gone without a `run.finished` (launch failure, or a launch cut before its run was written). */
  | { type: 'run.cleared' }
  /**
   * What a ticket's run records said, read once, of a branch the mark has not seen yet (ORC-338): `''` when an untrusted
   * worktree run came before the mark existed (its whole branch is read), `null` when none did.
   */
  | { type: 'untrusted.read'; since: '' | null };

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
  /** What a human reads of the block: shown, never decided on (ORC-345). */
  blockReason?: string;
  /** What the block is (ORC-345): set with it, read by the engine and the Flow. A ticket blocked before it gets one from its reason (`upcastTicket`). */
  blockKind?: BlockKind;
  /** The event a `dead_letter` block sets aside: its repair lifts that block, not another one. */
  blockedEvent?: string;
  /** The job a reply resumes while the ticket is blocked (ORC-196). Absent on a block of no job, and on versions frozen before it. */
  blockedJob?: string;
  claudeSessionId?: string;
  linearSessionId?: string;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  prChecks?: 'pending' | 'pass' | 'fail' | 'none';
  prState?: 'OPEN' | 'MERGED' | 'CLOSED';
  /**
   * The commit shown to the human reviewer, recorded at the move to Human Review: the only one a Done merges (ORC-148).
   * `null` once a human pushed since (ORC-159): no approval from before the push passes a gate (I2).
   */
  reviewSha?: string | null;
  /** The status the factory itself moved the ticket to, while no human moved it since: its late webhook is an echo (ORC-148). */
  recordedStatus?: LogicalState;
  worktreePath?: string;
  port?: number;
  activeRunId?: string;
  /** Job of `activeRunId`, read by `when: job == …` conditions. */
  activeJob?: string;
  /** What `activeRunId` started, in the shape of a pending job (ORC-339): a launch that lost to it tells the same start from another. */
  activeStart?: PendingJob;
  /** The dev launch under way before its `run.started` (ORC-359): what it starts, and until when its hold lasts unless written again. */
  launching?: { runId: string; start: PendingJob; until: number };
  verifyingRunId?: string;
  /** The last commit `verify` found green (ORC-151): nothing else is published. Absent before it. */
  verifiedSha?: string;
  /** The class of the diff of `verifiedSha` against the default branch (ORC-198), as `verify` read it. Absent before ORC-198, null for a commit verified without one. */
  diffClass?: ClassifiedDiff | null;
  /**
   * The head of the ticket's branch when a run that read untrusted content first started in its worktree (ORC-338),
   * `''` when that head was not read or the run came before the mark existed: from then on, what the agent's commits
   * change in the repository's `sensitive_paths` is refused. Sticky: its commits stay on the branch whoever runs next.
   * `null` once read that no such run worked on it (`untrusted.read`); absent until then.
   */
  untrustedSince?: string | null;
  /** The pushes humans made to the ticket's branch (`push.human`, ORC-338): the commits of each are theirs, not the agent's. */
  humanPushes?: { before?: string; after: string }[];
  /**
   * The last commit a human pushed to the branch that no publication of the factory carries yet (ORC-159): every check
   * refuses a commit without it. `null` once a publication carried it, or the branch went back to the commit verified last.
   */
  humanHead?: string | null;
  pendingJob?: PendingJob;
  verifyAttempts: number;
  /** Unverified reds in blocking mode since the last verified one, bounded by the job's `red.attempts` (ORC-123). Absent before it. */
  redAttempts?: number;
  /** The frozen tests and harness (ORC-131): a file leaves the freeze only by a maintainer's `/refreeze`. Absent before it. */
  frozenTests?: FrozenTests;
  /** The last failed check (worktree and failed commands) and how many times in a row it came back (ORC-187). */
  repeatedFailure?: { signature: string; count: number } | null;
  /**
   * The move of a job's `on_success` that waits for its publication (ORC-125). Kept through a refusal: what relaunches the ticket
   * is `dev-feedback`, which has no move of its own, and the work would never reach its reviewer. `null`, not undefined, survives the journal's JSON.
   */
  owedMove?: LogicalState | null;
  /**
   * The repos of its Linear team to choose from, while the ticket waits for a human to name one (ORC-291); empty when
   * the team has none (ORC-171), the ticket then only filed under the first project. `null` once
   * chosen (`undefined` would not survive the journal's JSON); absent on a ticket that never waited.
   */
  awaitingRepo?: string[] | null;
  /**
   * Rounds of the review and CI loop of the run, bounded by `limits.ciFixAttempts` (the preset's `review_ci`, I5): runs started
   * by red CI (`pr.checks_failed`, ORC-270), by a conflict with the default branch (`pr.conflicted`, ORC-146) and by an AI
   * review with a blocking finding (ORC-184). One count per run: a human relaunch or another PR starts it over, a green CI does not.
   */
  ciFixAttempts: number;
  /**
   * The blocking findings each AI review lens kept on the published commit `sha` (ORC-184), counted by lens: the lens that
   * publishes reads their sum. Absent on a ticket never reviewed since ORC-184.
   */
  reviewBlocking?: { sha: string; counts: Partial<Record<ReviewLens, number>> };
  /**
   * Rounds of human review feedback (ORC-190): starts of the job of the `human_review` counter (`fix-human`), bounded by
   * `limits.humanReviewRounds`, apart from `ciFixAttempts`. A human relaunch or another PR starts it over. Absent before ORC-190.
   */
  humanReviewRounds?: number;
  /**
   * The findings of the review on `sha` the fix of the review loop contested, with its justification (ORC-184): they stay open,
   * and the next review's lenses read them. `null` once that review has published; absent when none was contested.
   */
  contested?: { sha: string; items: ContestedFinding[] } | null;
  /** Relaunches of an expired lease since an attempt last ended or a human relaunched (ORC-220). Absent before it. */
  leaseRelaunches?: number;
  /**
   * When each automatic relaunch after a cut was decided (`run.lost`, `verify.lost`), those still in the window
   * at the last one (ORC-220). Only a human relaunch empties it. Absent until the first: journals from before it replay as they were.
   */
  cutRelaunches?: number[];
  /**
   * The step the usage limit cut, as a version before ORC-357 recorded it, `null` once the ticket moved on: read only by the `usage.reset`
   * timer that version armed. A cut step now waits in line as a relaunch, and nothing writes this any more.
   */
  usageWait?: { runId: string } | null;
  /** Relaunches at a usage reset of `job` in a row (ORC-340), bounded by `USAGE_RELAUNCHES`; `null` once a run of the step ends without the limit. */
  usageRelaunches?: { job: string; count: number } | null;
  /** Questions asked again at a usage reset in a row (ORC-340), bounded like `usageRelaunches`; `null` once one ends without the limit. */
  usageAsks?: number | null;
  /**
   * The ticket waits for the Linear tickets it is « blocked by » to be done (ORC-363), then makes `start`: no block, nothing for a human
   * to answer. Lifted by `blockers.done`; a block, an undelegation or a dev run ends it (`reduce`): `null` then. A move or a delegation again do not.
   */
  waitingOn?: { blockers: string[]; start: PendingJob } | null;
  /**
   * Signed actor of the last authorized delegation (ORC-186): the run's initiator, who never validates
   * its spec, and its requester, who may answer it.
   */
  initiatorId?: string;
  /**
   * Every human message the factory kept, whatever its class (ORC-180, I6). It leaves only when a run that reads it is
   * written (`feedback.consumed`), or by a cancellation (ORC-170).
   */
  humanInbox: FeedbackItem[];
  priority: number;
  costUsd: number;
  updatedAt: number;
  /** The size `intake` estimated (ORC-206), its last assessment. Absent until one. */
  size?: TicketSize;
  /**
   * The risk of the run (ORC-206): the highest any step of it proposed, never lowered within it (I4). Absent until `intake`
   * assessed it. A delegation that starts a new run clears it (`null`, ORC-365): the new run's intake sets it from its own level.
   */
  risk?: Risk | null;
  /**
   * The `clarify` questions waiting for their answers (ORC-210): asked by the guard after `job` (intake) at `at`, the first
   * `answered` of them answered, in order. Not a block: the ticket waits, and whatever moves it on ends the wait (`reduce`).
   * `null` once over; absent on a ticket never asked.
   */
  clarify?: { job: string; questions: ClarifyQuestion[]; at: number; answered: number } | null;
  /** The answers accepted to the `clarify` questions (ORC-210): decisions of the ticket, given to its runs and kept with the freeze. */
  decisions?: ClarifyAnswer[];
  /**
   * Visual proof planned for the ticket (ORC-206): within a run, `intake` can only harden it to `required`, never lift it;
   * a new run plans its own, cleared (`null`) like `risk` (ORC-365). Absent or `null`: undecided until `verify` (ORC-176).
   */
  visualProof?: 'required' | null;
  /** The existing code `intake` found close to the request (ORC-207), its last assessment: leads `build` is given to reuse. */
  reuse?: ReuseLead[];
  /**
   * The ticket's spec (ORC-212), its last version: waiting for review while it has no approval and no run of the ticket
   * is being drafted, the contract of the later steps once approved. Absent until `spec_draft` wrote one; `null` once a
   * new delegation started the ticket's work afresh.
   */
  spec?: SpecVersion | null;
  /** The returns to `spec_draft` a failed `spec_check` used on the current draft (ORC-212): the next failure blocks. */
  specCheckReturns?: number;
  /** The `/changes` rounds since the last approval (ORC-212): one past the preset's bound blocks. */
  specChanges?: number;
  /** Hash of the workflow version the ticket was decided on first, read for all its later decisions (ORC-149). */
  workflowHash?: string;
}

/** What lifting a block clears, the whole block with it: its reason, its kind and their data. */
export const UNBLOCKED = { blocked: false, blockReason: undefined, blockKind: undefined, blockedEvent: undefined, blockedJob: undefined } as const satisfies Partial<TicketState>;

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
    humanInbox: [],
    priority,
    costUsd: 0,
    updatedAt: now,
  };
}
