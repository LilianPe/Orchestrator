import type { NetworkLevel } from '../adapters/sandbox/types.js';
import type { Effort, FixCause, Preset } from '../presets/preset.js';
import type { Condition } from './conditions.js';
import type { EventType, InputKind, LogicalState, QueueName } from './types.js';

/**
 * The workflow the engine decides on: built in TypeScript from a preset by `presetWorkflow` (`src/presets/workflow.ts`), pinned
 * by each ticket's frozen version and by the replay journals. The YAML pack and its loader are gone (ORC-389).
 */

export type PickupCheck = 'has_description' | 'not_started' | 'has_acceptance_criteria';

export interface RunLimits {
  turns: number;
  durationMs: number;
  /** Tokens of the attempt (`budgets.per_step_tokens`, ORC-136), cache reads left out: past it, a cap. Absent: no cap, the values are to calibrate (ORC-216). */
  tokens?: number;
}

export interface Limits {
  perRun: RunLimits;
  verifyAttempts: number;
  /** Runs red CI and conflicts may start, together, before the next one blocks the ticket (I5, ORC-270, ORC-146); 0 blocks at the first. */
  ciFixAttempts: number;
  /**
   * Rounds of human review feedback (ORC-190): starts of the job of the `human_review` counter, before the next feedback blocks the
   * ticket (the preset's `human_review`, I5), apart from `ciFixAttempts`. Absent from versions frozen before it, which have no such job.
   */
  humanReviewRounds?: number;
  /**
   * Same failed commands on an unchanged worktree, N times in a row: blocked, cause « boucle » (ORC-187).
   * Absent from versions frozen before it, which keep deciding without it.
   */
  repeatedFailures?: number;
  /** An attempt that writes nothing for this long is stopped (ORC-136). Absent from versions frozen before it, which do not watch it. */
  silentAfterMs?: number;
  /** Returns to `spec_draft` after a failed `spec_check`, the next failure blocks (ORC-212). Absent from versions frozen before it. */
  specCheckReturns?: number;
  /** `/changes` rounds of the spec review, one more blocks (ORC-212). Absent from versions frozen before it. */
  specChanges?: number;
}

export interface Rule {
  from?: LogicalState;
  to?: LogicalState;
  label?: string;
  say?: string;
  when?: Condition;
  whenSrc?: string;
  run?: string;
  debounceMs?: number;
  move?: LogicalState;
  labels?: { add: string[]; remove: string[] };
  comment?: string;
  /**
   * `after_merge` (ORC-197): the step of a merged PR, on `pr.merged` only: the requester told, the changelog entry, then `cleanup`.
   * `propose_delegate`: the answer to `fais-le`, only in versions frozen before ORC-193, which decide as they did.
   */
  do?: 'stop' | 'cleanup' | 'propose_delegate' | 'after_merge';
}

