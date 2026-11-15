import { describe, expect, it } from 'vitest';
import { defaultWorkflow } from '../presets/workflow.js';
import { advancePlan, closePlan, planStepOfJob, startPlan, type PlanStep } from './session-plan.js';

const statuses = (plan: readonly PlanStep[]) => plan.map((s) => s.status);

describe('session plan (ORC-171)', () => {
  it('starts on understanding the ticket, the seven steps in the order of the MVP doc', () => {
    expect(startPlan().map((s) => s.content)).toEqual(['Understand', 'Questions', 'Spec', 'Tests', 'Build', 'Verify', 'PR']);
    expect(statuses(startPlan())).toEqual(['inProgress', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
  });

  it('completes what ran and cancels what was skipped: a step that never ran is not shown as done', () => {
    expect(statuses(advancePlan(startPlan(), 'Build'))).toEqual(['completed', 'canceled', 'canceled', 'canceled', 'inProgress', 'pending', 'pending']);
  });

  it('goes back to an earlier step: what came after it is to do again', () => {
    const atCheck = advancePlan(advancePlan(startPlan(), 'Build'), 'Verify');
    expect(statuses(advancePlan(atCheck, 'Build'))).toEqual(['completed', 'canceled', 'canceled', 'canceled', 'inProgress', 'pending', 'pending']);
  });

  it('marks the PR done once it exists, the check the run never went through canceled', () => {
    expect(statuses(advancePlan(advancePlan(startPlan(), 'Build'), 'PR', 'completed'))).toEqual(['completed', 'canceled', 'canceled', 'canceled', 'completed', 'canceled', 'completed']);
  });

  it('names a plan started before ORC-331, in French, in English at its next update', () => {
    const french = ['Comprendre', 'Questions', 'Spec', 'Tests', 'Build', 'Vérif', 'PR'].map((content) => ({ content, status: 'pending' }) as unknown as PlanStep);
    const english = ['Understand', 'Questions', 'Spec', 'Tests', 'Build', 'Verify', 'PR'];
    expect(advancePlan(french, 'Build').map((s) => s.content)).toEqual(english);
    expect(closePlan(french, false).map((s) => s.content)).toEqual(english);
  });

  it('closes on the end of the work: the step under way is done, the PR too only when one exists', () => {
    const building = advancePlan(startPlan(), 'Build');
    expect(statuses(closePlan(building, false))).toEqual(['completed', 'canceled', 'canceled', 'canceled', 'completed', 'pending', 'pending']);
    expect(statuses(closePlan(building, true))).toEqual(['completed', 'canceled', 'canceled', 'canceled', 'completed', 'canceled', 'completed']);
  });

  it('reads the step of a job from its shape: reviews, questions and runs that hand nothing over are not steps of the plan', () => {
    const wf = defaultWorkflow();
    const of = (job: string) => planStepOfJob(wf.jobs[job]!, wf);
    expect(of('dev')).toBe('Build');
    expect(of('tests')).toBe('Tests');
    // The relayed answer and the rebase hand nothing over: their end moves nothing.
    expect(of('answer-relayed')).toBeUndefined();
    expect(of('rebase')).toBeUndefined();
    expect(of('review-security')).toBeUndefined();
    expect(of('ask')).toBeUndefined();
    // The spec step (ORC-212): the tests step after its gate takes the plan on.
    expect(of('spec')).toBe('Spec');
  });
});
