import { describe, expect, it } from 'vitest';
import { hashText } from '../core/attempt-labels.js';
import { hashCanonical } from '../runtime/workflow-version.js';
import { defaultWorkflow, type StepSettings } from './workflow.js';

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
    const runs = [
      ...Object.values(wf.jobs).flatMap((j) => [j.onSuccess.run, j.onBlocking?.run]),
      ...Object.values(wf.on).flatMap((rules) => rules!.map((r) => r.run)),
      wf.relayJob,
    ].filter((r): r is string => r !== undefined);
    for (const run of runs) expect(wf.jobs, run).toHaveProperty([run]);
    const moves = [...Object.values(wf.jobs).flatMap((j) => [j.onStart.move, j.onSuccess.move]), ...Object.values(wf.on).flatMap((rules) => rules!.flatMap((r) => [r.move, r.from, r.to]))];
    for (const move of moves.filter((m) => m !== undefined)) expect(wf.states, move).toHaveProperty([move]);
    for (const j of Object.values(wf.jobs)) if (j.onBlocking) expect(wf.jobs[j.onBlocking.run]!.input).toBe('findings');
    expect(wf.jobs[wf.relayJob!]).toMatchObject({ queue: 'dev', session: 'resume', input: 'feedback' });
    expect(wf.jobs[wf.relayJob!]!.counter).toBeUndefined();
  });

  it('gives each call a workflow of its own: a test that changes a job changes no other workflow', () => {
    const a = defaultWorkflow();
    a.jobs.dev!.onSuccess = {};
    a.limits.verifyAttempts = 1;
    expect(defaultWorkflow().jobs.dev!.onSuccess).toEqual({ move: 'ai_review', post: 'summary', run: 'review' });
    expect(defaultWorkflow().limits.verifyAttempts).toBe(4);
  });

  it("refuses factory.yml's settings for a step the preset does not have, as the loader did", () => {
    expect(() => defaultWorkflow({ effort: { perStep: { nope: 'low' } } })).toThrow('claude.effort.per_step.nope: not an agent step of factory/default');
  });
});
