import { open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_REQUIREMENTS, POSTGRES_USER, type SandboxMount, type SandboxProvider } from '../adapters/sandbox/types.js';
import { cappedCommand, VERIFY_TIMEOUT_MS } from './verify.js';

/**
 * A version younger than this is refused at install (ORC-211): a package compromised and published this
 * week has not reached the worktree. The doc gives no value; a week, until someone calibrates it.
 */
export const RELEASE_AGE_DAYS = 7;

const SETUP_HOME = '/tmp/setup-home';

/**
 * What every `setup` runs under, by the environment since `setup` is the repository's own command line:
 * no install script (npm, pnpm, Yarn), wheels only (pip, uv, which still builds the project itself),
 * nothing younger than `RELEASE_AGE_DAYS`. Measured on npm 11.19, pnpm 10.20, Yarn 1.22 and 4.5, uv 0.13:
 * pnpm reads `npm_config_*` and not `pnpm_config_*`; `npm ci` keeps its lockfile whatever `before` says;
 * `YARN_IGNORE_SCRIPTS`, which Yarn 1 would read, makes Yarn 4 refuse to run (see `YARN1_NO_SCRIPTS`).
 * `HOME` under `/tmp`: writable on any image, and gone with the container.
 */
export function setupEnv(now: Date): Record<string, string> {
  const cutoff = new Date(now.getTime() - RELEASE_AGE_DAYS * 86_400_000).toISOString();
  return {
    HOME: SETUP_HOME,
    npm_config_ignore_scripts: 'true',
    YARN_ENABLE_SCRIPTS: 'false',
    PIP_ONLY_BINARY: ':all:',
    UV_NO_BUILD: '1',
    npm_config_minimum_release_age: String(RELEASE_AGE_DAYS * 24 * 60),
    npm_config_before: cutoff,
    UV_EXCLUDE_NEWER: cutoff,
    // A fresh repository of the agent's has none (ORC-317): defence in depth, no hook runs with the secrets.
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_VALUE_1: 'false',
  };
}

/** Yarn 1, in the node images, takes it from no variable that Yarn 4 accepts: its own rc file, in a `$HOME` gone with the container. */
export const YARN1_NO_SCRIPTS = ['sh', '-c', `mkdir -p "$HOME" && printf 'ignore-scripts true\\n' > "$HOME/.yarnrc"`];

const CHUNK = 1024 * 1024;

/**
 * Base64 of the secret inside a longer value (`_auth`, a Docker config: `base64(user:token)`): at each of
 * the three alignments, without the characters at its edges, which its neighbours change. In both alphabets.
 */
function embeddedBase64(secret: string): string[] {
  return [0, 1, 2].flatMap((before) => {
    const b64 = Buffer.concat([Buffer.alloc(before), Buffer.from(secret)]).toString('base64');
    const left = [0, 2, 3][before]!;
    const over = (before + Buffer.byteLength(secret)) % 3;
    const core = b64.slice(left, over ? over - 3 - 1 : undefined);
    return [core, core.replaceAll('+', '-').replaceAll('/', '_')];
  });
}

/** The secret as written, and as the tools that store one write it: base64, in a URL, in JSON. */
function spellings(secret: string): Buffer[] {
  const forms = [secret, ...embeddedBase64(secret), encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)];
  return [...new Set(forms)].map((f) => Buffer.from(f));
}

/** Whether `data` holds one of `secrets`, in one of the spellings `sealSecrets` finds. */
export function holdsSecret(data: Buffer, secrets: readonly string[]): boolean {
  return secrets.filter(Boolean).flatMap(spellings).some((n) => data.includes(n));
}

