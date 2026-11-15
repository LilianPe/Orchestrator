import { describe, expect, it } from 'vitest';
import { defaultWorkflow } from '../presets/workflow.js';
import { frozenWorkflow, workflowVersion } from './workflow-version.js';

describe('frozenWorkflow (ORC-393)', () => {
  it('reads back a version of the current format', () => {
    const v = workflowVersion(defaultWorkflow());
    expect(frozenWorkflow(JSON.parse(JSON.stringify(v)) as typeof v)).toEqual(v.definition);
  });

  it('refuses a version of another format, the v1 frozen before the preset drove the chain among them', () => {
    const { hash, definition } = workflowVersion(defaultWorkflow());
    for (const version of [1, 3, undefined]) {
      expect(() => frozenWorkflow({ hash, definition: { ...definition, version } })).toThrow(`workflow version ${hash.slice(0, 12)} is of format ${String(version)}, not 2`);
    }
    expect(() => frozenWorkflow({ hash, definition: null })).toThrow(/of format undefined/);
  });
});
