import type { WorkflowOverrides } from './workflow-with.js';

/**
 * Minimal test preset: one fake agent step, one fake check step, and the bounded counter between
 * them, over `factory/default`'s workflow (`workflowWith`).
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
  workflow: WorkflowOverrides;
}

export function testPreset(opts: { verifyAttempts?: number; ciFixAttempts?: number } = {}): TestPreset {
  const verifyAttempts = opts.verifyAttempts ?? 2;
  const ciFixAttempts = opts.ciFixAttempts ?? 2;
  // The engine treats 0 as 1: refused here so property tests see one meaning.
  if (!Number.isInteger(verifyAttempts) || verifyAttempts < 1) throw new Error('verifyAttempts must be a positive integer');
  if (!Number.isInteger(ciFixAttempts) || ciFixAttempts < 0) throw new Error('ciFixAttempts must be a non-negative integer');
  const build: TestStep = { name: 'build', kind: 'agent', job: 'dev' };
  const verify: TestStep = { name: 'verify', kind: 'check', commands: ['fake:check'], bound: 'verifyAttempts' };
  return {
    steps: [build, verify],
    bounds: { verifyAttempts, ciFixAttempts },
    workflow: { limits: { verifyAttempts, ciFixAttempts }, verify: verify.commands },
  };
}
