import { parseCondition } from '../../src/core/conditions.js';
import type { EventType } from '../../src/core/types.js';
import type { JobSpec, Limits, PickupCheck, Rule, Workflow } from '../../src/core/workflow.js';
import { compilePreset, type Preset } from '../../src/presets/preset.js';
import { defaultWorkflow, preset, presetWorkflow, workflowViolations } from '../../src/presets/workflow.js';

/** A rule as a test writes it: its condition in the `when` grammar, parsed as the engine's rules are (`whenSrc` kept). */
export type RuleOverride = Omit<Rule, 'when' | 'whenSrc'> & { when?: string };

/**
 * A test's variation of `factory/default`'s workflow, where a project's `workflow.yml` changed the pack before ORC-388:
 * each key replaces what it names, the rest is the default's.
 */
export interface WorkflowOverrides {
  /** The rules of each event named, in place of the default's; the `say` of the `command` rules are the workflow's commands. */
  on?: Partial<Record<EventType, RuleOverride[]>>;
  /** Fields of each job named, in place of its own: of that job only, where the pack's `extends` passed them on (but `verify`, below). */
  jobs?: Record<string, Partial<JobSpec>>;
  /** The commands `dev` and every job built on it verify after their run, as the pack's `jobs.dev.verify` did through `extends`. */
  verify?: string[];
  /** The limits, in place of the default's; `perRun` changes no job's own `limits`, unlike the pack's `per_run`. */
  limits?: Partial<Limits>;
  workspace?: Partial<Workflow['workspace']>;
  pickupChecks?: PickupCheck[];
}

/** `dev` and the jobs the pack built on it (`extends: dev`): the fixes, `tests`, the relayed answer and `rebase`. */
const ON_DEV = ['dev', 'tests', 'dev-feedback', 'fix-ci', 'fix-review', 'fix-human', 'answer-relayed', 'rebase'];

function rule({ when, ...r }: RuleOverride): Rule {
  return when === undefined ? r : { ...r, when: parseCondition(when), whenSrc: when };
}

/** Over `base`, `factory/default`'s workflow by default. */
export function workflowWith(o: WorkflowOverrides = {}, wf: Workflow = defaultWorkflow()): Workflow {
  for (const name of Object.keys(o.jobs ?? {})) if (!wf.jobs[name]) throw new Error(`workflowWith: jobs.${name}: unknown job`);
  const given = Object.entries(o.on ?? {}).filter((e): e is [string, RuleOverride[]] => e[1] !== undefined);
  const on: Workflow['on'] = { ...wf.on, ...Object.fromEntries(given.map(([type, rules]) => [type, rules.map(rule)])) };
  const jobs = Object.fromEntries(
    Object.entries(wf.jobs).map(([name, job]) => [name, { ...job, ...(o.verify && ON_DEV.includes(name) ? { verify: o.verify } : {}), ...o.jobs?.[name] }]),
  );
  const out: Workflow = {
    ...wf,
    tracker: o.pickupChecks ? { ...wf.tracker, pickup: { checks: o.pickupChecks } } : wf.tracker,
    limits: { ...wf.limits, ...o.limits },
    workspace: { ...wf.workspace, ...o.workspace },
    commands: [...new Set((on.command ?? []).map((r) => r.say).filter((s): s is string => !!s))],
    on,
    jobs,
  };
  const refused = workflowViolations(out);
  if (refused.length) throw new Error(`workflowWith: ${refused.join('; ')}`);
  return out;
}

/**
 * `factory/default` without its AI review on the way (ORC-183): `publish` leads to the merge gate, and a fix's publication ends
 * its run (`publish_fix`), its reply posted and the ticket left where it is, as before ORC-184. The review step stays: a human's
 * move to AI Review still starts it.
 */
export const withoutAiReview: Preset = compilePreset({
  ...preset,
  name: 'test/without-ai-review',
  steps: [
    ...preset.steps.map((s) => (s.id === 'publish' ? { ...s, next: 'human_review' } : s.id === 'verify_fix' ? { ...s, next: 'publish_fix' } : s)),
    { id: 'publish_fix', type: 'publish', mode: 'push', next: null },
  ],
}).preset;

/** The workflow of `withoutAiReview`, its chain starting at `build` as the default's does. */
export const workflowWithoutAiReview = (): Workflow => presetWorkflow(withoutAiReview, {}, 'build');

/** When a delegation starts work, as the default's rule says it. */
export const DELEGATED = defaultWorkflow().on['ticket.delegated']![0]!.whenSrc!;

/** A delegation starts `job` instead of `dev`: the steps the default does not run yet (`intake`, `spec`, `tests`, ORC-395). */
export function delegationStarts(job: string, o: WorkflowOverrides = {}): WorkflowOverrides {
  return { ...o, on: { ...o.on, 'ticket.delegated': [{ when: DELEGATED, run: job }] } };
}
