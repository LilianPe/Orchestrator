import type { ReviewLens } from '../config/workflow-schema.js';
import type { AgentOutput, Finding } from './agent-output.js';
import type { BlockFacts } from './block-comment.js';
import type { InputKind, InternalEvent, LogicalState, TimerFired } from './types.js';
import type { VisualProof } from '../checks/visual-proof.js';

export type ActivityType = 'thought' | 'response' | 'elicitation' | 'error';

/** An action outside the ticket state, carried out by the orchestrator (later: the outbox). */
export type Effect =
  /** `sensitivePaths`: set on a run started from an untrusted event, the mark that makes the branch untrusted (`SENSITIVE_PATHS`, ORC-338). */
  /** `relaunchOf`: the lost attempt whose step this starts again (ORC-220): what it read and its session come from its record. */
  | { kind: 'start_run'; job: string; input?: InputKind; inputText?: string; linearSessionId?: string; resume?: boolean; sensitivePaths?: readonly string[]; relaunchOf?: string }
  /** Without linearSessionId: stop the ticket's dev work. With it: stop only the runs of that (question) session. */
  | { kind: 'stop_run'; linearSessionId?: string }
  /**
   * `output`: the run's validated output (ORC-289), carried to its `post_output`; absent when it submitted none. `head`: a
   * human's push (ORC-159), the commit checked as the forge holds it, by no run: `runId` is then the check's id (`pushCheckId`).
   */
  | { kind: 'run_verify'; runId: string; job: string; output?: AgentOutput; head?: string }
  /**
   * The verified commit out to the forge (ORC-125), by the factory alone, then `publish.done` or `publish.refused`. `output`: for
   * the `post_output` the job's `on_success` writes once it is out. `rewrite`: the commit of a rebase (ORC-146), which may
   * replace the head the factory published last, and that head only.
   */
  | { kind: 'publish'; runId: string; job: string; sha: string; output?: AgentOutput; commands?: readonly string[]; rewrite?: true; visualProof?: VisualProof }
  /** `keepReviewSha`: a move back to Human Review that concludes no work of the factory keeps the reviewed commit (ORC-148). */
  | { kind: 'move'; to: LogicalState; keepReviewSha?: true }
  | { kind: 'labels'; add: string[]; remove: string[] }
  | { kind: 'comment'; body: string }
  /** The standard comment of a block (ORC-196): its fields decided here, its text composed when it is written. */
  | { kind: 'block_comment'; block: BlockFacts }
  /**
   * The ack of a webhook's event (ORC-171): `body` in its session, as Linear asks of a session within 10 s, its time
   * recorded on the inbox row. `comment`: on the ticket too (ORC-140), first. `plan`: then opens the session's plan.
   */
  | { kind: 'ack'; body: string; linearSessionId: string; comment?: true; plan?: true }
  /** `options`: an elicitation answered by picking one (`select`, ORC-210). */
  | { kind: 'activity'; type: ActivityType; body: string; linearSessionId?: string; runId?: string; options?: readonly string[] }
  | { kind: 'post_output'; style: 'summary' | 'reply' | 'synthesis'; runId: string; output?: AgentOutput }
  /**
   * An AI review lens's findings on the published commit `sha`, kept (ORC-183); `publish`: then every lens's findings on it go
   * out as one GitHub review with inline comments, and `factory/review`, failed on a blocking one.
   */
  | { kind: 'review'; runId: string; lens: ReviewLens; sha: string; findings: readonly Finding[]; publish?: true }
  | { kind: 'link_pr'; url: string }
  /** Compare Linear and GitHub to the factory's state and write what a lost webhook missed to the inbox (ORC-185). */
  | { kind: 'reconcile' }
  /** Merge the ticket's PR if its head is still `sha` (ORC-148), by the factory's GitHub App. */
  | { kind: 'merge'; sha: string }
  /** A container of its own for a human who takes `runId` over (ORC-234), on the ticket's worktree, once that run has ended. */
  | { kind: 'take_over'; runId: string }
  /** The ticket's take-over container closed (ORC-234): the ticket leaves its take-over, first of the decision's effects. */
  | { kind: 'close_take_over' }
  /** The bundle `by` handed back (ORC-234), checked by the factory and pushed if it passes: then the human's push (`push.human`). */
  | { kind: 'publish_bundle'; file: string; by: string }
  /**
   * The `after_merge` step (ORC-197), once the ticket's PR `number` is merged at `at`: its changelog entry appended, once by the
   * effect's id, then the ticket's requester told in its session, with the PR's link. `headSha`, `mergeSha`: as GitHub gave them.
   */
  | { kind: 'after_merge'; number: number; url: string; at: number; headSha?: string; mergeSha?: string }
  | { kind: 'cleanup' }
  | { kind: 'set_paused'; paused: boolean };

/**
 * What the worker writes to the outbox for a decision (ORC-149): the decided effects, plus
 * `settle` after an event that settles a run (start the ticket's pending job, then drain the
 * queues), a shell step until ORC-150 moves it into `decide`.
 */
export type OutboxEffect = Effect | { kind: 'settle' };

/**
 * A timer `decide` arms (ORC-161), due `ms` after the decision: its kind and what it carries. `slot`
 * names it within the ticket (key `<ticket>:<slot>`): arming a slot again pushes its timer back.
 */
export type Timer = TimerFired & { slot: string; ms: number };

/** What `decide` returns: state changes for `reduce`, effects to run, timers to arm, and why. */
export interface Decision {
  events: InternalEvent[];
  effects: Effect[];
  timers: Timer[];
  trace: string[];
}
