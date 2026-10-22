import { describe, expect, it } from 'vitest';
import type { CheckRunner } from '../../src/adapters/checks/types.js';

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
}

export function describeCheckRunnerContract(name: string, make: () => CheckRunnerSubject | Promise<CheckRunnerSubject>): void {
  describe(`CheckRunner contract: ${name}`, () => {
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
      const s = await make();
      if (!s.slow) ctx.skip();
      const r = await s.checks.run(s.cwd, [s.slow!, s.pass], 200);
      expect(r.ok).toBe(false);
      expect(r.failures).toEqual([expect.objectContaining({ command: s.slow, exitCode: null })]);
    });
  });
}
