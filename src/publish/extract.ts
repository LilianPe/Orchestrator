import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execCmd, HARDENING, mustExec, type Exec } from '../adapters/exec.js';
import type { SandboxProvider } from '../adapters/sandbox/types.js';

/**
 * Where the caller mounts `bundleDir` read-write in the sandbox (decided at its creation). A file,
 * not the sandbox's stdout: `exec` returns utf8 strings, which mangle a binary bundle, and a whole
 * repository's history held in memory has no ceiling. The agent can write in that dir too, so the
 * bundle is only ever read as data: checked to be a plain file, then verified.
 */
export const BUNDLE_TARGET = '/factory/bundle';
const BUNDLE = 'work.bundle';
export { HARDENING };

/** The sandbox's git, on the agent's repository: `devNull` is the host's, and the mount's owner may not be its user. */
const SANDBOX_CONFIG = [['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false'], ['safe.directory', '*']] as const;
export const IN_SANDBOX = SANDBOX_CONFIG.flatMap(([key, value]) => ['-c', `${key}=${value}`]);
/** The same, for a tool that runs git itself. */
export const IN_SANDBOX_ENV: Record<string, string> = {
  GIT_CONFIG_COUNT: String(SANDBOX_CONFIG.length),
  ...Object.fromEntries(SANDBOX_CONFIG.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])),
};

/** Host git reads no config but ours (an empty global one, written in `configDir`, no system one), and looks for no repository above `ceiling`. */
export function hostGitEnv(configDir: string, ceiling: string): Record<string, string> {
  const globalConfig = join(configDir, 'gitconfig');
  writeFileSync(globalConfig, '');
  return { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig, GIT_CEILING_DIRECTORIES: ceiling };
}

export interface ExtractRequest {
  sandboxes: Pick<SandboxProvider, 'exec'>;
  sandboxId: string;
  branch: string;
  /** On the host, mounted at `bundleTarget` in the sandbox. */
  bundleDir: string;
  bundleTarget?: string;
  /** Must not exist: the fresh clone lands here, and is removed on any failure. */
  cloneDir: string;
  exec?: Exec;
}

/**
 * The agent's commits on `branch`, out of its sandbox into a fresh clone (ORC-286): no factory tool
 * ever runs on a tree the agent wrote. The clone has no checkout (no smudge filter, no checkout
 * hook): callers read objects (`git diff a b`, `git show sha:path`), not files. Returns the branch head;
 * the clone is at `cloneDir`.
 */
export async function extractWork(o: ExtractRequest): Promise<{ sha: string }> {
  const ref = `refs/heads/${o.branch}`;
  const inSandbox = async (...args: string[]) => {
    const r = await o.sandboxes.exec(o.sandboxId, ['git', ...IN_SANDBOX, ...args]);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} (sandbox): ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  const sha = await inSandbox('rev-parse', '--verify', `${ref}^{commit}`);
  // Named by its ref alone, the bundle carries the whole history: no prerequisite, so verifying and
  // cloning it need no repository on the host (`cloneBundle`).
  await inSandbox('bundle', 'create', `${o.bundleTarget ?? BUNDLE_TARGET}/${BUNDLE}`, ref);
  const { sha: head } = await cloneBundle({ bundle: join(o.bundleDir, BUNDLE), branch: o.branch, cloneDir: o.cloneDir, ...(o.exec ? { exec: o.exec } : {}) });
  if (head !== sha) {
    rmSync(o.cloneDir, { recursive: true, force: true });
    throw new Error(`bundle head ${head} is not the branch head ${sha} reported by the sandbox`);
  }
  return { sha };
}

/** A bundle that is not one of the branch: it does not verify, or does not carry the branch. Any other failure is the host's. */
export class BundleInvalid extends Error {
  override name = 'BundleInvalid';
}

export interface CloneBundleRequest {
  /** A file on the host that someone else wrote: the agent's sandbox, or a human after a take-over (ORC-234). */
  bundle: string;
  branch: string;
  /** Must not exist: the fresh clone lands here, and is removed on any failure. */
  cloneDir: string;
  exec?: Exec;
}

/**
 * A bundle into a fresh clone, on the host, as data: checked to be a plain file, `git bundle verify` in an empty repository
 * of ours, then a clone without checkout, fsck on. Host git runs no hook and no fsmonitor, reads no config but ours, and
 * starts outside any repository. A bundle that needs commits it does not carry fails the verify. Returns the branch's head.
 */
export async function cloneBundle(o: CloneBundleRequest): Promise<{ sha: string }> {
  if (!lstatSync(o.bundle, { throwIfNoEntry: false })?.isFile()) throw new BundleInvalid(`${o.bundle} is not a plain file`);
  if (existsSync(o.cloneDir)) throw new Error(`${o.cloneDir} already exists`);
  const scratch = mkdtempSync(join(tmpdir(), 'factory-extract-'));
  const env = hostGitEnv(scratch, dirname(scratch));
  const exec = o.exec ?? execCmd;
  const onHost = async (...args: string[]) =>
    (await mustExec(exec, 'git', [...HARDENING.flatMap((c) => ['-c', c]), ...args], { cwd: scratch, env })).trim();
  try {
    // `bundle verify` wants a repository even for a bundle without prerequisites: an empty one of ours.
    const empty = join(scratch, 'empty.git');
    await onHost('init', '--quiet', '--bare', '--template=', empty);
    // A git that ran and said no is the bundle's fault (`BundleInvalid`); one that did not run throws as it is, the host's.
    const ofBundle = async (...args: string[]) => {
      const r = await exec('git', [...HARDENING.flatMap((c) => ['-c', c]), ...args], { cwd: scratch, env });
      if (r.code !== 0) throw new BundleInvalid(r.stderr.trim().slice(0, 500) || `git ${args[0]}: code ${r.code}`);
      return r.stdout.trim();
    };
    if (!(await ofBundle('-C', empty, 'bundle', 'list-heads', o.bundle, `refs/heads/${o.branch}`))) throw new BundleInvalid(`no refs/heads/${o.branch} in the bundle`);
    await ofBundle('-C', empty, 'bundle', 'verify', '--quiet', o.bundle);
    // fsck: someone else wrote these objects. --config keeps the hardening in the clone's own config,
    // for whoever runs git in it next.
    await ofBundle('-c', 'transfer.fsckObjects=true', 'clone', '--quiet', '--no-checkout', '--template=', `--branch=${o.branch}`,
      ...HARDENING.flatMap((c) => ['--config', c]), '--', o.bundle, o.cloneDir);
    return { sha: await onHost('-C', o.cloneDir, 'rev-parse', 'HEAD') };
  } catch (e) {
    rmSync(o.cloneDir, { recursive: true, force: true });
    throw e;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
