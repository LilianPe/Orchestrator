import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { parseCondition } from '../core/conditions.js';
import { parseDuration } from '../core/duration.js';
import { RENAMED_V1, type EventType, type LogicalState } from '../core/types.js';
import { factoryDefault } from '../presets/factory-default.js';
import { compilePreset, isAgentStep, type Effort, type Preset, type Step } from '../presets/preset.js';
import {
  rawWorkflowSchema,
  type JobSpec,
  type RawJob,
  type RawWorkflow,
  type Rule,
  type RunLimits,
  type Workflow,
} from './workflow-schema.js';

export class WorkflowError extends Error {}

const EVENT_TYPES: readonly string[] = [
  'ticket.delegated', 'session.mentioned', 'session.prompted', 'session.stopped', 'status.changed', 'label.changed',
  'ticket.commented', 'push.human', 'command', 'pr.opened', 'pr.checks_passed', 'pr.checks_failed', 'pr.conflicted', 'pr.merged', 'pr.closed', 'run.finished',
  'verify.passed', 'verify.failed', 'timer.fired', 'control.pause', 'control.resume', 'control.stop',
];

/** Former event names, still accepted as `on` keys: those of version 1, and `debounce.fired` of version 2 (ORC-161). */
const FORMER_NAMES: Readonly<Record<string, EventType>> = { ...RENAMED_V1, 'debounce.fired': 'timer.fired' };

function renameOn(file: string, raw: RawWorkflow): RawWorkflow {
  if (!raw.on) return raw;
  const on = raw.on;
  for (const [former, current] of Object.entries(FORMER_NAMES)) {
    if (former in on && current in on) throw new WorkflowError(`${file}: on.${former}: same event as on.${current}, keep only one`);
  }
  return { ...raw, on: Object.fromEntries(Object.entries(on).map(([k, rules]) => [FORMER_NAMES[k] ?? k, rules])) };
}

function readRaw(file: string): RawWorkflow {
  const doc = parse(readFileSync(file, 'utf8')) ?? {};
  const res = rawWorkflowSchema.safeParse(doc);
  if (!res.success) {
    const issue = res.error.issues[0]!;
    throw new WorkflowError(`${file}: ${issue.path.join('.')}: ${issue.message}`);
  }
  return renameOn(file, res.data);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out as T;
}

function mergeRaw(pack: RawWorkflow, project: RawWorkflow | undefined): RawWorkflow {
  if (!project) return pack;
  const { on: pOn, jobs: pJobs, ...rest } = project;
  const merged = deepMerge({ ...pack, on: undefined, jobs: undefined }, rest) as RawWorkflow;
  merged.on = { ...(pack.on ?? {}), ...(pOn ?? {}) };
  const jobs: Record<string, RawJob> = { ...(pack.jobs ?? {}) };
  for (const [name, job] of Object.entries(pJobs ?? {})) jobs[name] = deepMerge(jobs[name] ?? {}, job);
  merged.jobs = jobs;
  return merged;
}

function resolveJob(name: string, jobs: Record<string, RawJob>, seen: string[] = []): RawJob {
  const job = jobs[name];
  if (!job) throw new WorkflowError(`jobs.${name}: unknown job`);
  if (!job.extends) return job;
  if (seen.includes(name)) throw new WorkflowError(`jobs.${name}.extends: cycle`);
  const parent = resolveJob(job.extends, jobs, [...seen, name]);
  const { extends: _e, ...own } = job;
  const merged = deepMerge(parent, own);
  // on_start / on_success replace the parent's value instead of merging into it.
  if (own.on_start !== undefined) merged.on_start = own.on_start;
  if (own.on_success !== undefined) merged.on_success = own.on_success;
  return merged;
}

/** What `factory.yml` says of the agent steps (ORC-136), by step name. */
export interface StepSettings {
  effort?: { default?: Effort; perStep?: Record<string, Effort> | undefined } | undefined;
  budgets?: { maxTurns?: Record<string, number> | undefined; perStepTokens?: Record<string, number> | undefined } | undefined;
}

const agentStep = (name: string): Extract<Step, { maxTurns: number }> | undefined => {
  const step = preset.steps.find((s) => s.id === name);
  return step && isAgentStep(step) ? step : undefined;
};

/**
 * The job's effort and caps. Its step sets the effort, `factory.yml` may change it; the step's turns are a ceiling that a
 * project or `factory.yml` only lowers, as a step only narrows the network. A job out of the preset keeps its own limits.
 */
