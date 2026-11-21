import { WORKFLOW_FORMAT, type JobSpec, type Limits, type RunLimits, type Workflow } from '../core/workflow.js';
import { blockingFix, entry, nextOf, REACTION_LINKS, reactionJob, startingJob } from '../core/chain.js';
import { UNLINKED_REACTION_JOBS } from '../core/engine.js';
import { factoryDefault } from './factory-default.js';
import { compilePreset, isAgentStep, mergeGate, type AgentStep, type Effort, type Preset } from './preset.js';
import { BINDINGS, type Binding } from './runtime-bindings.js';
import { perStepToolViolations, READ_TOOLS, stepTools } from './tools.js';

/**
 * The workflow of a preset, built in TypeScript (ORC-388, ORC-391): the preset itself, which `decide` walks (`step.next`),
 * and the jobs that run its agent steps (`BINDINGS`). What a human's event does is coded in `decide`, its default reactions
 * (ORC-392). A repository no longer overrides any of it: `.factory/workflow.yml` is ignored, and `factory doctor` says so.
 */

class WorkflowError extends Error {}

/** What `factory.yml` says of the agent steps (ORC-136), by step name. */
export interface StepSettings {
  effort?: { default?: Effort; perStep?: Record<string, Effort> | undefined } | undefined;
  budgets?: { maxTurns?: Record<string, number> | undefined; perStepTokens?: Record<string, number> | undefined } | undefined;
  /** The built-in tools of a step, in place of its default (ORC-383): never more than the step and its network allow. */
  tools?: { perStep?: Record<string, readonly string[]> | undefined } | undefined;
  /** The Linear status each step shows (ORC-382), by step name: it names the status the preset's table gives the step. */
  statuses?: Record<string, string> | undefined;
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

/** ORC-170's Linear statuses and Spec (ORC-457), which `factory.yml`'s `statuses` may rename, and Spec turn off (ORC-382). */
export const DEFAULT_STATES: Workflow['states'] = { todo: 'Todo', spec: 'Spec', dev: 'In Progress', human_review: 'Human Review', ai_review: 'AI Review', done: 'Done' };

/** The value of `factory.yml`'s `statuses` that turns a step's status off (ORC-457): the ticket keeps the status it had. */
const STATUS_OFF = 'off';

/** How factory.yml turns the spec's status off, as its messages say it. */
const SPEC_OFF = `statuses: { spec_draft: ${STATUS_OFF} }`;

/**
 * The Linear status of each logical state, with `factory.yml`'s `statuses` (ORC-382): a step names the status the table of
 * `factory/default` gives it, so that two steps of one status name the same, and one Linear status names one logical state
 * (a ticket read in it must be in one). Refused at load otherwise, as a step the preset does not have.
 */
function statesOf(statuses: Readonly<Record<string, string>> = {}): Workflow['states'] {
  const states: Workflow['states'] = { ...DEFAULT_STATES };
  const namedBy = new Map<string, string>();
  for (const [step, name] of Object.entries(statuses)) {
    const status = entry(preset.statuses, step);
    if (!status) {
      const withOne = Object.keys(preset.statuses).join(', ');
      const what = preset.steps.some((s) => s.id === step) ? 'shows no status of its own' : 'is not a step';
      throw new WorkflowError(`factory.yml: statuses.${step}: ${what} of ${preset.name} (the steps with one: ${withOne})`);
    }
    // The only status the factory can go without is the spec's: the ticket stays in Todo until `build` (ORC-212).
    // In any case: `Off` names no Linear status either.
    const off = name.toLowerCase() === STATUS_OFF;
    if (off && status !== 'spec') {
      throw new WorkflowError(`factory.yml: statuses.${step}: \`${STATUS_OFF}\` turns off only the status of spec_draft: the factory moves tickets to the others`);
    }
    const before = namedBy.get(status);
    if (before !== undefined && states[status] !== name) {
      throw new WorkflowError(`factory.yml: statuses.${step}: « ${name} », where ${before}, which shows the same status, names « ${states[status]} »`);
    }
    namedBy.set(status, step);
    if (off) delete states.spec;
    else states[status] = name;
  }
  const seen = new Map<string, string>();
  for (const [status, name] of Object.entries(states)) {
    const other = seen.get(name);
    if (other) {
      // A name factory.yml gave before Spec was a default (ORC-457).
      const spec = other === 'spec' || status === 'spec' ? ` (Spec is the spec's by default: rename it, or \`${SPEC_OFF}\`)` : '';
      throw new WorkflowError(`factory.yml: statuses: « ${name} » would name both ${other} and ${status}: a Linear status names one${spec}`);
    }
    seen.set(name, status);
  }
  return states;
}

/**
 * The warning of a project whose Linear team lacks statuses of `states` (ORC-382): a move to one would fail. Undefined when the
 * team has them all. « Connect Linear » creates the missing ones.
 */
export function missingStatusWarning(p: { id: string; teamKey: string }, states: Workflow['states'], team: readonly string[]): string | undefined {
  const missing = Object.values(states).filter((name) => !team.includes(name));
  if (!missing.length) return undefined;
  const names = missing.map((n) => `« ${n} »`).join(', ');
  // The spec's is the one status a project can turn off (ORC-457).
  const off = states.spec && missing.includes(states.spec) ? ` A ticket in its spec stays in Todo with \`${SPEC_OFF}\` in factory.yml.` : '';
  return `Warning: ${p.id}: the Linear team ${p.teamKey} has no status ${names}, which the factory moves tickets to (ORC-170's, or as \`statuses\` in factory.yml names them): a move to it fails. Connect Linear again to create it, or name a status the team has.${off}`;
}

/**
 * What a job takes from its agent step. The step sets the effort, `factory.yml` may change it; the step's turns are a
 * ceiling that `factory.yml` only lowers, as a step only narrows the network.
 */
function fromStep(step: AgentStep, own: RunLimits, settings: StepSettings): Pick<JobSpec, 'effort' | 'limits' | 'network' | 'tools'> {
  const tokens = settings.budgets?.perStepTokens?.[step.id];
  return {
    network: step.network,
    tools: settings.tools?.perStep?.[step.id] ?? stepTools(step),
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
 * What the loader of the former pack refused in a workflow, now that none goes through it: a job or the relayed answer that
 * names nothing, a job whose step the preset lacks, a review whose fix does not read the findings; and a job a reaction of
 * `decide` starts that the workflow lacks, or a link of the preset it reads that starts none (but at the Rapide level, where
 * only the delegation reacts).
 */
export function workflowViolations(wf: Workflow): string[] {
  const out: string[] = [];
  const job = (where: string, name: string | undefined) => {
    if (name !== undefined && !Object.hasOwn(wf.jobs, name)) out.push(`${where}: unknown job "${name}"`);
  };
  const steps = new Set(wf.preset.steps.map((s) => s.id));
  for (const j of Object.values(wf.jobs)) {
    if (j.step !== undefined && !steps.has(j.step)) out.push(`jobs.${j.name}.step: ${j.step} is not a step of ${wf.preset.name}`);
    // A step reached on the way that has no job starts nothing: the chain would stop there silently.
    const next = nextOf(wf, j);
    if (next.step && isAgentStep(next.step) && !next.run) out.push(`jobs.${j.name}: its end reaches ${next.step.id}, which has no job`);
    const fix = blockingFix(wf, j);
    if (fix && fix.input !== 'findings') out.push(`jobs.${j.name}: the review's fix "${fix.name}" must be a job that reads the findings`);
  }
  const entry = wf.preset.steps.find((s) => s.id === wf.entry);
  if (!entry) out.push(`entry: ${wf.entry} is not a step of ${wf.preset.name}`);
  // A delegation starts the entry's job: an entry without one would start nothing, silently.
  else if (!startingJob(Object.values(wf.jobs), entry)) out.push(`entry: ${wf.entry} has no job that starts it`);
  job('relayJob', wf.relayJob);
  if (wf.level !== 'rapide') {
    for (const name of UNLINKED_REACTION_JOBS) job('reactions', name);
    // The other reactions read their job on the preset's links (ORC-417): a link to no job would start nothing, silently.
    // A link absent (a merge gate with no way back) starts nothing, by design: only a link to no job is refused.
    for (const link of REACTION_LINKS) if (reactionJob(wf, link) === undefined) out.push(`reactions: ${link} starts no job`);
    // A question relayed to the agent that implements starts its job: only the Rapide level, where nobody asks, has none.
    if (wf.relayJob === undefined) out.push('relayJob: missing, the questions relayed to the agent that implements would start no job');
  }
  return out;
}

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
  // The bounds of the loops, read on the edges that take them: red CI's (the review and CI loop), the merge gate's (human review).
  const merge = mergeGate(p);
  const limits: Limits = {
    perRun,
    // `verifyAttempts` counts every check: the preset's returns to the run, plus the first one.
    verifyAttempts: presetBound(p, 'verify') + 1,
    ciFixAttempts: presetBound(p, p.redCi.counter),
    // None for a loop the preset does not have (`factory/fantome`: no merge gate, a spec the preset approves).
    humanReviewRounds: (merge?.onFailure && boundOf(p, merge.onFailure.counter)) ?? 0,
    repeatedFailures: p.sameFailure.limit,
    silentAfterMs: p.silentRun.minutes * 60_000,
    specCheckReturns: presetBound(p, 'spec_check'),
    specChanges: boundOf(p, 'spec_review') ?? 0,
  };
  const relay = jobs.find((j) => j.cause === 'relay');
  const wf: Workflow = {
    version: WORKFLOW_FORMAT,
    ...(p.level ? { level: p.level } : {}),
    tracker: { kind: 'linear', pickup: { checks: p.guard.checks } },
    states: statesOf(settings.statuses),
    limits,
    workspace: { setup: [], portBase: 4200 },
    // The answer agent at every level: a question in a ticket's thread starts it directly (`askInThread`).
    jobs: Object.fromEntries([...jobs, ASK].map((j) => [j.name, j])),
    ...(relay ? { relayJob: relay.name } : {}),
    preset: p,
    entry,
  };
  const refused = workflowViolations(wf);
  if (refused.length) throw new WorkflowError(`preset ${p.name}: ${refused.join('; ')}`);
  // A copy of its own on each call, its preset, limits and jobs included: a test that changes one changes no other (ORC-389).
  return structuredClone(wf);
}

/**
 * The workflow of `factory/default`. A delegation starts at the preset's entry (ORC-395): `intake`, then the spec and its human
 * gate, the tests, the red check and the freeze, before `build`.
 */
export function defaultWorkflow(settings: StepSettings = {}): Workflow {
  return presetWorkflow(preset, settings);
}
