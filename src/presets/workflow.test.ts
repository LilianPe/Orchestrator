import { describe, expect, it } from 'vitest';
import { hashText } from '../core/attempt-labels.js';
import { hashCanonical } from '../runtime/workflow-version.js';
import { agentStep, defaultWorkflow, workflowViolations, type StepSettings } from './workflow.js';

/**
 * The hashes of the workflow the standard pack's YAML gave, before ORC-389 removed it: the canonical one, which each ticket's
 * frozen version and the replay journals carry, and the one of its JSON text, keys in their order, which the journals hold.
 * A change of either changes the journals: re-record them (`npm run replay:record`) and pin the new hashes in the same PR.
 */
const CANONICAL = '65580a4d6840b36252fc5c18f8fee2b7703ccba61bc52686ffe93d30550e6796';
const TEXT = 'sha256:a1ea6046ae772b4ee7d1ebe4a73f7e47df56e035422ed550af0a9e7f1a178ea4';

describe('defaultWorkflow (ORC-388, ORC-389)', () => {
  // The safety net of ORC-177's later parts: the workflow is the pack's, so no ticket decides otherwise.
  it("is the workflow the standard pack held, its hash and its keys' order included", () => {
    expect(hashCanonical(defaultWorkflow())).toBe(CANONICAL);
    expect(hashText(JSON.stringify(defaultWorkflow()))).toBe(TEXT);
  });

  it("applies factory.yml's step settings to the jobs of each step, and to them only", () => {
    const settings: StepSettings = {
      effort: { default: 'high', perStep: { build: 'low' } },
      budgets: { maxTurns: { fix: 20 }, perStepTokens: { review: 50_000 } },
      tools: { perStep: { build: ['Read', 'Edit', 'Write'] } },
    };
    const wf = defaultWorkflow(settings);
    const base = defaultWorkflow();
    expect(wf.jobs.dev).toMatchObject({ effort: 'low', tools: ['Read', 'Edit', 'Write'] });
    for (const job of ['dev-feedback', 'fix-ci', 'fix-review', 'fix-human', 'answer-relayed']) expect(wf.jobs[job]!.limits.turns, job).toBe(20);
    for (const job of ['review', 'review-security']) expect(wf.jobs[job]!.limits.tokens, job).toBe(50_000);
    // A step not named keeps its own; `ask`, out of the preset, keeps its effort, its turns and its tokens.
    expect(wf.jobs.rebase).toEqual(base.jobs.rebase);
    expect(wf.jobs.ask).toEqual(base.jobs.ask);
    expect(wf.limits).toEqual(base.limits);
  });

  // What the loader refused in a YAML file, held by the TypeScript table on its own.
  it('names only jobs and statuses it has: every run, every move, the blocking findings and the relayed answer', () => {
    const wf = defaultWorkflow();
    expect(workflowViolations(wf)).toEqual([]);
    expect(wf.jobs[wf.relayJob!]).toMatchObject({ queue: 'dev', session: 'resume', input: 'feedback' });
    expect(wf.jobs[wf.relayJob!]!.counter).toBeUndefined();
    const wrong = defaultWorkflow();
    wrong.jobs.dev!.onSuccess.run = 'reveiw';
    wrong.on['pr.merged']![0]!.move = 'ready';
    wrong.on['label.changed']![0]!.do = 'after_merge';
    expect(workflowViolations(wrong)).toEqual([
      'on.label.changed[0].do: after_merge is the step of a merged PR, on pr.merged only',
      'on.pr.merged[0].move: no status for "ready"',
      'jobs.dev.onSuccess.run: unknown job "reveiw"',
    ]);
  });

  // What the loader refused in a job or a rule of the pack, checked on the table now that no file goes through it.
  it('keeps the review to its jobs, read-only steps on a clone of their own, the session to the dev queue', () => {
    const wf = defaultWorkflow();
    for (const j of Object.values(wf.jobs)) {
      const review = j.step === 'review';
      expect(!!j.lens, `${j.name}.lens`).toBe(review);
      expect(j.workspace === 'published', `${j.name}.workspace`).toBe(review);
      if (j.onSuccess.post === 'review') expect(j.step, `${j.name}.onSuccess.post`).toBe('review');
      if (j.onBlocking) expect(j.onSuccess.post, `${j.name}.onBlocking`).toBe('review');
      if (j.queue === 'questions') expect(j.session, `${j.name}.session`).toBe('new');
      const step = j.step === undefined ? undefined : agentStep(j.step);
      if (step?.type === 'agent_step' && step.readOnly && step.writes === 'nothing' && !review) expect(j.workspace, `${j.name}.workspace`).toBe('trunk-readonly');
    }
  });

  it('gives each call a workflow of its own: a test that changes a job, a rule or a limit changes no other workflow', () => {
    const a = defaultWorkflow();
    a.jobs.dev!.onSuccess = {};
    a.jobs['fix-ci']!.onSuccess.move = 'dev';
    a.on['ticket.delegated']![0]!.run = 'intake';
    a.limits.verifyAttempts = 1;
    a.limits.perRun.turns = 1;
    expect(defaultWorkflow().jobs.dev!.onSuccess).toEqual({ move: 'ai_review', post: 'summary', run: 'review' });
    expect(defaultWorkflow().jobs['dev-feedback']!.onSuccess.move).toBe('ai_review');
    expect(defaultWorkflow().on['ticket.delegated']![0]!.run).toBe('dev');
    expect(defaultWorkflow().limits).toMatchObject({ verifyAttempts: 4, perRun: { turns: 150 } });
  });

  it("refuses factory.yml's settings for a step the preset does not have, as the loader did", () => {
    expect(() => defaultWorkflow({ effort: { perStep: { nope: 'low' } } })).toThrow('claude.effort.per_step.nope: not an agent step of factory/default');
  });
});
