import { describe, expect, it } from 'vitest';
import { nextOf, startMove } from '../core/chain.js';
import { presetWorkflow } from './workflow.js';
import { fantome, projectEffects } from './fantome.js';
import { compilePreset, PresetError, type Preset } from './preset.js';

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

  it('the workflow it drives, by its own steps: delegation runs intake, intake the spec, the spec the tests, and dev ends at its publication', () => {
    const wf = presetWorkflow(fantome);
    expect(wf).toMatchObject({ level: 'rapide', entry: 'intake', preset: fantome });
    expect(wf.on['ticket.delegated']).toEqual([expect.objectContaining({ run: 'intake', whenSrc: '!blocked' })]);
    // Nothing else starts a job: a closed ticket's state, or a human on the real one, never does.
    expect(Object.keys(wf.on)).toEqual(['ticket.delegated']);
    expect(Object.keys(wf.jobs)).toEqual(['intake', 'dev', 'spec', 'tests', 'ask']);
    const end = (job: string) => nextOf(wf, wf.jobs[job]!);
    expect(end('intake').run?.name).toBe('spec');
    // Its spec is approved by the preset (no gate): `spec_check` leads to the tests.
    expect(end('spec').run?.name).toBe('tests');
    expect(end('tests').run?.name).toBe('dev');
    // Nothing moves nor is posted at the Rapide level: a replayed ticket is closed.
    expect(end('dev')).toEqual({ step: null });
    expect(startMove(wf, wf.jobs['dev']!)).toBeUndefined();
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
