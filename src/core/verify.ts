import type { VerifyFailure } from './types.js';

/** The check run of `verify`'s commands, on the commit the factory pushed (ORC-151). */
export const VERIFY_CHECK = 'factory/verify';

export interface VerifyResult {
  ok: boolean;
  failures: VerifyFailure[];
  /** The tree of the commit a failure was found on, out of the agent's worktree (`runCleanVerify`, ORC-187). */
  tree?: string;
}

/**
 * Runs `commands` in `cwd`: the commands of a daemon without sandboxes, the fake runner's or a test's stand-in, which runs
 * nothing of the agent's (ORC-179). With sandboxes, `runCleanVerify` checks a frozen commit in a sandbox of its own (ORC-151).
 * `env`: what the commands get beyond the system, the variables the repository declares (ORC-211).
 * `warn`: told when something the result relies on cannot be read.
 */
export type Verifier = (cwd: string, commands: string[], timeoutMs?: number, env?: Record<string, string>, warn?: (message: string) => void) => Promise<VerifyResult>;

/*
 * `bash -c`, never `-lc`, in a sandbox (ORC-324): a login shell runs the image's profile and logout files, whose output
 * joins the command's, which goes to the agent and into what the factory publishes. The PATH is the image's, which Debian's
 * `/etc/profile` would even reset, dropping `/factory/app/bin`. `--norc`: bash still reads `~/.bashrc` for `-c` when its
 * stdin is a socket (its rsh/ssh guess).
 */

/** Each command's cap, in a sandbox. */
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
