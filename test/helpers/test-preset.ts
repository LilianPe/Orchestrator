/**
 * Minimal test preset: one fake agent step, one fake check step, and the bounded counter between
 * them. It overlays the standard pack until `factory/default` (ORC-187) replaces the YAML workflow.
 */
export type TestStep =
  | { name: 'build'; kind: 'agent'; job: string }
  | { name: 'verify'; kind: 'check'; commands: string[]; bound: keyof TestPreset['bounds'] };

export interface TestPreset {
  name: 'test/minimal';
  steps: readonly TestStep[];
  /** `verifyAttempts`: the ticket is blocked at the N-th failed check, after N - 1 resumed runs. */
  bounds: { verifyAttempts: number };
  yaml: string;
}

export function testPreset(opts: { verifyAttempts?: number } = {}): TestPreset {
  const verifyAttempts = opts.verifyAttempts ?? 2;
  if (!Number.isInteger(verifyAttempts) || verifyAttempts < 1) throw new Error('verifyAttempts must be a positive integer');
  const commands = ['fake:check'];
  return {
    name: 'test/minimal',
    steps: [
      { name: 'build', kind: 'agent', job: 'dev' },
      { name: 'verify', kind: 'check', commands, bound: 'verifyAttempts' },
    ],
    bounds: { verifyAttempts },
    yaml: [
      'version: 1',
      'limits:',
      `  verify_attempts: ${verifyAttempts}`,
      'jobs:',
      `  dev: { verify: ${JSON.stringify(commands)} }`,
      '',
    ].join('\n'),
  };
}
