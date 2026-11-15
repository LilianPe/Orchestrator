import type { JobSpec, RunLimits, Workflow } from '../core/workflow.js';
import type { Condition } from '../core/conditions.js';
import { factoryDefault } from './factory-default.js';
import { compilePreset, isAgentStep, type Effort, type Preset, type Step } from './preset.js';
import { perStepToolViolations, READ_TOOLS, stepTools } from './tools.js';

/**
 * The workflow of `factory/default`, built in TypeScript (ORC-388): its jobs and its rules are the ones the standard pack
 * held until ORC-389 removed it, its bounds and each job's effort, turns, network and tools are the preset's. A repository no longer overrides any
 * of it: `.factory/workflow.yml` is ignored, and `factory doctor` says so. The engine still runs jobs and rules, until it
 * walks the preset's steps itself (ORC-391, ORC-392).
 */

export class WorkflowError extends Error {}

/** What `factory.yml` says of the agent steps (ORC-136), by step name. */
export interface StepSettings {
  effort?: { default?: Effort; perStep?: Record<string, Effort> | undefined } | undefined;
  budgets?: { maxTurns?: Record<string, number> | undefined; perStepTokens?: Record<string, number> | undefined } | undefined;
  /** The built-in tools of a step, in place of its default (ORC-383): never more than the step and its network allow. */
  tools?: { perStep?: Record<string, readonly string[]> | undefined } | undefined;
}

// Compiled once, at load: a preset that breaks an invariant of the core never reaches the engine.
export const preset = compilePreset(factoryDefault).preset;

/** The limit of a counter of the preset, which the engine still reads through `limits` (ORC-187). */
export function presetBound(p: Preset, counter: string): number {
  const found = Object.hasOwn(p.counters, counter) ? p.counters[counter] : undefined;
  if (!found) throw new WorkflowError(`preset ${p.name}: counter ${counter} is missing`);
  return found.limit;
}

export const agentStep = (name: string): Extract<Step, { maxTurns: number }> | undefined => {
  const step = preset.steps.find((s) => s.id === name);
  return step && isAgentStep(step) ? step : undefined;
};

/** A step named in `factory.yml` that the preset does not have would silently cap nothing. */
export function checkStepSettings({ effort, budgets, tools }: StepSettings): void {
  const named = { 'claude.effort.per_step': effort?.perStep, 'budgets.max_turns': budgets?.maxTurns, 'budgets.per_step_tokens': budgets?.perStepTokens, 'tools.per_step': tools?.perStep };
  for (const [where, steps] of Object.entries(named)) {
    for (const name of Object.keys(steps ?? {})) {
      if (!agentStep(name)) throw new WorkflowError(`factory.yml: ${where}.${name}: not an agent step of ${preset.name}`);
    }
  }
  // Refused at load, as a network wider than the repository's: a list never gives a step more than it may have (ORC-383).
  const refused = perStepToolViolations(tools?.perStep ?? {}, preset.steps, preset.name);
  if (refused.length) throw new WorkflowError(refused.map((r) => `factory.yml: ${r}`).join('\n'));
}

/**
 * What a job takes from its agent step. The step sets the effort, `factory.yml` may change it; the step's turns are a
 * ceiling that `factory.yml` only lowers, as a step only narrows the network.
 */
export function fromStep(step: Extract<Step, { maxTurns: number }>, own: RunLimits, settings: StepSettings): Pick<JobSpec, 'effort' | 'limits' | 'network' | 'tools'> {
  const tools = settings.tools?.perStep?.[step.id] ?? stepTools(step);
  const tokens = settings.budgets?.perStepTokens?.[step.id];
  return {
    network: step.network,
    ...(tools ? { tools } : {}),
    effort: settings.effort?.perStep?.[step.id] ?? step.effort,
    limits: { ...own, turns: Math.min(own.turns, step.maxTurns, settings.budgets?.maxTurns?.[step.id] ?? Infinity), ...(tokens !== undefined ? { tokens } : {}) },
  };
}

/** The ceiling of a run with no limits of its own: the turns before the preset's, and its duration. */
export const PER_RUN: Readonly<RunLimits> = { turns: 150, durationMs: 90 * 60_000 };

/** A job of an agent step, before what it takes from that step. */
type StepJob = Omit<JobSpec, 'name' | 'step' | 'verify' | 'verifyFailure' | 'pickup' | 'onStart' | 'onSuccess' | 'effort' | 'limits' | 'network' | 'tools'> &
  Partial<Pick<JobSpec, 'pickup' | 'onStart' | 'onSuccess'>> & { step: string };