export interface JobSpec {
  name: string;
  queue: QueueName;
  model: string;
  /** The preset step the job runs (`step`, ORC-136), named by its block's comment (ORC-196). Absent from the jobs out of the preset and from versions frozen before it. */
  step?: string;
  /** The cause of a job of the `fix` step (ORC-391): it picks the step's skill and the counter of the edge that sends the run there. */
  cause?: FixCause;
  /** `claude --effort`, of the preset step the job names (`step`, ORC-136), or the job's own out of the preset (ORC-182). Absent: the CLI's default. */
  effort?: Effort;
  /**
   * `published`: a fresh clone of the commit the factory published, detached, gone with the run (ORC-183): what an AI review
   * reads, never the agent's worktree. Only a job of the `review` step has it.
   * `knowledge`: a worktree of the knowledge repository (`learn`, `remember`), only in versions frozen before ORC-193, which
   * decide as they did: the memory in writing sleeps, the launch refuses the job (`Orchestrator.startRun`).
   */
  workspace: 'worktree' | 'trunk-readonly' | 'knowledge' | 'published';
  session: 'new' | 'resume';
  skill: string;
  /** The angle of an AI review job (ORC-183): correctness and the spec, or security and the tests. Only a job of the `review` step has one. */
  lens?: ReviewLens;
  /** The network level of the job's preset step (ORC-183), or the job's own out of the preset (ORC-182), narrowed by the repository's at the launch. Absent: the repository's. */
  network?: NetworkLevel;
  /**
   * The built-in tools of the job's preset step (ORC-383): `factory.yml`'s `tools.per_step`, else the step's default (`stepTools`): `Read`,
   * `Grep` and `Glob` for a read-only step (ORC-367), the write tools otherwise; refused anything else by the run itself, whatever its
   * skill says. A job out of the preset by its `read_only` (ORC-182). Absent: every tool (a job a project adds, a version frozen before).
   */
  tools?: readonly string[];
  input?: InputKind;
  verify: string[];
  /**
   * The job's commits go through `verify` whether or not it declares commands (ORC-151): the repository's, read on its
   * base branch, and the checks of the diff; and only a commit it found green may be merged. Absent from the jobs and versions without it.
   */
  repoChecks?: boolean;
  /** `block`: a failed `verify` blocks the ticket instead of sending the job back: the job did not write what it found (a review, on a human's push). */
  verifyFailure?: 'block';
  pickup: boolean;
  /**
   * The job's agent always calls `submit_result` (ORC-289): a success without output is a failure.
   * ponytail: provisional, off by default until ORC-191/ORC-192 rewrite the pack so every agent submits;
   * then the gate goes and `attempt` decides alone. Absent from versions frozen before it.
   */
  structuredOutput?: boolean;
  /**
   * The `red` factory check after the job (ORC-123) instead of `verify`, the preset's `red` step: its added tests must fail for
   * the right reason, run with the repository's `commands.test`. `measure` records what it would have blocked and goes on;
   * `blocking` sends the job back, `attempts` checks at most (the preset counter `red` + 1), then blocks; a check that could
   * not run blocks in both. Absent from the jobs and versions without it.
   */
  red?: { mode: 'measure' | 'blocking'; attempts: number };
  limits: RunLimits;
  /**
   * What the job's start and end did in a version frozen before ORC-391, which has no preset: its move at the launch, its end's
   * move, post and next job, the fix of a blocking finding, its round of human review. A version with a preset reads them in
   * its steps (`src/core/chain.ts`). Removed with the frozen versions (ORC-392, ORC-393).
   */
  onStart?: { move?: LogicalState };
  onSuccess?: { move?: LogicalState; post?: Post; run?: string };
  onBlocking?: { run: string };
  counter?: 'human_review';
}

/** What the end of a step posts: `review` is the findings of the AI review's lenses, published as a GitHub review and `factory/review` (ORC-183). */
export type Post = 'summary' | 'reply' | 'synthesis' | 'review';

export type ReviewLens = 'correctness' | 'security';

export interface Workflow {
  version: 1;
  /**
   * A block is told by the standard comment, a reply resumes its step, and a comment on the ticket is a reply (ORC-196).
   * Absent from versions frozen before it, whose tickets keep the free text of their session: a replay decides as they did.
   */
  blockComment?: true;
  /** `rapide` (ORC-231): the level of `factory/fantome`, no question asked and the spec approved by the preset. */
  level?: 'rapide';
  tracker: { kind: 'linear'; team?: string; pickup: { checks: PickupCheck[] } };
  /**
   * `ready` (« Ready to Merge ») is gone from the pack (ORC-170): optional, for the versions frozen with it. `cancelled` has no
   * status of its own: it is read on the Linear type, so a move or a rule to it is refused at load.
   */
  states: Record<Exclude<LogicalState, 'ready' | 'cancelled'>, string> & { ready?: string; cancelled?: never };
  limits: Limits;
  /** `portBase`: the `PORT` the visual proof's application listens on (ORC-176); what starts it is `.factory/config.yml`'s `preview`. */
  workspace: { setup: string[]; portBase: number };
  commands: string[];
  on: Partial<Record<EventType, Rule[]>>;
  jobs: Record<string, JobSpec>;
  /**
   * The job a question relayed to the agent that implements starts, with no human feedback beside it, where a reply would
   * start the reply rules' job (ORC-375): it answers, and its end moves, posts and reviews nothing unless it committed.
   * Absent from versions frozen before it, whose relay starts the reply rules' job (ORC-374): a replay decides as they did.
   */
  relayJob?: string;
  /**
   * The preset the workflow runs (ORC-391): the end of each job walks its steps (`step.next`). Absent from versions frozen
   * before it, whose jobs chain by their own `onSuccess`.
   */
  preset?: Preset;
  /** The step the chain starts at: `build` for `factory/default` until ORC-395, the preset's entry otherwise. */
  entry?: string;
}
