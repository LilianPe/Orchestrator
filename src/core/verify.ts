import { execFile, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { HARDENING, systemEnv } from '../adapters/exec.js';
import { ANSI } from '../checks/log-excerpt.js';
import type { VerifyFailure } from './types.js';

/** The check run of `verify`'s commands, on the commit the factory pushed (ORC-151). */
export const VERIFY_CHECK = 'factory/verify';

export interface VerifyResult {
  ok: boolean;
  failures: VerifyFailure[];
  /** Fingerprint of the worktree content, on a failure in a git worktree (ORC-187). */
  tree?: string;
}

/**
 * `env`: what the commands get beyond the system, the variables the repository declares (ORC-211).
 * `warn`: told when a failure's worktree fingerprint cannot be read (ORC-319).
 */
export type Verifier = (cwd: string, commands: string[], timeoutMs?: number, env?: Record<string, string>, warn?: (message: string) => void) => Promise<VerifyResult>;

/*
 * `bash -c`, never `-lc`, here and in a sandbox (ORC-324): a login shell runs the machine's profile and logout files,
 * whose output (a clear-screen on Git for Windows) joins the command's, which goes to the agent and into what the
 * factory publishes. The PATH is given, not read from a profile: the daemon's on the host (`systemEnv`), the image's in
 * a sandbox, which Debian's `/etc/profile` would even reset, dropping `/factory/app/bin`. `--norc`: bash still reads
 * `~/.bashrc` for `-c` when its stdin is a socket (its rsh/ssh guess), as the pipes Node gives a child on Linux are.
 */
function runOne(cwd: string, command: string, timeoutMs: number, env: Record<string, string>): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    // No credential of the daemon: these commands run what the agent wrote (ORC-211).
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

/** `command` in a sandbox under the same cap, or `seconds`, by coreutils' `timeout` in the image: 124 is its exit on expiry. */
export function cappedCommand(command: string, seconds = VERIFY_TIMEOUT_MS / 1000): string[] {
  return ['timeout', String(seconds), 'bash', '--norc', '-c', command];
}

/**
 * The exit of a command started at `startedAt` under the default cap (`cappedCommand`, `verifyCommand`), `null` when it met it (ORC-348), as the factory's own clock
 * tells it: a failure once the cap has passed, 124 or the 137 of a command killed after ignoring the TERM (`timeout -k`).
 * Before it, any code is the command's, a 124 of its own included.
 */
export function cappedExit(code: number, startedAt: number): number | null {
  return code !== 0 && Date.now() - startedAt >= VERIFY_TIMEOUT_MS ? null : code;
}

export const runVerify: Verifier = async (cwd, commands, timeoutMs = VERIFY_TIMEOUT_MS, env = {}, warn) => {
  const failures: VerifyFailure[] = [];
  for (const command of commands) {
    const { exitCode, output } = await runOne(cwd, command, timeoutMs, env);
    if (exitCode !== 0) failures.push({ command, exitCode, output });
  }
  if (failures.length === 0) return { ok: true, failures };
  // Taken after the commands: files they write and git does not ignore change it, which only disables the guard.
  const tree = await worktreeTree(cwd, warn);
  return { ok: false, failures, ...(tree ? { tree } : {}) };
};

const git = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const HARDENED = HARDENING.flatMap((c) => ['-c', c]);

/**
 * What a warning says of a failed git: its timeout, or the last line of its stderr, where git puts its `fatal:` after
 * any warning. Cut, without escape sequence or control character: a filter of the agent writes there too, and forges no line.
 */
function readFailure(err: unknown): string {
  const { stderr, killed } = err as { stderr?: string; killed?: boolean };
  if (killed) return `timed out after ${GIT_TIMEOUT_MS / 1000} s`;
  return (stderr?.trim() || String(err)).split('\n').at(-1)!.replace(ANSI, '').replace(/\p{Cc}/gu, '').trim().slice(0, 200);
}

/**
 * The git tree of the worktree as it is, untracked files included: equal trees mean an unchanged diff.
 * Written through a throwaway index, so the worktree's own index is never touched. Undefined outside git, or on a
 * failure, told to `warn`. Hardened, and without the daemon's credentials: the agent writes the repository's config (ORC-319).
 */
async function worktreeTree(cwd: string, warn?: (message: string) => void): Promise<string | undefined> {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'factory-tree-'));
    mkdirSync(join(dir, 'objects'));
    const system = systemEnv(process.env);
    const run = async (args: string[], env = system) => (await git('git', [...HARDENED, ...args], { cwd, timeout: GIT_TIMEOUT_MS, env })).stdout.trim();
    const [index, objects] = (await run(['rev-parse', '--git-path', 'index', '--git-path', 'objects'])).split('\n');
    // Throwaway index and object store: the blobs go to `dir`, the repository's own objects are only read.
    const env = {
      ...system,
      GIT_INDEX_FILE: join(dir, 'index'),
      GIT_OBJECT_DIRECTORY: join(dir, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: resolve(cwd, objects!),
    };
    // Starting from a copy of the real index, git only hashes the files changed since it was written.
    const realIndex = resolve(cwd, index!);
    // Read before the copy, in nanoseconds: a date too old only rehashes a file more, while `mtime` and `mtimeMs` round up, past the second.
    const stat = statSync(realIndex, { bigint: true, throwIfNoEntry: false });
    if (stat) {
      copyFileSync(realIndex, env.GIT_INDEX_FILE);
      // Dated as the real one, down to the second, or git no longer rehashes a file written in its second: an edit of the same size shows on no stat.
      const second = Number(stat.mtimeNs / 1_000_000_000n);
      utimesSync(env.GIT_INDEX_FILE, second, second);
    }
    // `--sparse`: without it, one file where a sparse checkout hides (`.claude/`) fails the whole `add`, and there is no fingerprint.
    // No ignore file of the daemon's user (`core.excludesFile`, by default `~/.config/git/ignore`): a file it lists, written by
    // the agent, would change no fingerprint, and the loop guard would block a ticket that changed (ORC-324). Empty, not
    // `/dev/null`, which Git Bash hands to Windows' git as `nul`, refused. The rest of the global and system config stays:
    // the images trust their worktrees there (`safe.directory`).
    await run(['-c', 'core.excludesFile=', 'add', '-A', '--sparse'], env);
    return await run(['write-tree'], env);
  } catch (err) {
    warn?.(`unreadable worktree fingerprint: ${readFailure(err)}; the loop guard does not see this failure.`);
    return undefined;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