function stepJob(name: string, job: StepJob, settings: StepSettings): JobSpec {
  const step = agentStep(job.step);
  if (!step) throw new WorkflowError(`jobs.${name}.step: ${job.step} is not an agent step of ${preset.name}`);
  const { queue, model, workspace, session, skill, lens, input, repoChecks, pickup = false, structuredOutput, red, onStart = {}, onSuccess = {}, onBlocking, counter } = job;
  // In the order the pack's loader gave: a replay journal pins the workflow as JSON text, keys in their order (ORC-389).
  return {
    name, step: job.step, queue, model, workspace, session, skill, ...(lens ? { lens } : {}), input, verify: [], ...(repoChecks ? { repoChecks } : {}),
    pickup, structuredOutput, ...(red ? { red } : {}), ...fromStep(step, PER_RUN, settings), onStart, onSuccess,
    ...(onBlocking ? { onBlocking } : {}), ...(counter ? { counter } : {}),
  };
}

const REGROUPED_MS = 3 * 60_000;

const blocked: Condition = [{ kind: 'blocked', negate: false }];
const notBlocked = { kind: 'blocked', negate: true } as const;

/**
 * The rules: what starts a job, and what a human's event does. `whenSrc` is the condition as the pack wrote it, traced and
 * hashed. Read only, as the whole workflow: the daemon hands the same one to every project.
 */
const RULES: Workflow['on'] = {
  'ticket.delegated': [{ when: [{ kind: 'state_in', values: ['todo', 'dev'] }, notBlocked], whenSrc: 'state in [todo, dev] && !blocked', run: 'dev' }],
  // The review starts once a job that writes is published (its `onSuccess`). This rule reviews the published commit again:
  // a merge refused for a push since the review starts its job (ORC-148), and so does a human's move to AI Review.
  'status.changed': [{ to: 'ai_review', run: 'review' }],
  // A reply in the ticket's session; a review written on the PR (`pr.reviewed`) goes through these rules too (ORC-190).
  // In Human Review, it is a round of human feedback: `fix-human`, on its own counter (`limits.humanReviewRounds`).
  'session.prompted': [
    { when: blocked, whenSrc: 'blocked', run: 'dev-feedback', debounceMs: 0 },
    { when: [{ kind: 'state_in', values: ['human_review'] }], whenSrc: 'state in [human_review]', run: 'fix-human', debounceMs: REGROUPED_MS },
    { when: [{ kind: 'state_in', values: ['dev'] }], whenSrc: 'state in [dev]', run: 'dev-feedback', debounceMs: REGROUPED_MS },
  ],
  // A reply to the blocking comment, written on the ticket. `dev-feedback` stands for a block with no step of its own (ORC-196).
  'ticket.commented': [{ when: blocked, whenSrc: 'blocked', run: 'dev-feedback' }],
  // A mention asks a question. The memory in writing sleeps (ORC-193): a `retiens` is a message as any other.
  'session.mentioned': [{ run: 'ask' }],
  'label.changed': [{ label: 'agent:stop', do: 'stop' }],
  'session.stopped': [{ do: 'stop' }],
  // Red CI, merge gate included: `fix-ci`, one round of the review and CI loop (`limits.ciFixAttempts`, ORC-184).
  'pr.checks_failed': [{ when: [{ kind: 'state_in', values: ['human_review', 'ai_review'] }, notBlocked], whenSrc: 'state in [human_review, ai_review] && !blocked', run: 'fix-ci' }],
  // A conflict of the PR with the default branch (ORC-146): the rebase step, on the counter of red CI. During another step,
  // the rebase waits for that work to end: the agent at work never resolves the conflict.
  'pr.conflicted': [{ when: [{ kind: 'state_in', values: ['dev', 'human_review', 'ai_review'] }, notBlocked], whenSrc: 'state in [dev, human_review, ai_review] && !blocked', run: 'rebase' }],
  // The `after_merge` step (ORC-197): the requester mentioned with the merged PR's link, the changelog entry, then the cleanup.
  // It starts no run: the memory in writing sleeps (ORC-193).
  'pr.merged': [{ move: 'done', do: 'after_merge' }],
};

