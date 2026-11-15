import { isAgentStep, type Step } from '../presets/preset.js';
import type { LogicalState } from './types.js';
import type { JobSpec, Post, Workflow } from './workflow.js';

/**
 * The chain of a run (ORC-391): what the end of a job starts, moves and posts, read from the preset's steps the workflow
 * carries. A job runs a step; its end walks `step.next` past the steps the engine runs itself around a run (the checks,
 * `spec_check`, the publication of a push), to the next step that waits: an agent step, whose job starts; a human gate; the
 * merge; or the end of the run.
 */

/** The status the ticket shows while a step works or waits (ORC-170's names). ORC-382 makes it configurable. */
const STEP_STATUS: Readonly<Partial<Record<string, LogicalState>>> = { build: 'dev', review: 'ai_review', human_review: 'human_review' };

/** What the end of a step posts in the ticket's session: the build's summary, a fix's reply, the review (published by its last lens). */
const STEP_POST: Readonly<Partial<Record<string, Post>>> = { build: 'summary', fix: 'reply', review: 'review' };

/** What the end of a job does: the job it starts, the move it makes, what it posts. */
export interface JobEnd {
  run?: JobSpec;
  move?: LogicalState;
  post?: Post;
  /** The step the walk stopped at; null at the end of the run, undefined for a job out of the preset. */
  step?: Step | null;
}

/** The steps the engine runs itself around a job's run: its checks and the publication of its commit. */
const ranByEngine = (s: Step): boolean => s.type === 'verify' || s.type === 'spec_check' || (s.type === 'publish' && s.mode === 'push');

const stepById = (wf: Workflow, id: string | null | undefined): Step | undefined => (id ? wf.preset.steps.find((s) => s.id === id) : undefined);

/** The step `job` runs, in the workflow's preset. */
const stepOfJob = (wf: Workflow, job: Pick<JobSpec, 'step'>): Step | undefined => stepById(wf, job.step);

/** An optional step with no job of its own is passed: `clarify` asks the guard's questions with no run (ORC-210). */
const passed = (wf: Workflow, s: Step): boolean => ranByEngine(s) || (s.type === 'agent_step' && !!s.optional && !startingJob(Object.values(wf.jobs), s));

/**
 * The step after `from` that waits, past the engine's own. The preset's entry, run before the chain's entry (`intake`
 * before `build` until ORC-395, ORC-206), is that entry's guard: it hands over to it.
 */
function reached(wf: Workflow, from: Step): Step | null {
  if (from.id === wf.preset.entry && wf.entry !== from.id) return stepById(wf, wf.entry) ?? null;
  for (let s = stepById(wf, from.next); s; s = stepById(wf, s.next)) if (!passed(wf, s)) return s;
  return null;
}

/** The job of step `id` (and lens `lens`, for a review) that no cause starts. */
const jobOf = (jobs: readonly JobSpec[], id: string, lens?: string): JobSpec | undefined => jobs.find((j) => j.step === id && j.lens === lens && !j.cause);

/** The job that starts `step`: the first lens of a review, the only job of any other agent step. A fix only starts by its cause. */
export function startingJob(jobs: readonly JobSpec[], step: Step): JobSpec | undefined {
  if (!isAgentStep(step) || step.type === 'fix') return undefined;
  return jobOf(jobs, step.id, step.type === 'review' ? step.lenses[0] : undefined);
}

const jobStarting = (wf: Workflow, step: Step): JobSpec | undefined => startingJob(Object.values(wf.jobs), step);

/** `job` is the last lens of its review: it publishes the findings of every lens (ORC-183), and only it has the review's fix (ORC-184). */
export function publishesReview(wf: Workflow, job: JobSpec): boolean {
  const step = stepOfJob(wf, job);
  return step?.type === 'review' && !!job.lens && job.lens === step.lenses.at(-1);
}

/**
 * The end of `job`. A review lens hands over to the next lens of its step, on the same commit; the last one ends the step.
 * A relayed answer ends where it is: its commit, if any, goes the way of the reply's job (ORC-375). At the Rapide level
 * (ORC-231) nothing moves nor is posted: a replayed ticket is closed, nobody reads it. `gatePassed`: the human gate the walk
 * stops at has passed (`/approve`), the walk goes on from it.
 */
export function nextOf(wf: Workflow, job: JobSpec, gatePassed = false): JobEnd {
  const step = stepOfJob(wf, job);
  // The answer agent (ORC-182), out of the preset's steps: its reply.
  if (!step) return job.queue === 'questions' ? { post: 'reply' } : {};
  if (job.cause === 'relay') return { step: null };
  if (step.type === 'review' && job.lens) {
    const lens = step.lenses[step.lenses.indexOf(job.lens) + 1];
    const run = lens && jobOf(Object.values(wf.jobs), step.id, lens);
    if (run) return { run, step };
  }
  let next = reached(wf, step);
  if (gatePassed && next?.type === 'human_gate') next = reached(wf, next);
  const run = next ? jobStarting(wf, next) : undefined;
  if (wf.level === 'rapide') return { ...(run ? { run } : {}), step: next };
  // The chain's entry moves the ticket at its own launch (`startMove`), wherever it starts from: an end that reaches it does not.
  const move = next && next.id !== wf.entry ? STEP_STATUS[next.id] : undefined;
  const post = STEP_POST[step.id];
  return { ...(run ? { run } : {}), ...(move ? { move } : {}), ...(post ? { post } : {}), step: next };
}

/** The job a delegation starts (ORC-392): the one a test names (`delegated`), else the chain's entry's. */
export function delegatedJob(wf: Workflow): string | undefined {
  if (wf.delegated) return wf.delegated;
  const entry = stepById(wf, wf.entry);
  return entry && jobStarting(wf, entry)?.name;
}

/** The move the launch of `job` makes: the chain's entry shows its status from its first run on. */
export function startMove(wf: Workflow, job: JobSpec): LogicalState | undefined {
  return wf.level !== 'rapide' && job.step !== undefined && job.step === wf.entry ? STEP_STATUS[job.step] : undefined;
}

/**
 * The job a move owed by a refused publication came with (ORC-183): the job of the step whose status it is, the review's
 * first lens for AI Review.
 */
export function jobEntering(wf: Workflow, status: LogicalState): JobSpec | undefined {
  const step = wf.preset.steps.find((s) => STEP_STATUS[s.id] === status && s.id !== wf.entry);
  return step && jobStarting(wf, step);
}

/** The workflow has a review loop (ORC-184): a review whose blocking findings send the run back to `fix`. */
export function hasReviewLoop(wf: Workflow): boolean {
  return wf.preset.steps.some((s) => s.type === 'review' && !!s.onFailure);
}

/** The fix a blocking finding of `job` starts, on the review's failure edge: only the lens that publishes the review has one. */
export function blockingFix(wf: Workflow, job: JobSpec): JobSpec | undefined {
  const step = stepOfJob(wf, job);
  if (step?.type !== 'review' || !step.onFailure || !publishesReview(wf, job)) return undefined;
  const to = step.onFailure.goto;
  return Object.values(wf.jobs).find((j) => j.step === to && j.cause === 'review');
}

/**
 * Each start of `job` is a round of human review feedback (ORC-190): the fix the merge gate's failure edge sends the run to,
 * on its counter (`limits.humanReviewRounds`).
 */
export function humanRoundJob(wf: Workflow, job: JobSpec): boolean {
  return job.cause === 'human' && wf.preset.steps.some((s) => s.type === 'human_gate' && s.gate === 'merge' && s.onFailure?.goto === job.step);
}
