import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execCmd, mustExec, type Exec } from '../adapters/exec.js';
import { NoCommitsBetween, type ForgeWriter } from '../adapters/forge/types.js';
import { PublishRefused, type BundlePush, type BundleRequest, type Publication, type Publisher, type PublishRequest } from '../adapters/publisher/types.js';
import { WORKSPACE_TARGET, type SandboxMount, type SandboxProvider } from '../adapters/sandbox/types.js';
import { RepoConfigError, REPO_CONFIG_PATH } from '../config/repo-config.js';
import { BASE, baseConfig, boxOpener, checkClone, cloneGit, forkPoint, isYes, scanSecrets, untrustedCheck, withDeadline, within, type UntrustedMark } from '../core/clean-verify.js';
import { BUNDLE_TARGET, cloneBundle, extractWork, HARDENING, hostGitEnv } from './extract.js';

/** Git and a scan, no command of the repository: a stop waits behind the publication, so it is not given `verify`'s time. */
const PUBLISH_DEADLINE_MS = 10 * 60_000;
const REMOTE_HEAD = 'refs/factory/remote';
const HARDENED = HARDENING.flatMap((c) => ['-c', c]);
/** A deadline only stops waiting for git: stalled for a minute, git ends by itself, and takes the token in its env with it. */
export const STALLED = { GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '60' };

export interface GitPublisherDeps {
  sandboxes: SandboxProvider;
  forge: Pick<ForgeWriter, 'ensurePr' | 'gitAccess'>;
  /** Where a publication works (`<runsDir>/<runId>/publish-<uuid>`): a place the engine mounts from, purged with the run. */
  runsDir: string;
  /** `factory/secrets`, by the image's gitleaks. Only a test on an image without it turns it off. */
  gitleaks?: boolean;
  log: (message: string) => void;
  deadlineMs?: number;
  exec?: Exec;
}

/**
 * The factory publishes, and the agent has no way to (ORC-125). It trusts nothing the agent wrote, and runs none of it:
 *
 * 1. on the forge, with the App's token, the base and the branch's head. A head already at the commit needs no push: the
 *    replay of a publication cut before its PR goes straight to the PR, and that is how it never pushes twice;
 * 2. in a sandbox of its own, without network, its `.git` read-only, `git bundle` of the branch in the agent's own repository, whose head must be the commit `verify` found
 *    green, then `git bundle verify` and a fresh clone on the host, without a checkout (`extractWork`);
 * 3. the base and the branch's head fetched into that clone, from the forge;
 * 4. the blocking check of the diff from the base: `checkClone` on the clone's objects (the base's `sensitive_paths` too, on what
 *    the agent's commits changed since the branch took untrusted content, ORC-338), then gitleaks in a sandbox at `none`.
 *    `verify` checked the same commit: this is the last word before the forge, and it depends on no state;
 * 5. a push only forward. What the forge's branch holds must be in the work: otherwise the branch moved (a human's commit,
 *    which the agent rebases its work on, ORC-159, or a history the agent rewrote), and it is refused. Only a rebase's commit (ORC-146) may replace a
 *    head the work does not hold, and only the one the factory published last (`rewrites`). The lease is on the head read
 *    in 3: a push in between is refused by git, and nothing is ever written over;
 * 6. the draft PR, found by its branch before it is opened (`ensurePr`).
 *
 * A bundle a human hands back after a take-over (ORC-234) goes through 1, 3, 4 and 5 (`publishBundle`): its file in place of 2.
 */
export class GitPublisher implements Publisher {
  private readonly exec: Exec;

  constructor(private d: GitPublisherDeps) {
    this.exec = d.exec ?? execCmd;
  }

  async publish(req: PublishRequest): Promise<Publication> {
    const access = await this.d.forge.gitAccess(req.repoPath);
    const workDir = join(this.d.runsDir, req.runId, `publish-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true });
    try {
      const env = { ...hostGitEnv(workDir, workDir), GIT_TERMINAL_PROMPT: '0', ...STALLED, ...access.env };
      const onForge = await readForge(this.exec, access.url, req.branch, { cwd: workDir, env });
      if (req.branch === onForge.base) throw new PublishRefused('trunk', `the ticket's branch is the default branch (${onForge.base}).`);
      if (onForge.head === req.sha) this.d.log(`publish of ${req.ticketId}: ${req.sha} is already on the forge, not pushed again`);
      else await this.pushChecked(req, access.url, env, workDir, onForge.head);
      const pr = await this.d.forge.ensurePr(req.repoPath, { branch: req.branch, base: onForge.base, title: req.title, body: req.body, draft: true }).catch((err: Error) => {
        // Only here can the forge's branch hold nothing the base lacks: a head on the commit skips the check of step 3.
        throw err instanceof NoCommitsBetween ? nothingToPublish(req.branch) : err;
      });
      return { prNumber: pr.number, url: pr.url, sha: req.sha };
    } finally {
      // Under the run's dir, purged with it: what the attack left unremovable costs no publication.
      await rm(workDir, { recursive: true, force: true }).catch((err: Error) => this.d.log(`publish of ${req.ticketId}: ${workDir} not removed: ${err.message}`));
    }
  }

