import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow, type StepSettings } from '../config/load-workflow.js';
import { hashCanonical } from '../runtime/workflow-version.js';
import { defaultWorkflow } from './workflow.js';

const packDir = join(import.meta.dirname, '../../packs/standard');

describe('defaultWorkflow (ORC-388)', () => {
  // The safety net of ORC-177's later parts: built in TypeScript, the workflow is the pack's, so no ticket decides otherwise.
  it('is the workflow of the standard pack, its hash included', () => {
    const pack = loadWorkflow({ packDir });
    expect(defaultWorkflow()).toEqual(pack);
    expect(hashCanonical(defaultWorkflow())).toBe(hashCanonical(pack));
  });

  it("applies factory.yml's step settings as the loader does", () => {
    const settings: StepSettings = {
      effort: { default: 'high', perStep: { build: 'low' } },
      budgets: { maxTurns: { fix: 20 }, perStepTokens: { review: 50_000 } },
      tools: { perStep: { build: ['Read', 'Edit', 'Write'] } },
    };
    const pack = loadWorkflow({ packDir, settings });
    expect(defaultWorkflow(settings)).toEqual(pack);
    expect(hashCanonical(defaultWorkflow(settings))).toBe(hashCanonical(pack));
  });

  // What the loader refused in a YAML file, held by the TypeScript table on its own: it stays once the pack goes (ORC-389).
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

  it('gives each workflow rules and limits of its own', () => {
    const [a, b] = [defaultWorkflow(), defaultWorkflow()];
    expect(a.on).not.toBe(b.on);
    expect(a.limits.perRun).not.toBe(b.limits.perRun);
  });

  it("refuses factory.yml's settings for a step the preset does not have, as the loader does", () => {
    expect(() => defaultWorkflow({ effort: { perStep: { nope: 'low' } } })).toThrow('claude.effort.per_step.nope: not an agent step of factory/default');
  });
});
