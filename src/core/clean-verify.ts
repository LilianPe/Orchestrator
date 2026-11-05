import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execCmd, mustExec, type Exec } from '../adapters/exec.js';
import { DEFAULT_REQUIREMENTS, type SandboxMount, type SandboxProvider } from '../adapters/sandbox/types.js';
import { checkFrozen, FREEZE_CHECK, isFrozenHarness, type FrozenTests } from '../checks/freeze.js';
import { checkForbiddenPaths, FORBIDDEN_CHECK } from '../checks/forbidden-paths.js';
import { mdCode } from '../checks/markdown.js';
import { parseRepoConfig, type RepoConfig } from '../config/repo-config.js';
import { BUNDLE_TARGET, extractWork, HARDENING, hostGitEnv, IN_SANDBOX, IN_SANDBOX_ENV } from '../publish/extract.js';
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
  /** The attempt's: its sandboxes are `<runId>-bundle`, `<runId>-prepare`, `<runId>-verify-setup` and `<runId>-verify`, so `recover()` finds them among the dead. */
  runId: string;
  ticketId: string;
  branch: string;
  /** The agent's worktree: mounted in the sandbox that makes the bundle, and nowhere else. */
  worktree: string;
  /** The repository's git dir, where the worktree's `.git` points, read-only; absent when it is inside the worktree. */
  gitDir?: string;
  /** On the host, empty, and the caller's to remove: where the engine can mount from. */
  workDir: string;
  /** Where the base branch is read, not the refs of the repository, which the agent can write. */
  originUrl: string;
  /** The workflow's, the factory's own (`jobs.<job>.verify`, `workspace.setup`): what `.factory/config.yml` does not declare, until ORC-177. */
  setup: readonly string[];
  commands: readonly string[];
  /** The commit `verify` last found green: found again, it is not checked again. */
  green?: string;
  /** `factory/secrets`, by the image's gitleaks. Only an isolation test on a public image without it turns it off. */
  gitleaks: boolean;
  /** `factory/tests-gelés` (ORC-131), once the ticket has a freeze. */
  frozen?: FrozenTests;
  /** The variables the repository declares (ORC-211), never a secret. */
  env: (config: RepoConfig) => Promise<Record<string, string>>;
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

/** `work`, or a rejection past `ms`: what it left running is `onExpiry`'s, and `recover()`'s. It never waits for an engine it gave up on. */
export function within<T>(work: Promise<T>, ms: number, message: string, onExpiry?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onExpiry?.();
      reject(new Error(message));
    }, ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

type Boxes = Pick<SandboxProvider, 'create' | 'exec' | 'destroy'>;

/** `sandboxes`, whose `create` and `exec` give up on an engine silent past `ms`. An `exec` also destroys its sandbox: the only way a stuck one ends. */
export function withDeadline(sandboxes: Boxes, ms: number): Boxes {
  const silent = `le sandbox ne répond plus après ${ms / 1000} s`;
  return {
    create: (req) => within(sandboxes.create(req), ms, silent),
    exec: (id, argv, opts) => within(sandboxes.exec(id, argv, opts), ms, silent, () => void sandboxes.destroy(id).catch(() => {})),
    destroy: (id) => within(sandboxes.destroy(id), ms, silent),
  };
}

/** A sandbox at network `none` for `work`, gone before the next one opens. */
export const boxOpener = (sandboxes: Boxes, of: { runId: string; ticketId: string; log: (message: string) => void }) => async <T>(suffix: string, workspacePath: string, mounts: readonly SandboxMount[], work: (id: string) => Promise<T>): Promise<T> => {
  const { id } = await sandboxes.create({ runId: `${of.runId}-${suffix}`, ticketId: of.ticketId, workspacePath, network: 'none', requirements: DEFAULT_REQUIREMENTS, mounts });
  try {
    return await work(id);
  } finally {
    await sandboxes.destroy(id).catch((err: Error) => of.log(`sandbox ${id} not destroyed: ${err.message}`));
  }
};