/** The jobs and the rules of `factory/default`, with `factory.yml`'s settings of its agent steps (ORC-136, ORC-383). */
export function defaultWorkflow(settings: StepSettings = {}): Workflow {
  checkStepSettings(settings);
  // The build: published, then the AI review (ORC-183), whose end shows the PR in Human Review. Every job that writes code
  // runs the repository's commands and the checks of the diff in a fresh clone (ORC-151).
  const dev: StepJob = {
    step: 'build', queue: 'dev', model: 'sonnet', workspace: 'worktree', session: 'new', skill: 'factory:dev',
    pickup: true, structuredOutput: true, repoChecks: true,
    onStart: { move: 'dev' }, onSuccess: { move: 'ai_review', post: 'summary', run: 'review' },
  };
  // A reply that resumes the ticket's session in its worktree. Its commit goes back through `verify`, `publish` and the AI
  // review, as every fix of the loop (ORC-184, ORC-190): no work of the factory waits for a human move (ORC-170).
  const feedback: StepJob = {
    ...dev, step: 'fix', structuredOutput: false, session: 'resume', skill: 'factory:feedback', input: 'feedback',
    pickup: false, onStart: {}, onSuccess: { move: 'ai_review', post: 'reply', run: 'review' },
  };
  const { repoChecks: _checks, ...answer } = feedback;
  const review: StepJob = {
    step: 'review', queue: 'dev', model: 'opus', workspace: 'published', session: 'new', skill: 'factory:review',
    lens: 'correctness', structuredOutput: true, onSuccess: { run: 'review-security' },
  };
  const jobs: Record<string, StepJob> = {
    // `intake` (ORC-206), on a fresh clone of the trunk; off until a rule runs it.
    intake: { step: 'intake', queue: 'dev', model: 'sonnet', workspace: 'trunk-readonly', session: 'new', skill: 'factory:intake', structuredOutput: true, onSuccess: { run: 'dev' } },
    dev,
    // `spec_draft` (ORC-212): the spec through `submit_result`; off until a rule runs it.
    spec: { step: 'spec_draft', queue: 'dev', model: 'sonnet', workspace: 'worktree', session: 'new', skill: 'factory:spec', structuredOutput: true, onSuccess: { run: 'tests' } },
    // `tests` (ORC-123), then the `red` check in measure mode; the ticket session starts here (ORC-217). Off until a rule runs it.
    tests: {
      ...dev, step: 'tests', structuredOutput: false, skill: 'factory:tests', session: 'resume', pickup: false,
      red: { command: 'npm test --', mode: 'measure', attempts: presetBound(preset, 'red') + 1 }, onSuccess: { run: 'dev' },
    },
    'dev-feedback': feedback,
    'fix-ci': { ...feedback, skill: 'factory:fix-ci', input: 'ci_failures' },
    // The blocking findings of the last review, each fixed or contested (`submit_result`'s `fixed` and `contested`).
    'fix-review': { ...feedback, input: 'findings', structuredOutput: true },
    // Human review feedback: each start is a round of the preset's `human_review` (ORC-190).
    'fix-human': { ...feedback, counter: 'human_review' },
    // The answer to questions relayed to the agent that implements (ORC-375): no round, no check, nothing moved or posted.
    'answer-relayed': { ...answer, onSuccess: {} },
    // The rebase (ORC-146): its commit goes through `verify`, then over the head the factory published. It moves and posts nothing.
    rebase: { ...dev, step: 'rebase', session: 'resume', skill: 'factory:rebase', pickup: false, onStart: {}, onSuccess: {} },
    // Two read-only lenses (ORC-183); a blocking finding starts `fix-review` instead of the move (ORC-184).
    review,
    'review-security': { ...review, lens: 'security', onSuccess: { move: 'human_review', post: 'review' }, onBlocking: { run: 'fix-review' } },
  };
  // A copy of its own on each call, its rules, limits and jobs included: a test that changes one changes no other (ORC-389).
  return structuredClone<Workflow>({
    version: 1,
    blockComment: true,
    tracker: { kind: 'linear', pickup: { checks: ['has_description', 'not_started'] } },
    states: { todo: 'Todo', dev: 'In Progress', human_review: 'Human Review', ai_review: 'AI Review', done: 'Done' },
    limits: {
      // Read by nothing since ORC-390 (`concurrency` of factory.yml, a fixed 2 for the questions): kept, as hashed in the journals.
      parallelSessions: 3,
      questionSessions: 2,
      perRun: PER_RUN,
      // `verifyAttempts` counts every check: the preset's returns to the run, plus the first one.
      verifyAttempts: presetBound(preset, 'verify') + 1,
      ciFixAttempts: presetBound(preset, 'review_ci'),
      humanReviewRounds: presetBound(preset, 'human_review'),
      repeatedFailures: preset.sameFailure.limit,
      silentAfterMs: preset.silentRun.minutes * 60_000,
      specCheckReturns: presetBound(preset, 'spec_check'),
      specChanges: presetBound(preset, 'spec_review'),
    },
    workspace: { setup: [], portBase: 4200 },
    commands: [],
    on: RULES,
    jobs: {
      ...Object.fromEntries(Object.entries(jobs).map(([name, job]) => [name, stepJob(name, job, settings)])),
      // The answer agent (ORC-182), out of the preset's steps: a question starts it at once in the questions queue. It reads,
      // on a clone of the trunk, at network claude-api, and writes nothing; what it cannot answer, it relays.
      ask: {
        name: 'ask', queue: 'questions', model: 'sonnet', workspace: 'trunk-readonly', session: 'new', skill: 'factory:ask', input: 'thread',
        verify: [], pickup: false, effort: 'low', network: 'claude-api', tools: READ_TOOLS,
        limits: { turns: 30, durationMs: 5 * 60_000, tokens: 200_000 }, onStart: {}, onSuccess: { post: 'reply' },
      },
    },
    relayJob: 'answer-relayed',
  });
}
