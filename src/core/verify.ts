import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

/** Each command's cap, on the host and (setup) in a sandbox. */
export const VERIFY_TIMEOUT_MS = 15 * 60_000;

export const runVerify: Verifier = async (cwd, commands, timeoutMs = VERIFY_TIMEOUT_MS) => {
  const failures: VerifyFailure[] = [];
  for (const command of commands) {
    const { exitCode, output } = await runOne(cwd, command, timeoutMs);
    if (exitCode !== 0) failures.push({ command, exitCode, output });
  }
  if (failures.length === 0) return { ok: true, failures };
  // Taken after the commands: files they write and git does not ignore change it, which only disables the guard.
  const tree = await worktreeTree(cwd);
  return { ok: false, failures, ...(tree ? { tree } : {}) };
};

const git = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

/**
 * The git tree of the worktree as it is, untracked files included: equal trees mean an unchanged diff.
 * Written through a throwaway index, so the worktree's own index is never touched. Undefined outside git.
 */
async function worktreeTree(cwd: string): Promise<string | undefined> {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'factory-tree-'));
    mkdirSync(join(dir, 'objects'));
    const opts = { cwd, timeout: GIT_TIMEOUT_MS };
    const [index, objects] = (await git('git', ['rev-parse', '--git-path', 'index', '--git-path', 'objects'], opts)).stdout.trim().split('\n');
    // Throwaway index and object store: the blobs go to `dir`, the repository's own objects are only read.
    const env = {
      ...process.env,
      GIT_INDEX_FILE: join(dir, 'index'),
      GIT_OBJECT_DIRECTORY: join(dir, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: resolve(cwd, objects!),
    };
    // Starting from a copy of the real index, git only hashes the files changed since it was written.
    if (existsSync(resolve(cwd, index!))) copyFileSync(resolve(cwd, index!), env.GIT_INDEX_FILE);
    await git('git', ['add', '-A'], { ...opts, env });
    return (await git('git', ['write-tree'], { ...opts, env })).stdout.trim();
  } catch {
    return undefined;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