/**
 * `verify` out of the agent's reach (ORC-151). The agent's code never runs where the engine's socket or the daemon's
 * env is, and the factory's tools never run on a tree it wrote:
 *
 * 1. in a sandbox of its own, without network, `git bundle` of the branch: its head is the frozen SHA;
 * 2. on the host, `git bundle verify` and a clone without checkout, without the repository's config;
 * 3. the base branch fetched into the clone from the forge, and `.factory/config.yml` read on it, never on the agent's
 *    branch nor on a ref of the repository it can write. Every read of the clone happens here, before any code of the
 *    agent has run in it, the checks of the commit included;
 * 4. in a new sandbox at network `none`, gitleaks on the commits, then the checkout;
 * 5. the commands, in a new sandbox on that clone, at network `none`, with nothing else mounted.
 *
 * `setup`, which has to install, runs before them in its own sandbox at `limited`, without a secret: it is sealed like
 * the attempt's (`runSealedSetup`), on commits nobody reviewed, and never on a commit the checks already refused. It
 * rejects on any failure, the setup's included: an install that fails can be a registry down, and what cannot be told
 * from a breakdown is never sent to the agent.
 */
export const runCleanVerify: CleanVerifier = async (req) => {
  const deadlineMs = req.deadlineMs ?? VERIFY_TIMEOUT_MS + DEADLINE_GRACE_MS;
  const sandboxes = withDeadline(req.sandboxes, deadlineMs);
  const inBox = boxOpener(sandboxes, req);

  const bundleDir = join(req.workDir, 'bundle');
  const cloneDir = join(req.workDir, 'clone');
  mkdirSync(bundleDir);
  try {
    const mounts = [{ host: bundleDir, target: BUNDLE_TARGET, readOnly: false }, ...(req.gitDir ? [{ host: req.gitDir, target: req.gitDir, readOnly: true }] : [])];
    const { sha } = await inBox('bundle', req.worktree, mounts, (sandboxId) =>
      extractWork({ sandboxes, sandboxId, branch: req.branch, bundleDir, cloneDir, ...(req.exec ? { exec: req.exec } : {}) }),
    );

    const git = cloneGit(req, cloneDir);
    const tree = await git('rev-parse', `${sha}^{tree}`);
    if (sha === req.green) return { ok: true, failures: [], sha, tree };
    await within(fetchBase(req, cloneDir), deadlineMs, `la forge ne répond plus après ${deadlineMs / 1000} s`);
    const config = parseRepoConfig(await show(git, BASE, CONFIG));
    const declared = Object.values(config.commands);
    const commands = declared.length ? declared : req.commands;
    const setup = config.setup ? [config.setup] : req.setup;
    const env = await req.env(config);
    const from = await git('merge-base', BASE, sha).catch(() => EMPTY_TREE);
    const failures = await checkClone(git, from, sha, req.frozen);
    if (req.gitleaks || (commands.length && !failures.length)) {
      await inBox('prepare', cloneDir, [], async (id) => {
        if (req.gitleaks) failures.push(...(await scanSecrets(sandboxes, id, from, sha)));
        // Refused already: nothing of it is installed or run. A forbidden `.npmrc` would be read by the install it forbids, and a breakdown of that install would hide the verdict.
        if (failures.length || !commands.length) return;
        // `-c`: the clone's config is ours, and from the first command on it is no longer to be trusted.
        const out = await sandboxes.exec(id, ['git', ...IN_SANDBOX, 'checkout', '--quiet', '--detach', sha]);
        if (out.code !== 0) throw new Error(`git checkout (sandbox) : ${out.stderr.trim()}`);
      });
    }
    if (failures.length || !commands.length) return { ok: !failures.length, failures, sha, tree };

    if (setup.length) {
      await runSealedSetup(sandboxes, { runId: `${req.runId}-verify`, ticketId: req.ticketId, workspacePath: cloneDir, mounts: [], commands: setup, argv: verifyCommand, env, secrets: {}, now: new Date() });
    }
    await inBox('verify', cloneDir, [], async (id) => {
      for (const command of commands) {
        const { code, stdout, stderr } = await sandboxes.exec(id, verifyCommand(command), { env });
        // 124: the cap's, whose failure stays the agent's (a test that hangs), as on the host.
        if (code !== 0) failures.push({ command, exitCode: code === 124 ? null : code, output: stdout + stderr });
      }
    });
    return { ok: !failures.length, failures, sha, tree };
  } finally {
    // Not synchronous: a clone holds a whole install, and the daemon serves meanwhile. Under a run dir, purged with it: what the attack left unremovable costs no verdict.
    await Promise.all(
      [bundleDir, cloneDir].map((dir) => rm(dir, { recursive: true, force: true }).catch((err: Error) => req.log(`${dir} not removed: ${err.message}`))),
    );
  }
};

