import { describe, expect } from 'vitest';
import type { CheckRunner } from '../../src/adapters/checks/types.js';
import { contractCases, subjectWith, type ContractOptions } from './cases.js';

export interface FailingCommand {
  command: string;
  exitCode: number;
  /** Text the command prints, that its failure must carry. */
  output: string;
}

/** What the implementation under test arranged for the suite. Docs: docs/ports/check-runner.md. */
export interface CheckRunnerSubject {
  checks: CheckRunner;
  cwd: string;
  /** A command that passes. */
  pass: string;
  /** Two commands that fail with distinct exit codes. */
  fails: [FailingCommand, FailingCommand];
  /** A command that outlives a 200 ms timeout; absent, the timeout case is skipped. */
  slow?: string;
  /** A folder where no command can start (a missing one, say); absent, the case is skipped. */
  unstartableCwd?: string;
  /** A command that passes, and how many times it has run so far; absent, the replay case is skipped. */
  counted?: { command: string; runs: () => Promise<number> };
}

export function describeCheckRunnerContract(
  name: string,
  make: () => CheckRunnerSubject | Promise<CheckRunnerSubject>,
  options?: ContractOptions,
): void {
  describe(`CheckRunner contract: ${name}`, () => {
    const { it, end } = contractCases(options);

    it('no command is a pass', async () => {
      const s = await make();
      expect(await s.checks.run(s.cwd, [])).toEqual({ ok: true, failures: [] });
    });

    it('passes when every command passes', async () => {
      const s = await make();
      expect(await s.checks.run(s.cwd, [s.pass, s.pass])).toEqual({ ok: true, failures: [] });
    });

    it('reports a failing command with its exit code and output', async () => {
      const s = await make();
      const [fail] = s.fails;
      const r = await s.checks.run(s.cwd, [s.pass, fail.command]);
      expect(r.ok).toBe(false);
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0]).toMatchObject({ command: fail.command, exitCode: fail.exitCode });
      expect(r.failures[0]!.output).toContain(fail.output);
    });

    it('runs every command and reports the failures in order', async () => {
      const s = await make();
      const [a, b] = s.fails;
      const r = await s.checks.run(s.cwd, [b.command, s.pass, a.command]);
      expect(r.ok).toBe(false);
      expect(r.failures.map((f) => [f.command, f.exitCode])).toEqual([[b.command, b.exitCode], [a.command, a.exitCode]]);
    });

    it('a command that outlives the timeout fails without an exit code', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'slow');
      const r = await s.checks.run(s.cwd, [s.slow], 200);
      expect(r.ok).toBe(false);
      expect(r.failures).toEqual([expect.objectContaining({ command: s.slow, exitCode: null })]);
    });

    it('a command that cannot start fails without an exit code, and run does not reject', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'unstartableCwd');
      const [fail] = s.fails;
      const r = await s.checks.run(s.unstartableCwd, [s.pass, fail.command]).catch((e: unknown) => e);
      expect(r).toEqual({
        ok: false,
        failures: [expect.objectContaining({ command: s.pass, exitCode: null }), expect.objectContaining({ command: fail.command, exitCode: null })],
      });
    });

    it('replaying runs the commands again', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'counted');
      const before = await s.counted.runs();
      await s.checks.run(s.cwd, [s.counted.command]);
      await s.checks.run(s.cwd, [s.counted.command]);
      expect((await s.counted.runs()) - before).toBe(2);
    });

    end();
  });
}
