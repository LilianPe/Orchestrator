import type { JobSpec, Limits, RunLimits, Workflow } from '../core/workflow.js';
import type { Condition } from '../core/conditions.js';
import { blockingFix, nextOf, startingJob } from '../core/chain.js';
import { factoryDefault } from './factory-default.js';
import { compilePreset, isAgentStep, type AgentStep, type Effort, type Preset } from './preset.js';
import { BINDINGS, type Binding } from './runtime-bindings.js';
import { perStepToolViolations, READ_TOOLS, stepTools } from './tools.js';

/**
 * The workflow of a preset, built in TypeScript (ORC-388, ORC-391): the preset itself, which `decide` walks (`step.next`),
 * the jobs that run its agent steps (`BINDINGS`), and the rules a human's event follows until they are coded in `decide`
 * (ORC-392). A repository no longer overrides any of it: `.factory/workflow.yml` is ignored, and `factory doctor` says so.
 */

class WorkflowError extends Error {}

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
function presetBound(p: Preset, counter: string): number {
  const found = boundOf(p, counter);
  if (found === undefined) throw new WorkflowError(`preset ${p.name}: counter ${counter} is missing`);
  return found;
}

const boundOf = (p: Preset, counter: string): number | undefined => (Object.hasOwn(p.counters, counter) ? p.counters[counter]!.limit : undefined);

const agentStepOf = (p: Preset, name: string): AgentStep | undefined => {
  const step = p.steps.find((s) => s.id === name);
  return step && isAgentStep(step) ? step : undefined;
};

/** An agent step of `factory/default`, the instance's preset, whose steps `factory.yml` names. */
export const agentStep = (name: string): AgentStep | undefined => agentStepOf(preset, name);

