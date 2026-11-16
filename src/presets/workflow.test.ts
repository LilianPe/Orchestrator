import { describe, expect, it } from 'vitest';
import { hashText } from '../core/attempt-labels.js';
import { hashCanonical } from '../runtime/workflow-version.js';
import { blockingFix, delegatedJob, nextOf } from '../core/chain.js';
import { agentStep, defaultWorkflow, workflowViolations, type StepSettings } from './workflow.js';

/**
 * The hashes of the workflow of `factory/default`: the canonical one, which each ticket's frozen version and the replay
 * journals carry, and the one of its JSON text, keys in their order, which the journals hold. A change of either changes the
 * journals: re-record them (`npm run replay:record`) and pin the new hashes in the same PR (last: ORC-395, the chain's entry at intake).
 */
const CANONICAL = '809977d80f42307fc051119296b3bdd5788809bab9be6e15a1053beaf40bb11a';
const TEXT = 'sha256:41baaafe3491ed8a7b0f58b878549b2d39fb3956e95c6f76a61ad7f82ad70e5c';

describe('defaultWorkflow (ORC-388, ORC-389, ORC-391)', () => {
  // The safety net of ORC-177's later parts: a change of the workflow is a change of the journals, seen in their diff.
  it("is the workflow the journals pin, its hash and its keys' order included", () => {
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
  it("names only jobs, steps and statuses it has: every run, every move, each job's step, the blocking findings and the relayed answer", () => {
    const wf = defaultWorkflow();
    expect(workflowViolations(wf)).toEqual([]);
    expect(wf.jobs[wf.relayJob!]).toMatchObject({ queue: 'dev', session: 'resume', input: 'feedback', cause: 'relay' });
    const wrong = defaultWorkflow();
    wrong.jobs['answer-relayed']!.step = 'fxi';
    wrong.entry = 'intak';
    delete wrong.jobs['fix-human'];
    expect(workflowViolations(wrong)).toEqual(['jobs.answer-relayed.step: fxi is not a step of factory/default', 'entry: intak is not a step of factory/default', 'reactions: humanFeedback starts no job']);
  });

  // What the loader refused in a job or a rule of the pack, checked on the table now that no file goes through it.
  it('keeps the review to its jobs, read-only steps on a clone of their own, the session to the dev queue', () => {
    const wf = defaultWorkflow();
    for (const j of Object.values(wf.jobs)) {
      const review = j.step === 'review';
      expect(!!j.lens, `${j.name}.lens`).toBe(review);
      expect(j.workspace === 'published', `${j.name}.workspace`).toBe(review);
      if (nextOf(wf, j).post === 'review') expect(j.step, `${j.name}: posts the review`).toBe('review');
      if (blockingFix(wf, j)) expect(nextOf(wf, j).post, `${j.name}: has a fix of its findings`).toBe('review');
      if (j.queue === 'questions') expect(j.session, `${j.name}.session`).toBe('new');
      const step = j.step === undefined ? undefined : agentStep(j.step);
      if (step?.type === 'agent_step' && step.readOnly && step.writes === 'nothing' && !review) expect(j.workspace, `${j.name}.workspace`).toBe('trunk-readonly');
    }
  });

  it('gives each call a workflow of its own: a test that changes a job, a step, the entry or a limit changes no other workflow', () => {
    const a = defaultWorkflow();
    a.jobs.dev!.skill = 'x';
    a.preset!.steps.find((s) => s.id === 'review')!.next = null;
    a.entry = 'build';
    a.limits.verifyAttempts = 1;
    a.limits.perRun.turns = 1;
    expect(defaultWorkflow().jobs.dev!.skill).toBe('factory:dev');
    expect(defaultWorkflow().preset!.steps.find((s) => s.id === 'review')!.next).toBe('human_review');
    // The delegation starts the preset's entry (ORC-395).
    expect(delegatedJob(defaultWorkflow())).toBe('intake');
    expect(defaultWorkflow().limits).toMatchObject({ verifyAttempts: 4, perRun: { turns: 150 } });
  });

  it("refuses factory.yml's settings for a step the preset does not have, as the loader did", () => {
    expect(() => defaultWorkflow({ effort: { perStep: { nope: 'low' } } })).toThrow('claude.effort.per_step.nope: not an agent step of factory/default');
  });
});
