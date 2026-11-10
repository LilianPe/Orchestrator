import type { Workflow } from '../config/workflow-schema.js';
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
 * run ends at its publication, which the no-effect mode keeps as an artifact: no AI review, no merge gate, no merge.
 */
export const fantome: Preset = {
  ...factoryDefault,
  name: 'factory/fantome',
  level: 'rapide',
  counters: { spec_check: factoryDefault.counters['spec_check']!, red: factoryDefault.counters['red']!, verify: factoryDefault.counters['verify']! },
  // Never reached: nothing is pushed, so no CI turns red and no conflict arises. Required by the preset's shape.
  redCi: { goto: 'build', counter: 'verify' },
  conflict: { goto: 'build', counter: 'verify' },
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

/** A project's effects (ORC-231): none when it says so, or when it runs the fantome preset, which never has any. */
export function projectEffects(p: { effects?: 'none' | undefined; preset?: string | undefined }): 'none' | undefined {
  return p.effects === 'none' || p.preset === fantome.name ? 'none' : undefined;
}

const compiled = compilePreset(fantome).preset;
const bound = (counter: string) => compiled.counters[counter]!.limit;

/**
 * The workflow the fantome drives, until the engine runs the preset's steps itself (ORC-177): delegation runs `intake`, `intake`
 * the spec, the spec the tests, the tests `dev`, whose publication ends the run (no move, no AI review). Its level and its bounds
 * are the preset's.
 */
export function asFantome(wf: Workflow): Workflow {
  const job = (name: string) => {
    const j = wf.jobs[name];
    if (!j) throw new Error(`the workflow has no job ${name}: the fantome runs intake, spec, tests and dev`);
    return j;
  };
  return {
    ...wf,
    level: 'rapide',
    on: { ...wf.on, 'ticket.delegated': (wf.on['ticket.delegated'] ?? []).map((r) => ({ ...r, run: 'intake' })) },
    jobs: {
      ...wf.jobs,
      intake: { ...job('intake'), onSuccess: { run: 'spec' } },
      spec: { ...job('spec'), onSuccess: { run: 'tests' } },
      tests: { ...job('tests'), onSuccess: { run: 'dev' } },
      dev: { ...job('dev'), onStart: {}, onSuccess: {} },
    },
    limits: { ...wf.limits, verifyAttempts: bound('verify') + 1, specCheckReturns: bound('spec_check') },
  };
}