/** `buffer`, of `CHUNK + overlap` bytes, is the caller's: one for the whole scan, not a megabyte per file of a `node_modules`. */
async function holdsOne(path: string, needles: readonly Buffer[], buffer: Buffer, overlap: number): Promise<boolean> {
  const file = await open(path, 'r');
  try {
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
 * or encoded otherwise. A root's own `.git` is left: mounted read-only for the setup, it cannot hold what the setup
 * wrote, and a pack purged for a value in the repository's history would break the repository.
 */
export async function sealSecrets(roots: readonly string[], secrets: readonly string[]): Promise<string[]> {
  const needles = secrets.filter(Boolean).flatMap(spellings);
  const purged: string[] = [];
  if (!needles.length) return purged;
  const overlap = Math.max(...needles.map((n) => n.length)) - 1;
  const buffer = Buffer.alloc(CHUNK + overlap);
  const pending = [...roots];
  const gitDirs = new Set(roots.map((root) => join(root, '.git')));
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
      if (entry.isDirectory() && !gitDirs.has(path)) pending.push(path);
      if (!entry.isFile()) continue;
      const found = await holdsOne(path, needles, buffer, overlap).catch(() => true);
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
  /** What it mounts beside the worktree: its git dir, read-only over it, so neither a secret nor a hook is written there for the agent to find. */
  mounts: readonly SandboxMount[];
  commands: readonly string[];
  /** A command as it runs: `cappedCommand` by default; `verifyCommand` on code nobody reviewed, whose output is capped too. */
  argv?: (command: string) => string[];
  env: Record<string, string>;
  secrets: Record<string, string>;
  /** The repository's (ORC-309): started for the attempt, `DATABASE_URL` in the setup's environment, kept for its agent. */
  services?: readonly string[];
  now: Date;
}

/**
 * The repository's `setup` (ORC-211): in a container of its own, the only place its secrets are, through
 * the environment of each `exec`, never a mount nor the engine's command line. The container is destroyed
 * first, with its layer, its `/tmp`, its `$HOME` and every process the setup left behind; then the disk it
 * shared, the worktree, is sealed. Only then may the agent get a sandbox. A failed setup is sealed as well.
 * Its services (ORC-309) are the attempt's (`servicesOf`), kept for the agent: with secrets, their database is dumped
 * once the setup's container is gone, and a secret found there fails the setup, which takes them with it.
 * ponytail: at `limited` (registries, GitHub read), so a secret has nowhere to be sent; the doc's `full`
 * when a repository needs more (docs/decisions/ORC-213.md, open point 2).
 */
export async function runSealedSetup(sandboxes: Pick<SandboxProvider, 'create' | 'exec' | 'destroy'>, req: SealedSetupRequest): Promise<{ purged: string[] }> {
  const services = req.services ?? [];
  const box = await sandboxes.create({
    runId: `${req.runId}-setup`,
    ticketId: req.ticketId,
    workspacePath: req.workspacePath,
    network: 'limited',
    requirements: { ...DEFAULT_REQUIREMENTS, services },
    ...(services.length ? { servicesOf: req.runId } : {}),
    mounts: req.mounts,
  });
  try {
    const purged = await setUpIn(sandboxes, box.id, req);
    if (services.length && Object.keys(req.secrets).length) await checkDatabase(sandboxes, box.services, req.secrets);
    return { purged };
  } catch (err) {
    // No agent follows a failed setup: its services go now, or at recover() if the engine fails here too.
    if (box.services) await sandboxes.destroy(box.services).catch(() => undefined);
    throw err;
  }
}

/** What dumps an attempt's Postgres, in its own container, through its socket. */
export const POSTGRES_DUMP = ['pg_dumpall', `--username=${POSTGRES_USER}`];

/**
 * The setup's database (ORC-309), which `sealSecrets` does not see: dumped and searched for the same spellings. A
 * secret transformed (hashed, encrypted, `bytea`) is not found, as on the disk. What cannot be dumped does not stay.
 */
async function checkDatabase(sandboxes: Pick<SandboxProvider, 'exec'>, services: string | undefined, secrets: Record<string, string>): Promise<void> {
  if (!services) throw new Error('The worktree setup failed: its database cannot be checked for the secrets');
  const dump = await sandboxes.exec(services, POSTGRES_DUMP, { cwd: '/' });
  if (dump.code !== 0) throw new Error(`The worktree setup failed: its database could not be checked for the secrets (${dump.stderr.trim()})`);
  const data = Buffer.from(dump.stdout);
  const found = Object.keys(secrets).filter((name) => holdsSecret(data, [secrets[name]!]));
  // Its name, never its value.
  if (found.length) throw new Error(`The worktree setup failed: a secret of the setup is in its database (${found.join(', ')})`);
}

async function setUpIn(sandboxes: Pick<SandboxProvider, 'exec' | 'destroy'>, id: string, req: SealedSetupRequest): Promise<string[]> {
  const env = { ...req.env, ...req.secrets, ...setupEnv(req.now) };
  let purged: string[];
  try {
    const rc = await sandboxes.exec(id, YARN1_NO_SCRIPTS, { env: { HOME: SETUP_HOME } });
    if (rc.code !== 0) throw new Error(`The worktree setup failed: Yarn 1 scripts not disabled (${rc.stderr.trim()})`);
    for (const command of req.commands) {
      const { code } = await sandboxes.exec(id, (req.argv ?? cappedCommand)(command), { env });
      if (code === 124) throw new Error(`The worktree setup failed: ${command} (timed out after ${VERIFY_TIMEOUT_MS / 60_000} min)`);
      if (code !== 0) throw new Error(`The worktree setup failed: ${command}`);
    }
  } finally {
    // Its failure wins over the setup's: a container still alive holds the secret and can still write it, no agent may start.
    await sandboxes.destroy(id);
    purged = await sealSecrets([req.workspacePath], Object.values(req.secrets));
  }
  return purged;
}
