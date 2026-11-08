import type { JobSpec } from '../config/workflow-schema.js';

/** The steps the MVP doc shows in the session; `Questions` runs nothing until ORC-210. */
const STEPS = ['Understand', 'Questions', 'Spec', 'Tests', 'Build', 'Verify', 'PR'] as const;
export type PlanStepName = (typeof STEPS)[number];

/** A step as Linear's `agentSession.plan` holds it: Linear replaces the whole plan at each update. */
export interface PlanStep {
  content: PlanStepName;
  status: 'pending' | 'inProgress' | 'completed' | 'canceled';
}

/** The plan with `step` at `status`: what ran before it is done, what it skipped is canceled, what follows is to do (again). */
/** Each step named from `STEPS` by its position: a plan started before ORC-331 switches to English at its next update. */
const named = (s: PlanStep, i: number): PlanStep => ({ ...s, content: STEPS[i] ?? s.content });

export function advancePlan(plan: readonly PlanStep[], step: PlanStepName, status: PlanStep['status'] = 'inProgress'): PlanStep[] {
  const at = STEPS.indexOf(step);
  return plan.map(named).map((s, i) => {
    if (i === at) return { ...s, status };
    if (i > at) return { ...s, status: 'pending' };
    return { ...s, status: s.status === 'pending' || s.status === 'canceled' ? 'canceled' : 'completed' };
  });
}

/** The plan at the delegation: the factory starts by understanding the ticket. */
export function startPlan(): PlanStep[] {
  return advancePlan(STEPS.map((content) => ({ content, status: 'pending' })), 'Understand');
}

/** The end of the factory's work on the ticket: the step under way is done, and the PR when there is one. */
export function closePlan(plan: readonly PlanStep[], hasPr: boolean): PlanStep[] {
  const closed = plan.map(named).map((s): PlanStep => (s.status === 'inProgress' ? { ...s, status: 'completed' } : s));
  return hasPr ? advancePlan(closed, 'PR', 'completed') : closed;
}

/**
 * The step of the plan a job works on, read from its shape. None for a review or a question, nor for a run that ends
 * without handing the ticket over (a reply, a CI fix): nothing would close the step it reopened.
 */
export function planStepOfJob(job: Pick<JobSpec, 'queue' | 'skill' | 'red' | 'onSuccess' | 'step'>): PlanStepName | undefined {
  if (job.queue !== 'dev' || job.skill?.endsWith(':review')) return undefined;
  if (job.step === 'spec_draft') return 'Spec';
  if (job.red) return 'Tests';
  return job.onSuccess.move ? 'Build' : undefined;
}
