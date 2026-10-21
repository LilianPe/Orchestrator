import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { parseCondition } from '../core/conditions.js';
import { parseDuration } from '../core/duration.js';
import type { EventType, LogicalState } from '../core/types.js';
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
  'push.human', 'command', 'pr.opened', 'pr.checks_passed', 'pr.checks_failed', 'pr.merged', 'pr.closed', 'run.finished',
  'verify.passed', 'verify.failed', 'debounce.fired', 'control.pause', 'control.resume', 'control.stop',
];

/** Event names before ORC-133, still accepted as `on` keys. */
const RENAMED: Record<string, EventType> = { 'ticket.moved': 'status.changed', 'label.added': 'label.changed' };

function renameOn(raw: RawWorkflow): RawWorkflow {
  if (!raw.on) return raw;
  return { ...raw, on: Object.fromEntries(Object.entries(raw.on).map(([k, rules]) => [RENAMED[k] ?? k, rules])) };
}

function readRaw(file: string): RawWorkflow {
  const doc = parse(readFileSync(file, 'utf8')) ?? {};
  const res = rawWorkflowSchema.safeParse(doc);
  if (!res.success) {
    const issue = res.error.issues[0]!;
    throw new WorkflowError(`${file}: ${issue.path.join('.')}: ${issue.message}`);
  }
  return renameOn(res.data);
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

function limits(raw: { turns?: number; duration?: string | number; usd?: number } | undefined, base: RunLimits): RunLimits {
  return {
    turns: raw?.turns ?? base.turns,
    durationMs: raw?.duration !== undefined ? parseDuration(raw.duration) : base.durationMs,
    usd: raw?.usd ?? base.usd,
  };
}

function buildJob(name: string, raw: RawJob, perRun: RunLimits): JobSpec {
  const need = <K extends keyof RawJob>(k: K): NonNullable<RawJob[K]> => {
    const v = raw[k];
    if (v === undefined) throw new WorkflowError(`jobs.${name}.${String(k)}: required`);
    return v as NonNullable<RawJob[K]>;
  };
  return {
    name,
    queue: need('queue'),
    model: need('model'),
    workspace: need('workspace'),
    session: raw.session ?? 'new',
    skill: need('skill'),
    input: raw.input,
    verify: raw.verify ?? [],
    pickup: raw.pickup ?? false,
    limits: limits(raw.limits, perRun),
    onStart: raw.on_start ?? {},
    onSuccess: raw.on_success ?? {},
  };
}

export function loadWorkflow(opts: { packDir: string; projectFile?: string }): Workflow {
  const pack = readRaw(join(opts.packDir, 'workflow.yml'));
  const project = opts.projectFile ? readRaw(opts.projectFile) : undefined;
  const raw = mergeRaw(pack, project);

  const perRun = limits(raw.limits?.per_run, { turns: 150, durationMs: 90 * 60_000, usd: 5 });
  const rawJobs = raw.jobs ?? {};
  const jobs: Record<string, JobSpec> = {};
  for (const name of Object.keys(rawJobs)) jobs[name] = buildJob(name, resolveJob(name, rawJobs), perRun);

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

  const states = raw.states as Record<LogicalState, string> | undefined;
  const required: LogicalState[] = ['todo', 'dev', 'human_review', 'ai_review', 'ready', 'done'];
  for (const s of required) if (!states?.[s]) throw new WorkflowError(`states.${s}: required`);

  return {
    version: 1,
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
      verifyAttempts: raw.limits?.verify_attempts ?? 2,
      reviewRounds: raw.limits?.review_rounds ?? 5,
    },
    workspace: { setup: raw.workspace?.setup ?? [], portBase: raw.workspace?.ports?.base ?? 4200 },
    commands: [...new Set((on.command ?? []).map((r) => r.say).filter((s): s is string => !!s))],
    on,
    jobs,
  };
}
