import { factoryDefault } from './factory-default.js';
import { compilePreset, type Preset, type Step } from './preset.js';

/** Who approves a spec at the Rapide level (ORC-231): the preset itself, as its approval records it. */
export const FANTOME_APPROVER = 'factory/fantome';

/** A step of `factory/default`, as it is there: the fantome changes only where a step leads. */
function stepOf(id: string, over: Partial<Step> = {}): Step {
  const step = factoryDefault.steps.find((s) => s.id === id);
  if (!step) throw new Error(`factory/default has no step ${id}`);
  return { ...step, ...over } as Step;
}

/**
 * The `factory/fantome` preset (ORC-231), a variant of `factory/default` for the replay of closed tickets: level Rapide, nobody
 * answers. No `clarify` (its questions are assumed), no spec gate (the preset approves a spec that passes `spec_check`), and the
 * run ends at its publication, which the no-effect mode keeps as an artifact: no AI review, no merge gate, no merge. Its
 * workflow (`presetWorkflow`) walks these steps: delegation runs `intake`, then the spec, the tests and `build`, at its level.
 */
export const fantome: Preset = {
  ...factoryDefault,
  name: 'factory/fantome',
  level: 'rapide',
  counters: { spec_check: factoryDefault.counters['spec_check']!, red: factoryDefault.counters['red']!, verify: factoryDefault.counters['verify']! },
  // Never reached: nothing is pushed, so no CI turns red and no conflict arises. Required by the preset's shape.
  redCi: { goto: 'build', counter: 'verify' },
  conflict: { goto: 'build', counter: 'verify' },
  // Nothing moves nor is posted at the Rapide level: a replayed ticket is closed, nobody reads it.
  statuses: {},
  posts: {},
  steps: [
    stepOf('intake', { next: 'spec_draft' }),
    stepOf('spec_draft'),
    stepOf('spec_check', { next: 'tests' }),
    stepOf('tests'),
    stepOf('red'),
    stepOf('freeze_tests'),
    stepOf('build'),
    stepOf('verify'),
    stepOf('publish', { next: null }),
  ],
};

/** A project that replays closed tickets (ORC-376): on the fantome preset. Only the daemon's delegations reach it, never Linear's. */
export const isFantome = (p: { preset?: string | undefined }): boolean => p.preset === fantome.name;

/** A project's effects (ORC-231): none when it says so, or when it runs the fantome preset, which never has any. */
export function projectEffects(p: { effects?: 'none' | undefined; preset?: string | undefined }): 'none' | undefined {
  return p.effects === 'none' || isFantome(p) ? 'none' : undefined;
}

// Compiled once, at load, as `factory/default` is: a preset that breaks an invariant of the core never drives a workflow.
compilePreset(fantome);
