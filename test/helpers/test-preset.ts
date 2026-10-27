import { stringify } from 'yaml';

/**
 * Minimal test preset: one fake agent step, one fake check step, and the bounded counter between
 * them. It overlays the standard pack until `factory/default` (ORC-187) replaces the YAML workflow.
 * `build` is the `dev` job and the jobs that extend it (`dev-feedback`, `fix-ci`): each of their runs
 * is followed by `verify`, as in the engine, so a resumed run after a block is checked again.
 */
export type TestStep =
  | { name: 'build'; kind: 'agent'; job: string }
  | { name: 'verify'; kind: 'check'; commands: string[]; bound: keyof TestPreset['bounds'] };

export interface TestPreset {
  steps: readonly TestStep[];
  /**
   * `verifyAttempts`: the ticket is blocked at the N-th failed check, after N - 1 resumed runs.
   * `ciFixAttempts`: red CI starts `fix-ci` N times; the next red CI blocks the ticket (0 blocks at the first).
   */
  bounds: { verifyAttempts: number; ciFixAttempts: number };
  yaml: string;
}

export function testPreset(opts: { verifyAttempts?: number; ciFixAttempts?: number } = {}): TestPreset {
  const verifyAttempts = opts.verifyAttempts ?? 2;
  const ciFixAttempts = opts.ciFixAttempts ?? 2;
  // The schema accepts 0, which the engine treats as 1: refused here so property tests see one meaning.
  if (!Number.isInteger(verifyAttempts) || verifyAttempts < 1) throw new Error('verifyAttempts must be a positive integer');
  if (!Number.isInteger(ciFixAttempts) || ciFixAttempts < 0) throw new Error('ciFixAttempts must be a non-negative integer');
  const build: TestStep = { name: 'build', kind: 'agent', job: 'dev' };
  const verify: TestStep = { name: 'verify', kind: 'check', commands: ['fake:check'], bound: 'verifyAttempts' };
  return {
    steps: [build, verify],
    bounds: { verifyAttempts, ciFixAttempts },
    yaml: stringify({ version: 1, limits: { verify_attempts: verifyAttempts, ci_fix_attempts: ciFixAttempts }, jobs: { [build.job]: { verify: verify.commands } } }),
  };
}
