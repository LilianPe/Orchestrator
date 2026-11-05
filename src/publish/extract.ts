import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execCmd, mustExec, type Exec } from '../adapters/exec.js';
import type { SandboxProvider } from '../adapters/sandbox/types.js';

/**
 * Where the caller mounts `bundleDir` read-write in the sandbox (decided at its creation). A file,
 * not the sandbox's stdout: `exec` returns utf8 strings, which mangle a binary bundle, and a whole
 * repository's history held in memory has no ceiling. The agent can write in that dir too, so the
 * bundle is only ever read as data: checked to be a plain file, then verified.
 */
export const BUNDLE_TARGET = '/factory/bundle';
const BUNDLE = 'work.bundle';
/** No hook, no fsmonitor: on each host git command (`-c`), and in the clone's own config (`--config`). */
export const HARDENING = [`core.hooksPath=${devNull}`, 'core.fsmonitor=false'];

/** The sandbox's git, on the agent's repository: `devNull` is the host's, and the mount's owner may not be its user. */
const SANDBOX_CONFIG = [['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false'], ['safe.directory', '*']] as const;
export const IN_SANDBOX = SANDBOX_CONFIG.flatMap(([key, value]) => ['-c', `${key}=${value}`]);
/**
 * Git of the factory in an agent's repository, in its sandbox (ORC-317). Under a cap: `SandboxProvider.exec` has none, and
 * a filter the agent left there, which this git still runs, could otherwise hold a launch for good.
 */
export const sandboxGit = (sandboxes: Pick<SandboxProvider, 'exec'>, id: string) => (...args: string[]) =>
  sandboxes.exec(id, ['timeout', '-k', '10', String(SANDBOX_GIT_TIMEOUT_S), 'git', ...IN_SANDBOX, ...args]);
const SANDBOX_GIT_TIMEOUT_S = 120;
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
  // cloning it need no repository on the host.
  await inSandbox('bundle', 'create', `${o.bundleTarget ?? BUNDLE_TARGET}/${BUNDLE}`, ref);
  const bundle = join(o.bundleDir, BUNDLE);
  if (!lstatSync(bundle).isFile()) throw new Error(`${bundle} is not a plain file`);
  if (existsSync(o.cloneDir)) throw new Error(`${o.cloneDir} already exists`);

  // Host git runs no hook and no fsmonitor, and starts outside any repository.
  const scratch = mkdtempSync(join(tmpdir(), 'factory-extract-'));
  const env = hostGitEnv(scratch, dirname(scratch));
  const exec = o.exec ?? execCmd;
  const onHost = async (...args: string[]) =>
    (await mustExec(exec, 'git', [...HARDENING.flatMap((c) => ['-c', c]), ...args], { cwd: scratch, env })).trim();
  try {
    // `bundle verify` wants a repository even for a bundle without prerequisites: an empty one of ours.
    const empty = join(scratch, 'empty.git');
    await onHost('init', '--quiet', '--bare', '--template=', empty);
    await onHost('-C', empty, 'bundle', 'verify', '--quiet', bundle);
    // fsck: the agent wrote these objects. --config keeps the hardening in the clone's own config,
    // for whoever runs git in it next.
    await onHost('-c', 'transfer.fsckObjects=true', 'clone', '--quiet', '--no-checkout', '--template=', `--branch=${o.branch}`,
      ...HARDENING.flatMap((c) => ['--config', c]), '--', bundle, o.cloneDir);
    const head = await onHost('-C', o.cloneDir, 'rev-parse', 'HEAD');
    if (head !== sha) throw new Error(`bundle head ${head} is not the branch head ${sha} reported by the sandbox`);
    return { sha };
  } catch (e) {
    rmSync(o.cloneDir, { recursive: true, force: true });
    throw e;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
