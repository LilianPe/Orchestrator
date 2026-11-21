import { describe, expect, it } from 'vitest';
import { defaultWorkflow } from '../presets/workflow.js';
import { FrozenFormatError, frozenWorkflow, workflowVersion } from './workflow-version.js';

describe('frozenWorkflow (ORC-393)', () => {
  it('reads back a version of the current format', () => {
    const v = workflowVersion(defaultWorkflow());
    expect(frozenWorkflow(JSON.parse(JSON.stringify(v)) as typeof v)).toEqual(v.definition);
  });

  it('refuses a version of another format, the v1 frozen before the preset drove the chain among them', () => {
    const { hash, definition } = workflowVersion(defaultWorkflow());
    for (const version of [1, 3, undefined]) {
      expect(() => frozenWorkflow({ hash, definition: { ...definition, version } })).toThrow(new FrozenFormatError(`workflow version ${hash.slice(0, 12)} is of format ${String(version)}, not 2: its ticket is refused (format 1: frozen before ORC-393)`));
    }
    expect(() => frozenWorkflow({ hash, definition: null })).toThrow(/of format undefined/);
  });

  it('launches the skills a version frozen before ORC-460 named by their new names: the pack no longer has the old ones', () => {
    const current = defaultWorkflow();
    const old = JSON.parse(JSON.stringify(current).replaceAll('"factory:build"', '"factory:dev"').replaceAll('"factory:spec_draft"', '"factory:spec"')) as typeof current;
    old.jobs['fix-ci']!.skill = 'factory:fix-ci';
    expect(JSON.stringify(old.jobs)).toMatch(/factory:dev"[\s\S]*factory:fix-ci"/);
    expect(frozenWorkflow(workflowVersion(old)).jobs).toEqual(current.jobs);
  });
});
