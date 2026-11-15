import type { JobSpec, ReviewLens } from '../core/workflow.js';
import type { FixCause } from './preset.js';

/**
 * How each step of a preset runs (ORC-391): the queue its runs wait in, the workspace and the session they get, what they
 * read, and whether they must hand back a structured result. These are the runtime's, not the product's: they stay out of
 * the `Preset` type, and what changes the product (skill, lenses, red mode, attempt duration, guard checks) is in the preset.
 *
 * Each row is a job: the runtime name of « a step run in a given way », as the ticket state and the journals record it
 * (`blockedJob`, `pendingJob`, `run.finished`). A step has one job, but `fix`, one per cause, and `review`, one per lens.
 * A preset gets the jobs of the steps it has, of the lenses its review lists. `model` is the alias the launch passes to
 * `claude --model`.
 */
export interface Binding extends Pick<JobSpec, 'queue' | 'model' | 'workspace' | 'session' | 'input' | 'repoChecks' | 'pickup' | 'structuredOutput'> {
  step: string;
  /** The cause of a `fix` job: it picks the step's skill, and the counter of the edge that sent the run there. */
  cause?: FixCause;
  /** The angle of a `review` job. */
  lens?: ReviewLens;
}

/** A run in the ticket's worktree, whose commits go through `verify` and the checks of the diff in a fresh clone (ORC-151). */
const WRITES = { queue: 'dev', model: 'sonnet', workspace: 'worktree', repoChecks: true, pickup: false } as const;
/** A fix resumes the ticket's session in its worktree; its commit goes back through `verify`, `publish` and the AI review. */
const FIX = { ...WRITES, step: 'fix', session: 'resume', structuredOutput: false } as const;
/** An AI review lens (ORC-183): a fresh clone of the commit the factory published, read-only, in a session of its own. */
const REVIEW = { step: 'review', queue: 'dev', model: 'opus', workspace: 'published', session: 'new', pickup: false, structuredOutput: true } as const;

/** In this order, as the jobs of the workflow are listed: the journals pin them as JSON text. */
export const BINDINGS: Readonly<Record<string, Binding>> = {
  // `intake` (ORC-206), on a fresh clone of the trunk.
  intake: { step: 'intake', queue: 'dev', model: 'sonnet', workspace: 'trunk-readonly', session: 'new', pickup: false, structuredOutput: true },
  // The build; the guard's checks run at its launch while it is the chain's entry (`pickup`).
  dev: { ...WRITES, step: 'build', session: 'new', pickup: true, structuredOutput: true },
  // `spec_draft` (ORC-212): the spec through `submit_result`.
  spec: { step: 'spec_draft', queue: 'dev', model: 'sonnet', workspace: 'worktree', session: 'new', pickup: false, structuredOutput: true },
  // `tests` (ORC-123): the ticket session starts here (ORC-217).
  tests: { ...WRITES, step: 'tests', session: 'resume', structuredOutput: false },
  // A human's message while the ticket is In Progress, or a reply to a block with no step of its own (ORC-196).
  'dev-feedback': { ...FIX, cause: 'instruction', input: 'feedback' },
  'fix-ci': { ...FIX, cause: 'ci', input: 'ci_failures' },
  // The blocking findings of the last review, each fixed or contested (`submit_result`'s `fixed` and `contested`).
  'fix-review': { ...FIX, cause: 'review', input: 'findings', structuredOutput: true },
  'fix-human': { ...FIX, cause: 'human', input: 'feedback' },
  // The answer to questions relayed to the agent that implements (ORC-375): no check unless it commits.
  'answer-relayed': { ...FIX, cause: 'relay', input: 'feedback', repoChecks: undefined },
  // The rebase (ORC-146): its commit goes through `verify`, then over the head the factory published.
  rebase: { ...WRITES, step: 'rebase', session: 'resume', structuredOutput: true },
  review: { ...REVIEW, lens: 'correctness' },
  'review-security': { ...REVIEW, lens: 'security' },
};