export const BASE = 'refs/factory/base';
const CONFIG = '.factory/config.yml';

/**
 * The forge's default branch, in the clone. The daemon's own config is read, for its credentials: the repository's is
 * not, as nothing here runs in it, and the clone's is ours. Neither `origin/HEAD` nor `origin/main` of the repository:
 * its git dir is mounted read-write for the agent, which could point them at a config of its own.
 */
async function fetchBase(req: CleanVerifyRequest, cloneDir: string): Promise<void> {
  const args = [...HARDENING.flatMap((c) => ['-c', c]), '-C', cloneDir, 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--', req.originUrl, `+HEAD:${BASE}`];
  try {
    await mustExec(req.exec ?? execCmd, 'git', args, { env: { GIT_TERMINAL_PROMPT: '0' } });
  } catch (err) {
    // eslint-disable-next-line preserve-caught-error -- its message holds the URL and its credentials: it stays out of what is journaled.
    throw new Error(`branche de base non lue : ${withoutCredentials((err as Error).message, req.originUrl)}`);
  }
}

/** The message goes to the journal and to the ticket: neither the URL, which can carry a token, nor what git quotes of one. */
function withoutCredentials(message: string, url: string): string {
  return message.replaceAll(url, 'origin').replace(/\/\/[^/\s@]+@/g, '//***@');
}

/** Git's empty tree: what a branch that shares no commit with the base is compared with, every file of it then a change. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SYMLINK = '120000';
const MAX_READ_BYTES = 16 * 1024 * 1024;
const SECRETS_CHECK = 'factory/secrets';
const BINARY_CHECK = 'factory/binaires';
const LEAKS_FOUND = 7;

/**
 * The commits the branch adds, by gitleaks in a sandbox of its own, before any code of the agent has run: the clone has no
 * checkout, so neither a `.gitleaks.toml` nor a `.gitleaksignore` of the branch is read, and the `gitleaks:allow` it could
 * write is ignored. The report is redacted. Measured on 8.30.1: a failing `git log` leaves an empty report, exit 0, and
 * only an error on stderr. So anything but a clean exit with a readable report is a breakdown, never a green.
 */
export async function scanSecrets(sandboxes: Boxes, id: string, from: string, sha: string): Promise<VerifyFailure[]> {
  // Plain `git log -p` shows no patch for a merge, where a secret can be added: what it changed beyond the clean merge, and only that.
  const logOpts = `--diff-merges=remerge ${from === EMPTY_TREE ? sha : `${from}..${sha}`}`;
  const argv = ['timeout', String(VERIFY_TIMEOUT_MS / 1000), 'gitleaks', 'git', `--log-opts=${logOpts}`, '--no-banner', '--redact', '--ignore-gitleaks-allow', '--exit-code', String(LEAKS_FOUND), '--report-format', 'json', '--report-path', '-', '--log-level', 'error', '.'];
  const env = { GIT_AUTHOR_NAME: 'factory', GIT_AUTHOR_EMAIL: 'factory@localhost', GIT_COMMITTER_NAME: 'factory', GIT_COMMITTER_EMAIL: 'factory@localhost', ...IN_SANDBOX_ENV };
  const { code, stdout, stderr } = await sandboxes.exec(id, argv, { env });
  if ((code !== 0 && code !== LEAKS_FOUND) || stderr.trim()) throw new Error(`gitleaks n'a pas pu tourner (code ${code}) : ${stderr.trim()}`);
  let found: { File: string; StartLine: number; RuleID: string }[];
  try {
    found = JSON.parse(stdout) as typeof found;
    if (!Array.isArray(found)) throw new Error('not a list');
  } catch {
    throw new Error(`gitleaks n'a pas rendu de rapport lisible (code ${code})`);
  }
  if (code === 0 && !found.length) return [];
  const lines = found.map((f) => `- ${f.File}:${f.StartLine} (${f.RuleID})`);
  return [{ command: SECRETS_CHECK, exitCode: 1, output: `Secret codé en dur dans les commits de la branche, publication bloquée. Retire-le de son historique, et considère-le comme exposé :\n${lines.join('\n')}` }];
}

/**
 * The blocking checks on the commit, from the clone's objects: `factory/chemins-interdits` and `factory/binaires` on all it
 * changed since it left the base, whatever it says of its own history, and `factory/tests-gelés` on the frozen files as they are at
 * its head, which needs no frozen commit: a rebase can take it away, not its fingerprints. A read that fails rejects.
 */
export async function checkClone(git: CloneGit, from: string, sha: string, frozen: FrozenTests | undefined): Promise<VerifyFailure[]> {
  const showAtHead = (p: string) => show(git, sha, p);
  // `--raw`: status and modes in one process, `:<old mode> <new mode> <old id> <new id> <status>`, then the path.
  const fields = (await git('diff', '--raw', '--no-renames', '-z', from, sha)).split('\0').filter(Boolean);
  const changed = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, mode, , , status] = fields[i]!.split(' ');
    const path = fields[i + 1]!;
    changed.push({ path, deleted: status === 'D', ...(mode === SYMLINK ? { link: (await showAtHead(path))! } : {}) });
  }
  const forbidden = await checkForbiddenPaths({ changed, showAtBase: (p) => show(git, from, p), showAtHead });
  const failures: VerifyFailure[] = forbidden.ok ? [] : [{ command: FORBIDDEN_CHECK, exitCode: 1, output: forbidden.summary }];
  const binaries = await binariesAdded(git, from, sha);
  if (binaries.length) failures.push({ command: BINARY_CHECK, exitCode: 1, output: `Fichier binaire dans le diff, publication bloquée. Retire-le de la branche :\n${binaries.map((p) => `- ${mdCode(p)}`).join('\n')}` });
  if (frozen) {
    const atHead = (await git('ls-tree', '-r', '--name-only', '-z', sha)).split('\0').filter(Boolean);
    const listed = new Set(atHead);
    const paths = [...new Set([...Object.keys(frozen.files), ...atHead.filter(isFrozenHarness)])];
    const r = await checkFrozen(frozen, { head: sha, changed: paths.map((path) => ({ path, deleted: !listed.has(path) })), filesAtHead: async () => atHead, showAtHead });
    if (!r.ok) failures.push({ command: FREEZE_CHECK, exitCode: 1, output: r.summary });
  }
  return failures;
}