function stepFields(job: string, raw: RawJob, own: RunLimits, settings: StepSettings): Pick<JobSpec, 'effort' | 'limits' | 'network'> {
  const name = raw.step;
  // Read by the AI review only (ORC-183): the rest of the review's contract is the preset's step.
  if ((name === 'review') !== !!raw.lens) throw new WorkflowError(`jobs.${job}.lens: a job of the review step has one, and only it`);
  if (raw.on_success?.post === 'review' && name !== 'review') throw new WorkflowError(`jobs.${job}.on_success.post: review publishes the findings of a job of the review step`);
  if ((name === 'review') !== (raw.workspace === 'published')) throw new WorkflowError(`jobs.${job}.workspace: published is the AI review's, and only a job of the review step has it`);
  if (name === undefined) return { ...(settings.effort?.default ? { effort: settings.effort.default } : {}), limits: own };
  const step = agentStep(name);
  if (!step) throw new WorkflowError(`jobs.${job}.step: ${name} is not an agent step of ${preset.name}`);
  const tokens = settings.budgets?.perStepTokens?.[name];
  return {
    network: step.network,
    effort: settings.effort?.perStep?.[name] ?? step.effort,
    limits: { ...own, turns: Math.min(own.turns, step.maxTurns, settings.budgets?.maxTurns?.[name] ?? Infinity), ...(tokens !== undefined ? { tokens } : {}) },
  };
}

/** A step named in `factory.yml` that the preset does not have would silently cap nothing. */
function checkStepSettings({ effort, budgets }: StepSettings): void {
  const named = { 'claude.effort.per_step': effort?.perStep, 'budgets.max_turns': budgets?.maxTurns, 'budgets.per_step_tokens': budgets?.perStepTokens };
  for (const [where, steps] of Object.entries(named)) {
    for (const name of Object.keys(steps ?? {})) {
      if (!agentStep(name)) throw new WorkflowError(`factory.yml: ${where}.${name}: not an agent step of ${preset.name}`);
    }
  }
}

function limits(raw: { turns?: number; duration?: string | number } | undefined, base: RunLimits): RunLimits {
  return {
    turns: raw?.turns ?? base.turns,
    durationMs: raw?.duration !== undefined ? parseDuration(raw.duration) : base.durationMs,
  };
}

function buildJob(name: string, raw: RawJob, perRun: RunLimits, settings: StepSettings): JobSpec {
  const need = <K extends keyof RawJob>(k: K): NonNullable<RawJob[K]> => {
    const v = raw[k];
    if (v === undefined) throw new WorkflowError(`jobs.${name}.${String(k)}: required`);
    return v as NonNullable<RawJob[K]>;
  };
  const missing = (k: string): never => {
    throw new WorkflowError(`jobs.${name}.${k}: required`);
  };
  // Conservative (ORC-217): only the implementer (`dev` queue) resumes, and mounts, the ticket session.
  if (raw.queue === 'questions' && raw.session === 'resume') {
    throw new WorkflowError(`jobs.${name}.session: a questions job cannot resume the ticket session, only a dev job can`);
  }
  return {
    name,
    ...(raw.step ? { step: raw.step } : {}),
    queue: need('queue'),
    model: need('model'),
    workspace: need('workspace'),
    session: raw.session ?? 'new',
    skill: need('skill'),
    ...(raw.lens ? { lens: raw.lens } : {}),
    input: raw.input,
    verify: raw.verify ?? [],
    ...(raw.repo_checks ? { repoChecks: true } : {}),
    ...(raw.verify_failure ? { verifyFailure: raw.verify_failure } : {}),
    pickup: raw.pickup ?? false,
    structuredOutput: raw.structured_output,
    // `attempts` counts every check, as `verifyAttempts`: the preset's returns to the job, plus the first one.
    ...(raw.red ? { red: { command: raw.red.command ?? missing('red.command'), mode: raw.red.mode ?? 'measure', attempts: presetBound(preset, 'red') + 1 } } : {}),
    ...stepFields(name, raw, limits(raw.limits, perRun), settings),
    onStart: raw.on_start ?? {},
    onSuccess: raw.on_success ?? {},
  };
}

// Compiled once, at load: a preset that breaks an invariant of the core never reaches the engine.
const preset = compilePreset(factoryDefault).preset;

/** The limit of a counter of the preset, which the engine still reads through `limits` (ORC-187). */
export function presetBound(p: Preset, counter: string): number {
  const found = Object.hasOwn(p.counters, counter) ? p.counters[counter] : undefined;
  if (!found) throw new WorkflowError(`preset ${p.name}: counter ${counter} is missing`);
  return found.limit;
}

