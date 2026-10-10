import { spawn } from 'node:child_process';
import type { VerifyFailure } from './types.js';

export interface VerifyResult {
  ok: boolean;
  failures: VerifyFailure[];
}

export type Verifier = (cwd: string, commands: string[], timeoutMs?: number) => Promise<VerifyResult>;

function runOne(cwd: string, command: string, timeoutMs: number): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : code, output });
    });
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