/**
 * What the diff adds as binary, on git's own reading: a NUL in a file's start. Read in a clone without a worktree, so no `.gitattributes` of the branch says
 * otherwise. `-z`, as a path can hold anything: `<added>\t<removed>\t<path>`, both counts `-` for a binary.
 */
async function binariesAdded(git: CloneGit, from: string, sha: string): Promise<string[]> {
  const lines = (await git('diff', '--numstat', '--no-renames', '--diff-filter=d', '-z', from, sha)).split('\0').filter(Boolean);
  return lines.filter((l) => l.startsWith('-\t-\t')).map((l) => l.slice(4));
}

/**
 * A file of a commit; undefined when it has none. A blob the agent made huge never comes into the daemon's memory: as
 * itself, by its id, it reads as changed.
 */
async function show(git: CloneGit, rev: string, path: string): Promise<string | undefined> {
  const entry = /^\d+ (\w+) (\w+)\s+(\d+)?/.exec(await git('ls-tree', '-l', '-z', rev, '--', path));
  if (entry?.[1] !== 'blob') return undefined;
  return Number(entry[3]) > MAX_READ_BYTES ? `\0too large: ${entry[2]}` : git.raw('show', `${rev}:${path}`);
}

/** Its output trimmed; `raw` as git wrote it, for what is compared by its bytes: a file's content, a link's target. */
export type CloneGit = ((...args: string[]) => Promise<string>) & { raw: (...args: string[]) => Promise<string> };

export function cloneGit(req: Pick<CleanVerifyRequest, 'workDir' | 'exec'>, cloneDir: string): CloneGit {
  const env = hostGitEnv(req.workDir, req.workDir);
  const exec = req.exec ?? execCmd;
  const raw = (...args: string[]) => mustExec(exec, 'git', [...HARDENING.flatMap((c) => ['-c', c]), '-C', cloneDir, ...args], { env });
  return Object.assign(async (...args: string[]) => (await raw(...args)).trim(), { raw });
}
