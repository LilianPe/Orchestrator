import { open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_REQUIREMENTS, type SandboxMount, type SandboxProvider } from '../adapters/sandbox/types.js';
import { VERIFY_TIMEOUT_MS } from './verify.js';

/**
 * A version younger than this is refused at install (ORC-211): a package compromised and published this
 * week has not reached the worktree. The doc gives no value; a week, until someone calibrates it.
 */
export const RELEASE_AGE_DAYS = 7;

/**
 * What every `setup` runs under, by the environment since `setup` is the repository's own command line:
 * no install script (npm, pnpm, Yarn), wheels only (pip, uv, which still builds the project itself),
 * nothing younger than `RELEASE_AGE_DAYS`. Measured on npm 11.19, pnpm 10.20, Yarn 1.22 and 4.5, uv 0.13:
 * pnpm reads `npm_config_*` and not `pnpm_config_*`; `npm ci` keeps its lockfile whatever `before` says;
 * `YARN_IGNORE_SCRIPTS`, which Yarn 1 would read, makes Yarn 4 refuse to run (see `YARN1_NO_SCRIPTS`).
 */
export function setupEnv(now: Date): Record<string, string> {
  const cutoff = new Date(now.getTime() - RELEASE_AGE_DAYS * 86_400_000).toISOString();
  return {
    npm_config_ignore_scripts: 'true',
    YARN_ENABLE_SCRIPTS: 'false',
    PIP_ONLY_BINARY: ':all:',
    UV_NO_BUILD: '1',
    npm_config_minimum_release_age: String(RELEASE_AGE_DAYS * 24 * 60),
    npm_config_before: cutoff,
    UV_EXCLUDE_NEWER: cutoff,
  };
}

/** Yarn 1, in the node images, takes it from no variable that Yarn 4 accepts: its own rc file, in a `$HOME` gone with the container. */
export const YARN1_NO_SCRIPTS = ['sh', '-c', `mkdir -p "$HOME" && printf 'ignore-scripts true\\n' > "$HOME/.yarnrc"`];

const CHUNK = 1024 * 1024;

/** The secret as written, and as the tools that store one write it: base64, in a URL, in JSON. */
function spellings(secret: string): Buffer[] {
  const forms = [secret, Buffer.from(secret).toString('base64'), encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)];
  return [...new Set(forms)].map((f) => Buffer.from(f));
}

async function holdsOne(path: string, needles: readonly Buffer[]): Promise<boolean> {
  const overlap = Math.max(...needles.map((n) => n.length)) - 1;
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK + overlap);
    let kept = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, kept, CHUNK);
      if (bytesRead === 0) return false;
      const seen = buffer.subarray(0, kept + bytesRead);
      if (needles.some((n) => seen.includes(n))) return true;
      kept = Math.min(overlap, seen.length);
      seen.copy(buffer, 0, seen.length - kept);
    }
  } finally {
    await file.close();
  }
}

/**
 * Purges from the disk every file under `roots` that holds one of `secrets`, and gives their paths
 * (never the values). A link is not followed: its target may be out of the tree. A file it cannot read
 * is purged too: what cannot be checked does not stay. It finds the spellings above, not a secret hashed
 * or encoded otherwise.
 */
export async function sealSecrets(roots: readonly string[], secrets: readonly string[]): Promise<string[]> {
  const needles = secrets.filter(Boolean).flatMap(spellings);
  const purged: string[] = [];
  if (!needles.length) return purged;
  const pending = [...roots];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      if (!entry.isFile()) continue;
      const found = await holdsOne(path, needles).catch(() => true);
      if (!found) continue;
      await unlink(path);
      purged.push(path);
    }
  }
  return purged;
}

export interface SealedSetupRequest {
  /** The attempt's: the setup's container is `<runId>-setup`, so `recover()` finds it among the dead. */
  runId: string;
  ticketId: string;
  workspacePath: string;
  /** What it mounts beside the worktree: the repository's git dir, read-only, so neither a secret nor a hook is written there for the agent to find. */
  mounts: readonly SandboxMount[];
  commands: readonly string[];
  env: Record<string, string>;
  secrets: Record<string, string>;
  now: Date;
}

/**
 * The repository's `setup` (ORC-211): in a container of its own, the only place its secrets are, through
 * the environment of each `exec`, never a mount nor the engine's command line. The container is destroyed
 * first, with its layer, its `/tmp`, its `$HOME` and every process the setup left behind; then the disk it
 * shared, the worktree, is sealed. Only then may the agent get a sandbox. A failed setup is sealed as well.
 * ponytail: at `limited` (registries, GitHub read), so a secret has nowhere to be sent; the doc's `full`
 * when a repository needs more (docs/decisions/ORC-213.md, open point 2).
 */
export async function runSealedSetup(sandboxes: SandboxProvider, req: SealedSetupRequest): Promise<{ purged: string[] }> {
  const box = await sandboxes.create({
    runId: `${req.runId}-setup`,
    ticketId: req.ticketId,
    workspacePath: req.workspacePath,
    network: 'limited',
    requirements: DEFAULT_REQUIREMENTS,
    mounts: req.mounts,
  });
  const env = { ...req.env, ...req.secrets, ...setupEnv(req.now) };
  let failure: Error | undefined;
  try {
    // Its exit does not matter: an image with no writable `$HOME` has no Yarn config either.
    await sandboxes.exec(box.id, YARN1_NO_SCRIPTS);
    for (const command of req.commands) {
      const { code } = await sandboxes.exec(box.id, cappedCommand(command), { env });
      if (code === 124) throw new Error(`Le setup du worktree a échoué : ${command} (délai de ${VERIFY_TIMEOUT_MS / 60_000} min dépassé)`);
      if (code !== 0) throw new Error(`Le setup du worktree a échoué : ${command}`);
    }
  } catch (err) {
    failure = err as Error;
  }
  // Not caught: a container still alive holds the secret and can still write it, no agent may start.
  await sandboxes.destroy(box.id);
  const purged = await sealSecrets([req.workspacePath], Object.values(req.secrets));
  if (failure) throw failure;
  return { purged };
}

/** `command` in a sandbox under the host's cap (runVerify), by coreutils' `timeout` in the image: 124 is its exit on expiry. */
export function cappedCommand(command: string): string[] {
  return ['timeout', String(VERIFY_TIMEOUT_MS / 1000), 'bash', '-lc', command];
}
