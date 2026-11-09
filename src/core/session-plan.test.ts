import { describe, expect, it } from 'vitest';
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
    const toReview = { move: 'human_review' as const };
    expect(planStepOfJob({ queue: 'dev', skill: 'factory:dev', onSuccess: toReview })).toBe('Build');
    expect(planStepOfJob({ queue: 'dev', skill: 'factory:tests', onSuccess: { run: 'dev' }, red: { command: 'npm test --', mode: 'measure', attempts: 3 } })).toBe('Tests');
    expect(planStepOfJob({ queue: 'dev', skill: 'factory:feedback', onSuccess: { post: 'reply' } })).toBeUndefined();
    expect(planStepOfJob({ queue: 'dev', skill: 'factory:review', onSuccess: toReview })).toBeUndefined();
    expect(planStepOfJob({ queue: 'questions', skill: 'factory:ask', onSuccess: { post: 'reply' } })).toBeUndefined();
    // The spec step (ORC-212): the tests step after its gate takes the plan on.
    expect(planStepOfJob({ queue: 'dev', step: 'spec_draft', skill: 'factory:spec', onSuccess: { run: 'tests' } })).toBe('Spec');
  });
});