export function loadWorkflow(opts: { packDir: string; projectFile?: string | undefined; settings?: StepSettings | undefined }): Workflow {
  const pack = readRaw(join(opts.packDir, 'workflow.yml'));
  const project = opts.projectFile ? readRaw(opts.projectFile) : undefined;
  const raw = mergeRaw(pack, project);

  const settings = opts.settings ?? {};
  checkStepSettings(settings);
  const perRun = limits(raw.limits?.per_run, { turns: 150, durationMs: 90 * 60_000 });
  const rawJobs = raw.jobs ?? {};
  const jobs: Record<string, JobSpec> = {};
  for (const name of Object.keys(rawJobs)) jobs[name] = buildJob(name, resolveJob(name, rawJobs), perRun, settings);

  for (const j of Object.values(jobs)) {
    if (j.onSuccess.run && !jobs[j.onSuccess.run]) throw new WorkflowError(`jobs.${j.name}.on_success.run: unknown job "${j.onSuccess.run}"`);
  }

  const on: Partial<Record<EventType, Rule[]>> = {};
  for (const [type, rules] of Object.entries(raw.on ?? {})) {
    if (!EVENT_TYPES.includes(type)) throw new WorkflowError(`on.${type}: unknown event type`);
    on[type as EventType] = rules.map((r, i) => {
      const path = `on.${type}[${i}]`;
      if (r.run && !jobs[r.run]) throw new WorkflowError(`${path}.run: unknown job "${r.run}"`);
      let when;
      if (r.when !== undefined) {
        try {
          when = parseCondition(r.when);
        } catch (e) {
          throw new WorkflowError(`${path}.when: ${(e as Error).message}`);
        }
      }
      const rule: Rule = {
        from: r.from,
        to: r.to,
        label: r.label,
        say: r.say,
        when,
        whenSrc: r.when,
        run: r.run,
        debounceMs: r.debounce !== undefined ? parseDuration(r.debounce) : undefined,
        move: r.move,
        labels: r.labels,
        comment: r.comment,
        do: r.do,
      };
      return rule;
    });
  }

  const states = raw.states as Workflow['states'] | undefined;
  const required = ['todo', 'dev', 'human_review', 'ai_review', 'done'] as const;
  for (const s of required) if (!states?.[s]) throw new WorkflowError(`states.${s}: required`);
  const moves: [string, LogicalState | undefined][] = [
    ...Object.values(jobs).flatMap((j) => [[`jobs.${j.name}.on_start.move`, j.onStart.move], [`jobs.${j.name}.on_success.move`, j.onSuccess.move]] as [string, LogicalState | undefined][]),
    ...Object.entries(on).flatMap(([type, rules]) =>
      rules!.flatMap((r, i) => (['move', 'from', 'to'] as const).map((k) => [`on.${type}[${i}].${k}`, r[k]] as [string, LogicalState | undefined])),
    ),
  ];
  for (const [path, to] of moves) if (to && !states![to]) throw new WorkflowError(`${path}: no status for "${to}"`);

  return {
    version: 1,
    blockComment: true,
    tracker: {
      kind: 'linear',
      team: raw.tracker?.team,
      pickup: { checks: raw.tracker?.pickup?.checks ?? [] },
    },
    states: states!,
    limits: {
      parallelSessions: raw.limits?.parallel_sessions ?? 3,
      questionSessions: raw.limits?.question_sessions ?? 2,
      perRun,
      // Bounds of the factory/default preset (ORC-187); the YAML keys still override them until ORC-177.
      // `verifyAttempts` counts every check: the preset's returns to the run, plus the first one.
      verifyAttempts: raw.limits?.verify_attempts ?? presetBound(preset, 'verify') + 1,
      ciFixAttempts: raw.limits?.ci_fix_attempts ?? presetBound(preset, 'review_ci'),
      repeatedFailures: preset.sameFailure.limit,
      silentAfterMs: preset.silentRun.minutes * 60_000,
      specCheckReturns: presetBound(preset, 'spec_check'),
      specChanges: presetBound(preset, 'spec_review'),
    },
    workspace: { setup: raw.workspace?.setup ?? [], portBase: raw.workspace?.ports?.base ?? 4200 },
    commands: [...new Set((on.command ?? []).map((r) => r.say).filter((s): s is string => !!s))],
    on,
    jobs,
  };
}
