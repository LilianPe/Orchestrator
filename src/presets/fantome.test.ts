import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import { asFantome, fantome, projectEffects } from './fantome.js';
import { compilePreset, PresetError, type Preset } from './preset.js';

const packDir = join(import.meta.dirname, '../../packs/standard');

describe('the factory/fantome preset (ORC-231)', () => {
  it('compiles at the Rapide level: no human gate, no clarify, the run ends at its publication', () => {
    const { preset } = compilePreset(fantome);
    expect(preset).toMatchObject({ name: 'factory/fantome', level: 'rapide', entry: 'intake' });
    expect(preset.steps.some((s) => s.type === 'human_gate')).toBe(false);
    expect(preset.steps.map((s) => s.id)).toEqual(['intake', 'spec_draft', 'spec_check', 'tests', 'red', 'freeze_tests', 'build', 'verify', 'publish']);
    expect(preset.steps.find((s) => s.id === 'publish')).toMatchObject({ type: 'publish', mode: 'push', next: null });
  });

  it('a preset at the Rapide level with a human gate is refused: nobody answers a closed ticket', () => {
    const gated: Preset = { ...fantome, steps: fantome.steps.map((s) => (s.id === 'spec_check' ? { ...s, next: 'gate' } : s)).concat({ id: 'gate', type: 'human_gate', gate: 'spec', next: 'tests' }) };
    expect(() => compilePreset(gated)).toThrow(PresetError);
    expect(() => compilePreset(gated)).toThrow(/rapide.*human gate/);
  });

  it('the workflow it drives: delegation runs intake, intake the spec, the spec the tests, and dev ends at its publication', () => {
    const wf = asFantome(loadWorkflow({ packDir }));
    expect(wf.level).toBe('rapide');
    expect(wf.on['ticket.delegated']).toEqual([expect.objectContaining({ run: 'intake' })]);
    expect(wf.jobs['intake']!.onSuccess).toEqual({ run: 'spec' });
    expect(wf.jobs['spec']!.onSuccess).toEqual({ run: 'tests' });
    expect(wf.jobs['tests']!.onSuccess).toEqual({ run: 'dev' });
    expect(wf.jobs['dev']).toMatchObject({ onStart: {}, onSuccess: {} });
    // The bounds are the preset's.
    expect(wf.limits).toMatchObject({ specCheckReturns: 1, verifyAttempts: 4 });
  });

  it('a project on the fantome preset never has effects; another has none only when it says so', () => {
    expect(projectEffects({ preset: 'factory/fantome' })).toBe('none');
    expect(projectEffects({ effects: 'none' })).toBe('none');
    expect(projectEffects({ preset: 'factory/default' })).toBeUndefined();
    expect(projectEffects({})).toBeUndefined();
  });
});
