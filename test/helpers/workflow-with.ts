import type { Effect } from '../../src/core/decision.js';
import { reduce } from '../../src/core/reduce.js';
import type { EventType, FactoryEvent, LogicalState } from '../../src/core/types.js';
import type { JobSpec, Limits, PickupCheck, Workflow } from '../../src/core/workflow.js';
import { compilePreset, type Preset } from '../../src/presets/preset.js';
import { defaultWorkflow, preset, presetWorkflow, workflowViolations } from '../../src/presets/workflow.js';
import type { DecisionPlan, DecisionRequest, Store } from '../../src/store/types.js';

/**
 * Effects a test adds to the decisions of an event type (ORC-392), where a rule of its own (`labels`, `comment`) added them
 * before the reactions were coded in `decide`: the outbox, crash and version tests need a decision with these effects, which
 * no default reaction makes. `decide` never reads them: `withTestEffects` adds them to the plan of each decision.
 * `only`: the event decides these effects alone (the `settle` of its plan kept), in place of what `decide` decided. `unblocks`:
 * the ticket is unblocked first, as a rule that started a run did. `to` and `label`: only a move to that status, only the
 * addition of that label.
 */
export interface TestEffects {
  effects: Effect[];
  only?: true;
  unblocks?: true;
  to?: LogicalState;
  label?: string;
}

/** A test's workflow: its effects ride in it, so a ticket frozen on a version keeps that version's (a hash of its own). */
export type TestWorkflow = Workflow & { testEffects?: Partial<Record<EventType, TestEffects>> };

/**
 * A test's variation of `factory/default`'s workflow, where a project's `workflow.yml` changed the pack before ORC-388:
 * each key replaces what it names, the rest is the default's.
 */
export interface WorkflowOverrides {
  /** The job a delegation starts in place of `dev` (`Workflow.delegated`): the steps the default does not run yet (`intake`, `spec`, `tests`, ORC-395). */
  delegated?: string;
  /** Effects added to the decisions of each event type named (`TestEffects`). */
  effects?: Partial<Record<EventType, TestEffects>>;
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

/** Over `base`, `factory/default`'s workflow by default. */
export function workflowWith(o: WorkflowOverrides = {}, wf: Workflow = defaultWorkflow()): Workflow {
  for (const name of Object.keys(o.jobs ?? {})) if (!wf.jobs[name]) throw new Error(`workflowWith: jobs.${name}: unknown job`);
  const jobs = Object.fromEntries(
    Object.entries(wf.jobs).map(([name, job]) => [name, { ...job, ...(o.verify && ON_DEV.includes(name) ? { verify: o.verify } : {}), ...o.jobs?.[name] }]),
  );
  const given = (wf as TestWorkflow).testEffects;
  const testEffects = o.effects || given ? { ...given, ...o.effects } : undefined;
  const out: TestWorkflow = {
    ...wf,
    tracker: o.pickupChecks ? { ...wf.tracker, pickup: { checks: o.pickupChecks } } : wf.tracker,
    limits: { ...wf.limits, ...o.limits },
    workspace: { ...wf.workspace, ...o.workspace },
    jobs,
    ...(o.delegated ? { delegated: o.delegated } : {}),
    ...(testEffects ? { testEffects } : {}),
  };
  const refused = workflowViolations(out);
  if (refused.length) throw new Error(`workflowWith: ${refused.join('; ')}`);
  return out;
}

/** The test's effects of `event`, on the version the ticket is frozen on. */
function effectsOf(event: FactoryEvent, version: unknown): TestEffects | undefined {
  const given = (version as TestWorkflow | undefined)?.testEffects?.[event.type];
  if (given?.to && (event.type !== 'status.changed' || event.payload.to !== given.to)) return undefined;
  if (given?.label && (event.type !== 'label.changed' || event.payload.change !== 'added' || event.payload.label !== given.label)) return undefined;
  return given;
}

/** The plan with the test's effects: before its first run started, else before its `settle`. */
function withEffects(plan: DecisionPlan, given: TestEffects | undefined): DecisionPlan {
  if (!given) return plan;
  if (given.unblocks && plan.ticket?.blocked) plan = { ...plan, ticket: { ...reduce(plan.ticket, { type: 'ticket.unblocked' })!, updatedAt: plan.ticket.updatedAt, workflowHash: plan.ticket.workflowHash } };
  const settle = plan.effects.filter((e) => e.kind === 'settle');
  if (given.only) return { ...plan, effects: [...given.effects, ...settle], timers: [] };
  const at = plan.effects.findIndex((e) => e.kind === 'start_run' || e.kind === 'settle');
  const effects = [...plan.effects];
  effects.splice(at < 0 ? effects.length : at, 0, ...given.effects);
  return { ...plan, effects };
}

/** `store`, whose decisions get the test's effects of their workflow version (`TestEffects`). */
export function withTestEffects(inner: Store): Store {
  return Object.assign(Object.create(inner) as Store, {
    decide: (req: DecisionRequest) =>
      inner.decide({
        ...req,
        decide: (ticket, version) => withEffects(req.decide(ticket, version), effectsOf(req.event, version.definition)),
      }),
  });
}

/**
 * `factory/default` without its AI review on the way (ORC-183): `publish` leads to the merge gate, and a fix's publication ends
 * its run (`publish_fix`), its reply posted and the ticket left where it is, as before ORC-184. The review step stays: a human's
 * move to AI Review still starts it.
 */
const withoutAiReview: Preset = compilePreset({
  ...preset,
  name: 'test/without-ai-review',
  steps: [
    ...preset.steps.map((s) => (s.id === 'publish' ? { ...s, next: 'human_review' } : s.id === 'verify_fix' ? { ...s, next: 'publish_fix' } : s)),
    { id: 'publish_fix', type: 'publish', mode: 'push', next: null },
  ],
}).preset;

/** The workflow of `withoutAiReview`, its chain starting at `build` as the default's does. */
export const workflowWithoutAiReview = (): Workflow => presetWorkflow(withoutAiReview, {}, 'build');

/** A delegation starts `job` instead of `dev`: the steps the default does not run yet (`intake`, `spec`, `tests`, ORC-395). */
export function delegationStarts(job: string, o: WorkflowOverrides = {}): WorkflowOverrides {
  return { ...o, delegated: job };
}
