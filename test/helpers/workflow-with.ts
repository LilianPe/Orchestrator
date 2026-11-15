import { parseCondition } from '../../src/core/conditions.js';
import type { EventType } from '../../src/core/types.js';
import type { JobSpec, Limits, PickupCheck, Rule, Workflow } from '../../src/core/workflow.js';
import { defaultWorkflow } from '../../src/presets/workflow.js';

/** A rule as a test writes it: its condition in the `when` grammar, parsed as the engine's rules are (`whenSrc` kept). */
export type RuleOverride = Omit<Rule, 'when' | 'whenSrc'> & { when?: string };

/**
 * A test's variation of `factory/default`'s workflow, where a project's `workflow.yml` changed the pack before ORC-388:
 * each key replaces what it names, the rest is the default's.
 */
export interface WorkflowOverrides {
  /** The rules of each event named, in place of the default's; the `say` of the `command` rules are the workflow's commands. */
  on?: Partial<Record<EventType, RuleOverride[]>>;
  /** Fields of each job named, in place of its own. */
  jobs?: Record<string, Partial<JobSpec>>;
  /** The commands `dev` and every job built on it verify after their run, as the pack's `jobs.dev.verify` did through `extends`. */
  verify?: string[];
  limits?: Partial<Limits>;
  workspace?: Partial<Workflow['workspace']>;
  pickupChecks?: PickupCheck[];
}

/** `dev` and the jobs the pack built on it (`extends: dev`): the fixes, `tests`, the relayed answer and `rebase`. */
const ON_DEV = ['dev', 'tests', 'dev-feedback', 'fix-ci', 'fix-review', 'fix-human', 'answer-relayed', 'rebase'];

function rule({ when, ...r }: RuleOverride): Rule {
  return when === undefined ? r : { ...r, when: parseCondition(when), whenSrc: when };
}

export function workflowWith(o: WorkflowOverrides = {}): Workflow {
  const wf = defaultWorkflow();
  for (const name of Object.keys(o.jobs ?? {})) if (!wf.jobs[name]) throw new Error(`workflowWith: jobs.${name}: unknown job`);
  const on: Workflow['on'] = { ...wf.on, ...Object.fromEntries(Object.entries(o.on ?? {}).map(([type, rules]) => [type, rules.map(rule)])) };
  for (const r of Object.values(on).flat()) if (r.run && !wf.jobs[r.run]) throw new Error(`workflowWith: run: unknown job "${r.run}"`);
  const jobs = Object.fromEntries(
    Object.entries(wf.jobs).map(([name, job]) => [name, { ...job, ...(o.verify && ON_DEV.includes(name) ? { verify: o.verify } : {}), ...o.jobs?.[name] }]),
  );
  return {
    ...wf,
    tracker: o.pickupChecks ? { ...wf.tracker, pickup: { checks: o.pickupChecks } } : wf.tracker,
    limits: { ...wf.limits, ...o.limits },
    workspace: { ...wf.workspace, ...o.workspace },
    commands: [...new Set((on.command ?? []).map((r) => r.say).filter((s): s is string => !!s))],
    on,
    jobs,
  };
}

/** A delegation starts `job` instead of `dev`: the steps the default does not run yet (`intake`, `spec`, `tests`, ORC-395). */
export function delegationStarts(job: string, o: WorkflowOverrides = {}): WorkflowOverrides {
  return { ...o, on: { ...o.on, 'ticket.delegated': [{ when: 'state in [todo, dev] && !blocked', run: job }] } };
}
