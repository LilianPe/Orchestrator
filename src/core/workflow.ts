import type { NetworkLevel } from '../adapters/sandbox/types.js';
import type { Effort, FixCause, Preset } from '../presets/preset.js';
import type { InputKind, LogicalState, QueueName } from './types.js';

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
   * Rounds of human review feedback (ORC-190): starts of the fix the merge gate's failure edge sends the run to, before the next
   * feedback blocks the ticket (the preset's `human_review`, I5), apart from `ciFixAttempts`. 0 for a preset with no merge gate.
   */
  humanReviewRounds: number;
  /** Same failed commands on an unchanged worktree, N times in a row: blocked, cause « boucle » (ORC-187). */
  repeatedFailures: number;
  /** An attempt that writes nothing for this long is stopped (ORC-136). */
  silentAfterMs: number;
  /** Returns to `spec_draft` after a failed `spec_check`, the next failure blocks (ORC-212). */
  specCheckReturns: number;
  /** `/changes` rounds of the spec review, one more blocks (ORC-212). 0 for a preset with no spec review. */
  specChanges: number;
}

export interface JobSpec {
  name: string;
  queue: QueueName;
  model: string;
  /** The preset step the job runs (`step`, ORC-136), named by its block's comment (ORC-196). Absent from the answer agent, out of the preset. */
  step?: string;
  /** The cause of a job of the `fix` step (ORC-391): it picks the step's skill and the counter of the edge that sends the run there. */
  cause?: FixCause;
  /** `claude --effort`, of the preset step the job names (`step`, ORC-136), or the job's own out of the preset (ORC-182). Absent: the CLI's default. */
  effort?: Effort;
  /**
   * `published`: a fresh clone of the commit the factory published, detached, gone with the run (ORC-183): what an AI review
   * reads, never the agent's worktree. Only a job of the `review` step has it.
   */
  workspace: 'worktree' | 'trunk-readonly' | 'published';
  session: 'new' | 'resume';
  skill: string;
  /** The angle of an AI review job (ORC-183): correctness and the spec, or security and the tests. Only a job of the `review` step has one. */
  lens?: ReviewLens;
  /** The network level of the job's preset step (ORC-183), or the job's own out of the preset (ORC-182), narrowed by the repository's at the launch. Absent: the repository's. */
  network?: NetworkLevel;
  /**
   * The built-in tools of the job's preset step (ORC-383): `factory.yml`'s `tools.per_step`, else the step's default (`stepTools`): `Read`,
   * `Grep` and `Glob` for a read-only step (ORC-367), the write tools otherwise; refused anything else by the run itself, whatever its
   * skill says. The answer agent's are the read-only tools (ORC-182).
   */
  tools: readonly string[];
  input?: InputKind;
  verify: string[];
  /**
   * The job's commits go through `verify` whether or not it declares commands (ORC-151): the repository's, read on its
   * base branch, and the checks of the diff; and only a commit it found green may be merged. Absent from the jobs without it.
   */
  repoChecks?: boolean;
  pickup: boolean;
  /**
   * The job's agent always calls `submit_result` (ORC-289): a success without output is a failure.
   * ponytail: provisional, off by default until ORC-191/ORC-192 rewrite the pack so every agent submits;
   * then the gate goes and `attempt` decides alone.
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
}

/** What the end of a step posts: `review` is the findings of the AI review's lenses, published as a GitHub review and `factory/review` (ORC-183). */
export type Post = 'summary' | 'reply' | 'review';

export type ReviewLens = 'correctness' | 'security';

/**
 * The format of the workflow this factory decides on (ORC-393). A ticket frozen on a version of another format is refused
 * (`frozenWorkflow`): the versions frozen before the preset drove the chain (v1) are no longer read.
 */
export const WORKFLOW_FORMAT = 2;

export interface Workflow {
  version: typeof WORKFLOW_FORMAT;
  /** `rapide` (ORC-231): the level of `factory/fantome`, no question asked and the spec approved by the preset. */
  level?: 'rapide';
  tracker: { kind: 'linear'; team?: string; pickup: { checks: PickupCheck[] } };
  /**
   * The Linear status of each logical state. `ready` (« Ready to Merge ») is gone (ORC-170). `cancelled` has no status of its
   * own: it is read on the Linear type, and nothing moves a ticket to it.
   */
  states: Record<Exclude<LogicalState, 'ready' | 'cancelled'>, string> & { ready?: never; cancelled?: never };
  limits: Limits;
  /** `portBase`: the `PORT` the visual proof's application listens on (ORC-176); what starts it is `.factory/config.yml`'s `preview`. */
  workspace: { setup: string[]; portBase: number };
  jobs: Record<string, JobSpec>;
  /**
   * The job a question relayed to the agent that implements starts, with no human feedback beside it, where a reply would
   * start the reply rules' job (ORC-375): it answers, and its end moves, posts and reviews nothing unless it committed.
   * Absent only at the Rapide level (`factory/fantome`, no `fix` step), where nobody asks a question (`workflowViolations`).
   */
  relayJob?: string;
  /** The preset the workflow runs (ORC-391): the end of each job walks its steps (`step.next`). */
  preset: Preset;
  /** The step the chain starts at: `build` for `factory/default` until ORC-395, the preset's entry otherwise. */
  entry: string;
  /**
   * The job a delegation starts in place of the entry's (ORC-392): only tests set it, to start at `intake`, `spec` or `tests`
   * while `factory/default`'s chain starts at `build`. Goes when the delegation starts at the preset's entry (ORC-395).
   */
  delegated?: string;
}
