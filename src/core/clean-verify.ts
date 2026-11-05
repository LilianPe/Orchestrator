import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execCmd, mustExec, type Exec, type ExecResult } from '../adapters/exec.js';
import { DEFAULT_REQUIREMENTS, type Sandbox, type SandboxMount, type SandboxProvider } from '../adapters/sandbox/types.js';
import { BUNDLE_TARGET, extractWork, HARDENING } from '../publish/extract.js';
import { runSealedSetup } from './sealed-setup.js';
import type { VerifyFailure } from './types.js';
import { VERIFY_TIMEOUT_MS, type VerifyResult } from './verify.js';

/** Its coreutils' grace after the cap: a command that ignores the signal is killed. */
const KILL_AFTER_S = 10;
/** What a command's output may weigh on its way to the daemon: its tail, which `exec` holds in memory. */
const OUTPUT_TAIL_BYTES = 256 * 1024;
/** Past each command's own cap: only a sandbox that no longer answers is still there. */
const DEADLINE_GRACE_MS = 60_000;

export interface CleanVerifyRequest {
  sandboxes: SandboxProvider;
  /** The attempt's: its sandboxes are `<runId>-bundle`, `<runId>-verify-setup` and `<runId>-verify`, so `recover()` finds them among the dead. */
  runId: string;
  ticketId: string;
  branch: string;
  /** The agent's worktree: mounted in the sandbox that makes the bundle, and nowhere else. */
  worktree: string;
  /** The repository's git dir, where the worktree's `.git` points, read-only; absent when it is inside the worktree. */
  gitDir?: string;
  /** On the host, empty, and the caller's to remove: where the engine can mount from. */
  workDir: string;
  setup: readonly string[];
  commands: readonly string[];
  /** The variables the repository declares (ORC-211), never a secret. */
  env: Record<string, string>;
  log: (message: string) => void;
  deadlineMs?: number;
  exec?: Exec;
}

export type CleanVerifyResult = VerifyResult & { sha: string; tree: string };

/** A verdict on the commit: rejecting means there is none, an infrastructure failure the agent is not sent. */
export type CleanVerifier = (req: CleanVerifyRequest) => Promise<CleanVerifyResult>;

/**
 * A verification command as it runs in its sandbox: under its cap, killed if it ignores the cap, with its output's
 * tail alone reaching the daemon. A process it left holding the pipe is the deadline's: `exec` would not return.
 */
export function verifyCommand(command: string): string[] {
  const script = `timeout -k ${KILL_AFTER_S} ${VERIFY_TIMEOUT_MS / 1000} bash -lc "$1" 2>&1 | tail -c ${OUTPUT_TAIL_BYTES}; exit "\${PIPESTATUS[0]}"`;
  return ['bash', '-c', script, 'verify', command];
}

/** `sandboxes`, whose `exec` gives up on a sandbox silent past `ms`, and destroys it: that is the only way a stuck exec ends. */
function withDeadline(sandboxes: SandboxProvider, ms: number): SandboxProvider {
  const exec = async (id: string, argv: readonly string[], opts?: Parameters<SandboxProvider['exec']>[2]): Promise<ExecResult> => {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void sandboxes.destroy(id).catch(() => {}).then(() => reject(new Error(`le sandbox ne répond plus après ${ms / 1000} s`)));
      }, ms);
    });
    try {
      return await Promise.race([sandboxes.exec(id, argv, opts), expired]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    create: (req) => sandboxes.create(req),
    exec,
    spawnCommand: (id, argv, opts) => sandboxes.spawnCommand(id, argv, opts),
    findByAttempt: (runId) => sandboxes.findByAttempt(runId),
    reattach: (runId) => sandboxes.reattach(runId),
    list: () => sandboxes.list(),
    destroy: (id) => sandboxes.destroy(id),
  };
}

/**
 * `verify` out of the agent's reach (ORC-151). The agent's code never runs where the engine's socket or the daemon's
 * env is, and the factory's tools never run on a tree it wrote:
 *
 * 1. in a sandbox of its own, without network, `git bundle` of the branch: its head is the frozen SHA;
 * 2. on the host, `git bundle verify` and a clone without checkout, without the repository's config;
 * 3. every read of the clone happens here, before any code of the agent has run in it;
 * 4. the checkout and the commands, in a new sandbox on that clone, at network `none`, with nothing else mounted.
 *
 * `setup`, which has to install, runs first in its own sandbox at `limited`, without a secret: it is sealed like the
 * attempt's (`runSealedSetup`), on commits nobody reviewed. It rejects on any failure, the setup's included: an
 * install that fails can be a registry down, and what cannot be told from a breakdown is never sent to the agent.
 */
