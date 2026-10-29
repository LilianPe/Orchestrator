import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { VerifyFailure } from './types.js';

export interface VerifyResult {
  ok: boolean;
  failures: VerifyFailure[];
  /** Fingerprint of the worktree content, on a failure in a git worktree (ORC-187). */
  tree?: string;
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
  if (failures.length === 0) return { ok: true, failures };
  const tree = await worktreeTree(cwd);
  return { ok: false, failures, ...(tree ? { tree } : {}) };
};

const git = promisify(execFile);

/**
 * The git tree of the worktree as it is, untracked files included: equal trees mean an unchanged diff.
 * Written through a throwaway index, so the worktree's own index is never touched. Undefined outside git.
 */
async function worktreeTree(cwd: string): Promise<string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), 'factory-tree-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
  try {
    // Starting from a copy of the real index, git only hashes the files changed since it was written.
    const index = resolve(cwd, (await git('git', ['rev-parse', '--git-path', 'index'], { cwd })).stdout.trim());
    if (existsSync(index)) copyFileSync(index, env.GIT_INDEX_FILE);
    await git('git', ['add', '-A'], { cwd, env });
    return (await git('git', ['write-tree'], { cwd, env })).stdout.trim();
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