  /**
   * The bundle a human hands back after a take-over (ORC-234), from its file alone: `git bundle verify` in a fresh clone of
   * ours (`cloneBundle`), then the same check of the diff as the agent's work, on all its commits as on an untrusted branch's,
   * and a push only forward. No PR: it is the human's push, which `verify` checks then (ORC-159). A bundle that does not
   * verify is a refusal, as a check that fails: nothing reaches the forge.
   */
  async publishBundle(req: BundleRequest): Promise<BundlePush> {
    const access = await this.d.forge.gitAccess(req.repoPath);
    const workDir = join(this.d.runsDir, req.runId, `bundle-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true });
    try {
      const env = { ...hostGitEnv(workDir, workDir), GIT_TERMINAL_PROMPT: '0', ...STALLED, ...access.env };
      const onForge = await readForge(this.exec, access.url, req.branch, { cwd: workDir, env });
      if (req.branch === onForge.base) throw new PublishRefused('trunk', `the ticket's branch is the default branch (${onForge.base}).`);
      const cloneDir = join(workDir, 'clone');
      const { sha } = await cloneBundle({ bundle: req.bundle, branch: req.branch, cloneDir, exec: this.exec }).catch((err: Error) => {
        throw new PublishRefused('bundle', `the bundle does not verify as a bundle of ${req.branch}: ${err.message.slice(0, 500)}`);
      });
      if (onForge.head !== sha) await this.checkAndPush({ ...req, sha, untrusted: { since: '', humanPushes: [] } }, access.url, env, workDir, cloneDir, onForge.head);
      return { sha, ...(onForge.head ? { before: onForge.head } : {}) };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch((err: Error) => this.d.log(`bundle of ${req.ticketId}: ${workDir} not removed: ${err.message}`));
    }
  }

  private async pushChecked(req: PublishRequest, url: string, env: Record<string, string>, workDir: string, known: string | undefined): Promise<void> {
    const sandboxes = withDeadline(this.d.sandboxes, this.d.deadlineMs ?? PUBLISH_DEADLINE_MS);
    const inBox = boxOpener(sandboxes, { runId: req.runId, ticketId: req.ticketId, log: this.d.log });
    const bundleDir = join(workDir, 'bundle');
    const cloneDir = join(workDir, 'clone');
    mkdirSync(bundleDir);

    await inBox('publish', req.worktree, [{ host: bundleDir, target: BUNDLE_TARGET, readOnly: false }, agentGitDir(req.worktree)], async (sandboxId) => {
      const { sha } = await extractWork({ sandboxes, sandboxId, branch: req.branch, bundleDir, cloneDir, exec: this.exec });
      if (sha !== req.sha) throw new PublishRefused('head', `the head of the branch (${sha.slice(0, 12)}) is not the verified commit (${req.sha.slice(0, 12)}).`);
    });
    await this.checkAndPush(req, url, env, workDir, cloneDir, known);
  }

