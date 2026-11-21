import { spawn } from 'node:child_process';
import { systemEnv } from '../../src/adapters/exec.js';
import type { VerifyFailure } from '../../src/core/types.js';
import { VERIFY_TIMEOUT_MS, type Verifier } from '../../src/core/verify.js';

/**
 * A check runner that runs its commands with `bash` on the test's machine: the honest base the negative controls of the
 * check-runner contract break one way each. Test code only: the factory never runs a check on its host (ORC-179).
 */
export const bashChecks: Verifier = async (cwd, commands, timeoutMs = VERIFY_TIMEOUT_MS, env = {}) => {
  const failures: VerifyFailure[] = [];
  for (const command of commands) {
    const { exitCode, output } = await runOne(cwd, command, timeoutMs, env);
    if (exitCode !== 0) failures.push({ command, exitCode, output });
  }
  return { ok: failures.length === 0, failures };
};

function runOne(cwd: string, command: string, timeoutMs: number, env: Record<string, string>): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['--norc', '-c', command], { cwd, env: { ...systemEnv(process.env), ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let done = false;
    const finish = (exitCode: number | null, extra = ''): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode, output: output + extra });
    };
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      finish(null);
    }, timeoutMs);
    child.on('error', (err) => finish(null, String(err)));
    child.on('close', (code) => finish(code));
  });
}
