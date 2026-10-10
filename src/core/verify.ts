import { spawn } from 'node:child_process';
import type { VerifyFailure } from './types.js';

export interface VerifyResult {
  ok: boolean;
  failures: VerifyFailure[];
}

export type Verifier = (cwd: string, commands: string[], timeoutMs?: number) => Promise<VerifyResult>;

function runOne(cwd: string, command: string, timeoutMs: number): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
      finish(null);
    }, timeoutMs);
    child.on('error', (err) => finish(null, String(err)));
    child.on('close', (code) => finish(code));
  });
}

export const runVerify: Verifier = async (cwd, commands, timeoutMs = 15 * 60_000) => {
  const failures: VerifyFailure[] = [];
  for (const command of commands) {
    const { exitCode, output } = await runOne(cwd, command, timeoutMs);
    if (exitCode !== 0) failures.push({ command, exitCode, output });
  }
  return { ok: failures.length === 0, failures };
};