  /** Steps 3 to 5 on the fresh clone at `cloneDir`, whose head is `req.sha`: the forge's heads fetched, the blocking check of the diff, the push. */
  private async checkAndPush(
    req: { runId: string; ticketId: string; branch: string; sha: string; untrusted?: UntrustedMark; rewrites?: string; repoPath: string },
    url: string, env: Record<string, string>, workDir: string, cloneDir: string, known: string | undefined,
  ): Promise<void> {
    const deadlineMs = this.d.deadlineMs ?? PUBLISH_DEADLINE_MS;
    const silent = `the forge no longer responds after ${deadlineMs / 1000} s`;
    const sandboxes = withDeadline(this.d.sandboxes, deadlineMs);
    const inBox = boxOpener(sandboxes, { runId: req.runId, ticketId: req.ticketId, log: this.d.log });
    const git = cloneGit({ workDir, exec: this.exec }, cloneDir);
    const inClone = (args: string[], over: Record<string, string> = {}) => this.exec('git', [...HARDENED, '-C', cloneDir, ...args], { env: { ...env, ...over } });
    const fetched = await within(inClone(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--', url, `+HEAD:${BASE}`, ...(known ? [`+refs/heads/${req.branch}:${REMOTE_HEAD}`] : [])]), deadlineMs, silent);
    if (fetched.code !== 0) throw new Error(`git fetch: ${fetched.stderr.trim() || `code ${fetched.code}`}`);
    // The head fetched is the one the lease names: read after the fetch, it is the one compared with the work.
    const remote = known ? await git('rev-parse', REMOTE_HEAD) : undefined;
    if (remote && remote !== req.rewrites && !isYes(await git.status('merge-base', '--is-ancestor', remote, req.sha))) {
      throw new PublishRefused('moved', `the branch ${req.branch} has a commit on the forge that this work does not have (${remote.slice(0, 12)}): a human push, or a rewritten history. Nothing is overwritten: the work goes on top of it (\`git rebase origin/${req.branch}\`), never over it.`);
    }
    const from = await forkPoint(git, req.sha);
    if (from === req.sha) throw nothingToPublish(req.branch);

    const untrusted = req.untrusted && untrustedCheck(req.untrusted, await refusedConfig(() => baseConfig(git)));
    const failures = await refusedConfig(() => checkClone(git, from, req.sha, undefined, untrusted));
    if (this.d.gitleaks !== false) failures.push(...(await inBox('publish-secrets', cloneDir, [], (id) => scanSecrets(sandboxes, id, from, req.sha))));
    if (failures.length) throw new PublishRefused('diff', failures.map((f) => `${f.command}: ${f.output}`).join('\n'));

    // Read again: the checks above can outlast what a cached token has left to live.
    const { env: fresh } = await this.d.forge.gitAccess(req.repoPath);
    // `--force-with-lease` and no other force: a fast-forward by the check above, or the factory's own head a rebase replaces,
    // whose lease makes the read and the write one step.
    const push = ['push', '--porcelain', '--no-verify', '--recurse-submodules=no', `--force-with-lease=refs/heads/${req.branch}:${remote ?? ''}`, '--', url, `${req.sha}:refs/heads/${req.branch}`];
    const out = await within(inClone(push, fresh), deadlineMs, silent);
    if (out.code === 0) return;
    // Git's own status line for the ref: what a server hook prints around it says nothing of the verdict.
    const refused = out.stdout.split('\n').find((l) => l.startsWith('!'));
    if (!refused) throw new Error(`git push: ${out.stderr.trim() || `code ${out.code}`}`);
    if (/stale info|fetch first|non-fast-forward/.test(refused)) throw new PublishRefused('moved', `the branch ${req.branch} moved during the publication: nothing is overwritten.`);
    throw new PublishRefused('rejected', `the forge refuses the push to ${req.branch}: ${refused.trim().slice(0, 500)}`);
  }
}

/** A base config the check of an untrusted branch cannot read is an answer, journaled once, not a breakdown retried forever (ORC-338). */
async function refusedConfig<T>(check: () => Promise<T>): Promise<T> {
  try {
    return await check();
  } catch (err) {
    if (!(err instanceof RepoConfigError)) throw err;
    throw new PublishRefused('config', `the default branch's ${REPO_CONFIG_PATH} is refused, so the sensitive paths of this branch, which took untrusted content, cannot be checked: ${err.message}`);
  }
}

const nothingToPublish = (branch: string) => new PublishRefused('empty', `the branch ${branch} has nothing more than the base branch.`);

/**
 * The agent's own git dir (ORC-317), read-only over its worktree: nothing here writes, and the factory's repository is mounted nowhere. Its worktree can hold
 * anything by now, so anything but a real directory is refused: a link would have the engine mount what it points at, and a `.git` file send git to another repository.
 * Only its type is read on the host.
 */
function agentGitDir(worktree: string): SandboxMount {
  const host = join(worktree, '.git');
  if (!lstatSync(host, { throwIfNoEntry: false })?.isDirectory()) throw new PublishRefused('head', "the agent's git folder is no longer a folder: its repository is no longer the one the factory created.");
  return { host, target: `${WORKSPACE_TARGET}/.git`, readOnly: true };
}

/** The default branch, by its name, and the branch's head, on the forge: `ls-remote` from a directory of ours, no repository read. */
async function readForge(exec: Exec, url: string, branch: string, opts: { cwd: string; env: Record<string, string> }): Promise<{ base: string; head?: string }> {
  const out = await mustExec(exec, 'git', [...HARDENED, 'ls-remote', '--symref', '--', url, 'HEAD', `refs/heads/${branch}`], opts);
  const base = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out)?.[1];
  if (!base) throw new Error('default branch not read on the forge');
  const head = out.split('\n').find((l) => l.endsWith(`\trefs/heads/${branch}`))?.split('\t')[0];
  return { base, ...(head ? { head } : {}) };
}
