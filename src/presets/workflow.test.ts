import { describe, expect, it } from 'vitest';
import { hashText } from '../core/attempt-labels.js';
import { hashCanonical } from '../runtime/workflow-version.js';
import { blockingFix, delegatedJob, nextOf, stepStatus } from '../core/chain.js';
import { factoryDefault } from './factory-default.js';
import { compilePreset, mergeGate } from './preset.js';
import { agentStep, DEFAULT_STATES, defaultWorkflow, workflowViolations, type StepSettings } from './workflow.js';

/**
 * The hashes of the workflow of `factory/default`: the canonical one, which each ticket's frozen version and the replay
 * journals carry, and the one of its JSON text, keys in their order, which the journals hold. A change of either changes the
 * journals: re-record them (`npm run replay:record`) and pin the new hashes in the same PR (last: ORC-457, the Spec status by default).
 */
const CANONICAL = 'f04fbef5ffca3fe31bd00352fc69be2b43218f43aedc07524b7bff2ed534f6c2';
const TEXT = 'sha256:198137ad9858a97e2f5b1b255da276841837403270b4692c85c9f2d081ede425';

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

  it("refuses a link of the preset a reaction reads that starts no job, but a merge gate with no way back, which has no round (ORC-417)", () => {
    const noRound = defaultWorkflow();
    delete mergeGate(noRound.preset)!.onFailure;
    expect(workflowViolations(noRound)).toEqual([]);
    const lost = defaultWorkflow();
    delete lost.jobs['fix-ci'];
    expect(workflowViolations(lost)).toEqual(['reactions: redCi starts no job']);
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
    expect(delegatedJob(defaultWorkflow())?.name).toBe('intake');
    expect(defaultWorkflow().limits).toMatchObject({ verifyAttempts: 4, perRun: { turns: 150 } });
  });

  it("refuses factory.yml's settings for a step the preset does not have, as the loader did", () => {
    expect(() => defaultWorkflow({ effort: { perStep: { nope: 'low' } } })).toThrow('claude.effort.per_step.nope: not an agent step of factory/default');
  });
});

describe("factory.yml's statuses (ORC-382)", () => {
  const job = (wf: ReturnType<typeof defaultWorkflow>, name: string) => wf.jobs[name]!;

  it("are ORC-170's and Spec by default (ORC-457): the spec shows Spec, the build In Progress", () => {
    const wf = defaultWorkflow();
    expect(wf.states).toEqual(DEFAULT_STATES);
    expect(DEFAULT_STATES.spec).toBe('Spec');
    expect(wf.preset.statuses).toEqual({ intake: 'todo', spec_draft: 'spec', build: 'dev', review: 'ai_review', human_review: 'human_review' });
    expect(stepStatus(wf, 'spec_draft')).toBe('spec');
    expect(nextOf(wf, job(wf, 'intake'))).toMatchObject({ move: 'spec', run: { name: 'spec' } });
    expect(stepStatus(wf, 'build')).toBe('dev');
  });

  it('ORC-457 criterion 2: `spec_draft: off` turns the Spec status off, the ticket stays in Todo until the build', () => {
    const wf = defaultWorkflow({ statuses: { spec_draft: 'off' } });
    expect(wf.states).not.toHaveProperty('spec');
    expect(stepStatus(wf, 'spec_draft')).toBeUndefined();
    expect(nextOf(wf, job(wf, 'intake')).move).toBeUndefined();
    expect(nextOf(wf, job(wf, 'tests'))).toMatchObject({ move: 'dev', run: { name: 'dev' } });
    // The spec and its human gate stay: only the status goes.
    expect(wf.preset.steps.map((s) => s.id)).toContain('spec_review');
  });

  it('ORC-457: refuses `off` for a step whose status the factory needs', () => {
    expect(() => defaultWorkflow({ statuses: { build: 'off' } })).toThrow(/statuses\.build: `off` turns off only the status of spec_draft/);
    expect(() => defaultWorkflow({ statuses: { intake: 'off' } })).toThrow(/statuses\.intake: `off` turns off only the status of spec_draft/);
  });

  it('criterion 1: a step named in the table moves the ticket to its status when the chain reaches it', () => {
    const wf = defaultWorkflow({ statuses: { intake: 'Todo', spec_draft: 'Drafting', build: 'Doing', review: 'AI Review', human_review: 'Human Review' } });
    expect(wf.states).toEqual({ ...DEFAULT_STATES, spec: 'Drafting', dev: 'Doing' });
    // intake's end reaches the spec: Spec; the approved spec's tests show no status of their own; the build In Progress, named Doing.
    expect(nextOf(wf, job(wf, 'intake'))).toMatchObject({ move: 'spec', run: { name: 'spec' } });
    expect(nextOf(wf, job(wf, 'spec'), true)).not.toHaveProperty('move');
    expect(nextOf(wf, job(wf, 'tests'))).toMatchObject({ move: 'dev', run: { name: 'dev' } });
    // Todo is a human's: intake names it, never moves to it.
    expect(stepStatus(wf, 'intake')).toBeUndefined();
  });

  it('criterion 4: refuses at load a step the preset does not have, a step with no status, and a Linear status for two', () => {
    expect(() => defaultWorkflow({ statuses: { deploy: 'Deploying' } })).toThrow(/statuses\.deploy: is not a step of factory\/default/);
    expect(() => defaultWorkflow({ statuses: { tests: 'Testing' } })).toThrow(/statuses\.tests: shows no status of its own .*the steps with one: intake, spec_draft, build, review, human_review/);
    expect(() => defaultWorkflow({ statuses: { spec_draft: 'In Progress' } })).toThrow(/« In Progress » would name both spec and dev/);
  });

  it('refuses a status the preset table gives a step it does not have, and one no step shows', () => {
    expect(() => compilePreset({ ...factoryDefault, statuses: { ...factoryDefault.statuses, deploy: 'dev' } })).toThrow(/statuses: deploy is not a step/);
    expect(() => compilePreset({ ...factoryDefault, statuses: { build: 'done' as never } })).toThrow(/statuses of build: done is not a status a step shows/);
    expect(() => compilePreset({ ...factoryDefault, posts: { deploy: 'summary' } })).toThrow(/posts: deploy is not a step/);
  });
});