export const runCleanVerify: CleanVerifier = async (req) => {
  const sandboxes = withDeadline(req.sandboxes, req.deadlineMs ?? VERIFY_TIMEOUT_MS + DEADLINE_GRACE_MS);
  const destroy = (box: Sandbox | undefined) => box && sandboxes.destroy(box.id).catch((err: Error) => req.log(`sandbox ${box.id} not destroyed: ${err.message}`));
  const open = (suffix: string, workspacePath: string, mounts: readonly SandboxMount[]) =>
    sandboxes.create({ runId: `${req.runId}-${suffix}`, ticketId: req.ticketId, workspacePath, network: 'none', requirements: DEFAULT_REQUIREMENTS, mounts });

  const bundleDir = join(req.workDir, 'bundle');
  const cloneDir = join(req.workDir, 'clone');
  mkdirSync(bundleDir);
  let box: Sandbox | undefined;
  try {
    box = await open('bundle', req.worktree, [
      { host: bundleDir, target: BUNDLE_TARGET, readOnly: false },
      ...(req.gitDir ? [{ host: req.gitDir, target: req.gitDir, readOnly: true }] : []),
    ]);
    const { sha } = await extractWork({ sandboxes, sandboxId: box.id, branch: req.branch, bundleDir, cloneDir, ...(req.exec ? { exec: req.exec } : {}) });
    await destroy(box);
    box = undefined;
    rmSync(bundleDir, { recursive: true, force: true });

    const tree = await cloneGit(req, cloneDir)('rev-parse', `${sha}^{tree}`);
    if (!req.commands.length) return { ok: true, failures: [], sha, tree };

    // `-c` on the command line: the clone's config is ours, and from the first command on it is no longer to be trusted.
    const checkout = ['git', ...SANDBOX_GIT, 'checkout', '--quiet', '--detach', sha];
    if (req.setup.length) {
      await runSealedSetup(sandboxes, {
        runId: `${req.runId}-verify`,
        ticketId: req.ticketId,
        workspacePath: cloneDir,
        mounts: [],
        commands: [checkout.map(shellWord).join(' '), ...req.setup],
        env: req.env,
        secrets: {},
        now: new Date(),
      });
    }
    box = await open('verify', cloneDir, []);
    if (!req.setup.length) {
      const out = await sandboxes.exec(box.id, checkout);
      if (out.code !== 0) throw new Error(`git checkout (sandbox) : ${out.stderr.trim()}`);
    }
    const failures: VerifyFailure[] = [];
    for (const command of req.commands) {
      const { code, stdout, stderr } = await sandboxes.exec(box.id, verifyCommand(command), { env: req.env });
      // 124: the cap's, whose failure stays the agent's (a test that hangs), as on the host.
      if (code !== 0) failures.push({ command, exitCode: code === 124 ? null : code, output: stdout + stderr });
    }
    return failures.length ? { ok: false, failures, sha, tree } : { ok: true, failures, sha, tree };
  } finally {
    await destroy(box);
    // Under a run dir, purged with it: a clone the attack left unremovable costs no verdict.
    for (const dir of [bundleDir, cloneDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        req.log(`${dir} not removed: ${(err as Error).message}`);
      }
    }
  }
};

/** Git in a sandbox, whose bind mounts are the host's uid: no hook, no fsmonitor, on a clone it did not make. */
const SANDBOX_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'safe.directory=*'];

const shellWord = (word: string): string => `'${word}'`;

/** Git on the clone, on the host, as `extractWork`'s: no config but the hardening, outside any other repository. */
function cloneGit(req: CleanVerifyRequest, cloneDir: string): (...args: string[]) => Promise<string> {
  const globalConfig = join(req.workDir, 'gitconfig');
  writeFileSync(globalConfig, '');
  const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig, GIT_CEILING_DIRECTORIES: req.workDir };
  const exec = req.exec ?? execCmd;
  return async (...args) => (await mustExec(exec, 'git', [...HARDENING.flatMap((c) => ['-c', c]), '-C', cloneDir, ...args], { env })).trim();
}
