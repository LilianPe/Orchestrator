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

  it("refuses factory.yml's settings for a step the preset does not have, as the loader does", () => {
    expect(() => defaultWorkflow({ effort: { perStep: { nope: 'low' } } })).toThrow('claude.effort.per_step.nope: not an agent step of factory/default');
  });
});