/** A step named in `factory.yml` that the preset does not have would silently cap nothing. */
function checkStepSettings({ effort, budgets, tools }: StepSettings): void {
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
function fromStep(step: AgentStep, own: RunLimits, settings: StepSettings): Pick<JobSpec, 'effort' | 'limits' | 'network' | 'tools'> {
  const tools = settings.tools?.perStep?.[step.id] ?? stepTools(step);
  const tokens = settings.budgets?.perStepTokens?.[step.id];
  return {
    network: step.network,
    ...(tools ? { tools } : {}),
    effort: settings.effort?.perStep?.[step.id] ?? step.effort,
    limits: { ...own, turns: Math.min(own.turns, step.maxTurns, settings.budgets?.maxTurns?.[step.id] ?? Infinity), ...(tokens !== undefined ? { tokens } : {}) },
  };
}

/** The turns of a run with no limits of its own, before its step's: the former `limits.per_run.turns` of the standard pack. */
const PER_RUN_TURNS = 150;

/** The skill of a job: its step's, or the one of its cause for a fix. */
function skillOf(step: AgentStep, b: Binding): string {
  const skill = step.type === 'fix' ? (b.cause ? step.skills[b.cause] : undefined) : step.skill;
  if (!skill) throw new WorkflowError(`step ${step.id}: no skill for ${b.cause ? `the cause ${b.cause}` : 'its job'}`);
  return skill;
}

/** The red check after a job (ORC-123): the `red` step its step leads to, its mode, and its checks (its counter's returns, plus the first). */
function redOf(p: Preset, step: AgentStep): JobSpec['red'] {
  const red = p.steps.find((s) => s.id === step.next);
  if (red?.type !== 'verify' || red.mode !== 'red' || !red.red || !red.onFailure) return undefined;
  return { mode: red.red, attempts: presetBound(p, red.onFailure.counter) + 1 };
}

function jobOf(p: Preset, name: string, b: Binding, perRun: RunLimits, settings: StepSettings): JobSpec | undefined {
  const step = agentStepOf(p, b.step);
  if (!step || (b.lens && (step.type !== 'review' || !step.lenses.includes(b.lens)))) return undefined;
  const { step: _step, queue, model, workspace, session, lens, cause, input, repoChecks, pickup, structuredOutput, ...rest } = b;
  // Every field is named above, or a field added to `Binding` would be lost: none may be left over.
  const _none: Record<string, never> = rest;
  const red = redOf(p, step);
  return {
    name, step: step.id, queue, model, workspace, session, skill: skillOf(step, b), lens, cause, input, verify: [], repoChecks,
    pickup, structuredOutput, red, ...fromStep(step, perRun, settings),
  };
}

/**
 * What the loader of the former pack refused in a workflow, now that none goes through it: a rule, a job or the relayed
 * answer that names nothing, a job whose step the preset lacks, a review whose fix does not read the findings,
 * `after_merge` on another event than `pr.merged`.
 */
export function workflowViolations(wf: Workflow): string[] {
  const out: string[] = [];
  const job = (where: string, name: string | undefined) => {
    if (name !== undefined && !Object.hasOwn(wf.jobs, name)) out.push(`${where}: unknown job "${name}"`);
  };
  const state = (where: string, s: string | undefined) => {
    if (s !== undefined && !Object.hasOwn(wf.states, s)) out.push(`${where}: no status for "${s}"`);
  };
  for (const [type, rules] of Object.entries(wf.on)) {
    for (const [i, r] of (rules ?? []).entries()) {
      const at = `on.${type}[${i}]`;
      job(`${at}.run`, r.run);
      for (const k of ['move', 'from', 'to'] as const) state(`${at}.${k}`, r[k]);
      if (r.do === 'after_merge' && type !== 'pr.merged') out.push(`${at}.do: after_merge is the step of a merged PR, on pr.merged only`);
    }
  }
  const steps = new Set(wf.preset?.steps.map((s) => s.id));
  for (const j of Object.values(wf.jobs)) {
    if (j.step !== undefined && !steps.has(j.step)) out.push(`jobs.${j.name}.step: ${j.step} is not a step of ${wf.preset?.name ?? 'the workflow'}`);
    // A step reached on the way that has no job starts nothing: the chain would stop there silently.
    const next = nextOf(wf, j);
    if (next.step && isAgentStep(next.step) && !next.run) out.push(`jobs.${j.name}: its end reaches ${next.step.id}, which has no job`);
    const fix = blockingFix(wf, j);
    if (fix && fix.input !== 'findings') out.push(`jobs.${j.name}: the review's fix "${fix.name}" must be a job that reads the findings`);
  }
  if (wf.entry !== undefined && !steps.has(wf.entry)) out.push(`entry: ${wf.entry} is not a step of ${wf.preset?.name ?? 'the workflow'}`);
  job('relayJob', wf.relayJob);
  return out;
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
  // The review starts once a step that writes is published (its `next`). This rule reviews the published commit again:
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
  // A step of the factory, with no agent: the memory in writing sleeps (ORC-193).
  'pr.merged': [{ move: 'done', do: 'after_merge' }],
};

/**
 * The rules of a preset at the Rapide level (ORC-231): its delegation alone. A replayed ticket is closed (Done), and nothing
 * a human does on the real one starts any job of its run.
 */
const rapideRules = (entryJob: string): Workflow['on'] => ({ 'ticket.delegated': [{ when: [notBlocked], whenSrc: '!blocked', run: entryJob }] });

/**
 * The answer agent (ORC-182), out of the preset's steps: a question starts it at once in the questions queue. It reads, on a
 * clone of the trunk, at network claude-api, and writes nothing; what it cannot answer, it relays.
 */
const ASK: JobSpec = {
  name: 'ask', queue: 'questions', model: 'sonnet', workspace: 'trunk-readonly', session: 'new', skill: 'factory:ask', input: 'thread',
  verify: [], pickup: false, effort: 'low', network: 'claude-api', tools: READ_TOOLS, limits: { turns: 30, durationMs: 5 * 60_000, tokens: 200_000 },
};

/**
 * The workflow of preset `p`, with `factory.yml`'s settings of its agent steps (ORC-136, ORC-383), which name the steps of
 * `factory/default`, the instance's preset. `entry`: the step the chain starts at, the preset's own by default.
 */
export function presetWorkflow(given: Preset, settings: StepSettings = {}, entry: string = given.entry): Workflow {
  // Compiled here too: the walk of its steps relies on the invariants of the core (no cycle of `next`, every edge to a step).
  const p = compilePreset(given).preset;
  checkStepSettings(settings);
  const perRun: RunLimits = { turns: PER_RUN_TURNS, durationMs: p.attempt.minutes * 60_000 };
  const jobs = Object.entries(BINDINGS).flatMap(([name, b]) => jobOf(p, name, b, perRun, settings) ?? []);
  const entryStep = p.steps.find((s) => s.id === entry);
  const entryJob = entryStep && startingJob(jobs, entryStep);
  if (!entryJob) throw new WorkflowError(`preset ${p.name}: its entry ${entry} has no job`);
  const rapide = p.level === 'rapide';
  // The bounds of the loops, read on the edges that take them: red CI's (the review and CI loop), the merge gate's (human review).
  const merge = p.steps.find((s) => s.type === 'human_gate' && s.gate === 'merge');
  const humanRounds = merge?.onFailure && boundOf(p, merge.onFailure.counter);
  const specChanges = boundOf(p, 'spec_review');
  const limits: Limits = {
    perRun,
    // `verifyAttempts` counts every check: the preset's returns to the run, plus the first one.
    verifyAttempts: presetBound(p, 'verify') + 1,
    ciFixAttempts: presetBound(p, p.redCi.counter),
    ...(humanRounds !== undefined ? { humanReviewRounds: humanRounds } : {}),
    repeatedFailures: p.sameFailure.limit,
    silentAfterMs: p.silentRun.minutes * 60_000,
    specCheckReturns: presetBound(p, 'spec_check'),
    ...(specChanges !== undefined ? { specChanges } : {}),
  };
  const relay = jobs.find((j) => j.cause === 'relay');
  const wf: Workflow = {
    version: 1,
    blockComment: true,
    ...(p.level ? { level: p.level } : {}),
    tracker: { kind: 'linear', pickup: { checks: p.guard.checks } },
    states: { todo: 'Todo', dev: 'In Progress', human_review: 'Human Review', ai_review: 'AI Review', done: 'Done' },
    limits,
    workspace: { setup: [], portBase: 4200 },
    commands: [],
    on: rapide ? rapideRules(entryJob.name) : RULES,
    // The answer agent at every level: a question in a ticket's thread starts it directly, with no rule (`askInThread`).
    jobs: Object.fromEntries([...jobs, ASK].map((j) => [j.name, j])),
    ...(relay ? { relayJob: relay.name } : {}),
    preset: p,
    entry,
  };
  const refused = workflowViolations(wf);
  if (refused.length) throw new WorkflowError(`preset ${p.name}: ${refused.join('; ')}`);
  // A copy of its own on each call, its preset, rules, limits and jobs included: a test that changes one changes no other (ORC-389).
  return structuredClone(wf);
}

/**
 * The workflow of `factory/default`. Its chain starts at `build` until the delegation starts at the preset's entry (ORC-395):
 * `intake`, when a test or a project runs it, is the guard before `build` (ORC-206) and hands over to it.
 */
export function defaultWorkflow(settings: StepSettings = {}): Workflow {
  return presetWorkflow(preset, settings, 'build');
}
