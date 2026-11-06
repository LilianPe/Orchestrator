import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execCmd, mustExec, type Exec } from '../adapters/exec.js';
import { NoCommitsBetween, type ForgeWriter } from '../adapters/forge/types.js';
import { PublishRefused, type Publication, type Publisher, type PublishRequest } from '../adapters/publisher/types.js';
import { WORKSPACE_TARGET, type SandboxMount, type SandboxProvider } from '../adapters/sandbox/types.js';
import { BASE, boxOpener, checkClone, cloneGit, forkPoint, isYes, scanSecrets, withDeadline, within } from '../core/clean-verify.js';
import { BUNDLE_TARGET, extractWork, HARDENING, hostGitEnv } from './extract.js';

/** Git and a scan, no command of the repository: a stop waits behind the publication, so it is not given `verify`'s time. */
const PUBLISH_DEADLINE_MS = 10 * 60_000;
const REMOTE_HEAD = 'refs/factory/remote';
const HARDENED = HARDENING.flatMap((c) => ['-c', c]);
/** A deadline only stops waiting for git: stalled for a minute, git ends by itself, and takes the token in its env with it. */
const STALLED = { GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '60' };

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
 * 4. the blocking check of the diff from the base: `checkClone` on the clone's objects, then gitleaks in a sandbox at `none`.
 *    `verify` checked the same commit: this is the last word before the forge, and it depends on no state;
 * 5. a push only forward. What the forge's branch holds must be in the work: otherwise the branch moved (a human's commit,
 *    which is ORC-159's, or a history the agent rewrote), and it is refused. The lease is on the head read in 3: a push in
 *    between is refused by git, and nothing is ever written over;
 * 6. the draft PR, found by its branch before it is opened (`ensurePr`).
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
      if (req.branch === onForge.base) throw new PublishRefused('trunk', `la branche du ticket est la branche par défaut (${onForge.base}).`);
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

  private async pushChecked(req: PublishRequest, url: string, env: Record<string, string>, workDir: string, known: string | undefined): Promise<void> {
    const deadlineMs = this.d.deadlineMs ?? PUBLISH_DEADLINE_MS;
    const silent = `la forge ne répond plus après ${deadlineMs / 1000} s`;
    const sandboxes = withDeadline(this.d.sandboxes, deadlineMs);
    const inBox = boxOpener(sandboxes, { runId: req.runId, ticketId: req.ticketId, log: this.d.log });
    const bundleDir = join(workDir, 'bundle');
    const cloneDir = join(workDir, 'clone');
    mkdirSync(bundleDir);

    await inBox('publish', req.worktree, [{ host: bundleDir, target: BUNDLE_TARGET, readOnly: false }, agentGitDir(req.worktree)], async (sandboxId) => {
      const { sha } = await extractWork({ sandboxes, sandboxId, branch: req.branch, bundleDir, cloneDir, exec: this.exec });
      if (sha !== req.sha) throw new PublishRefused('head', `la tête de la branche (${sha.slice(0, 12)}) n'est pas le commit vérifié (${req.sha.slice(0, 12)}).`);
    });

    const git = cloneGit({ workDir, exec: this.exec }, cloneDir);
    const inClone = (args: string[], over: Record<string, string> = {}) => this.exec('git', [...HARDENED, '-C', cloneDir, ...args], { env: { ...env, ...over } });
    const fetched = await within(inClone(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--', url, `+HEAD:${BASE}`, ...(known ? [`+refs/heads/${req.branch}:${REMOTE_HEAD}`] : [])]), deadlineMs, silent);
    if (fetched.code !== 0) throw new Error(`git fetch : ${fetched.stderr.trim() || `code ${fetched.code}`}`);
    // The head fetched is the one the lease names: read after the fetch, it is the one compared with the work.
    const remote = known ? await git('rev-parse', REMOTE_HEAD) : undefined;
    if (remote && !isYes(await git.status('merge-base', '--is-ancestor', remote, req.sha))) {
      throw new PublishRefused('moved', `la branche ${req.branch} porte sur la forge un commit que ce travail n'a pas (${remote.slice(0, 12)}) : un push humain, ou un historique réécrit. Rien n'est écrasé : intégrez-le dans la branche du ticket.`);
    }
    const from = await forkPoint(git, req.sha);
    if (from === req.sha) throw nothingToPublish(req.branch);

    const failures = await checkClone(git, from, req.sha, undefined);
    if (this.d.gitleaks !== false) failures.push(...(await inBox('publish-secrets', cloneDir, [], (id) => scanSecrets(sandboxes, id, from, req.sha))));
    if (failures.length) throw new PublishRefused('diff', failures.map((f) => `${f.command} : ${f.output}`).join('\n'));

    // Read again: the checks above can outlast what a cached token has left to live.
    const { env: fresh } = await this.d.forge.gitAccess(req.repoPath);
    // `--force-with-lease` and no other force: a fast-forward by the check above, whose lease makes the read and the write one step.
    const push = ['push', '--porcelain', '--no-verify', '--recurse-submodules=no', `--force-with-lease=refs/heads/${req.branch}:${remote ?? ''}`, '--', url, `${req.sha}:refs/heads/${req.branch}`];
    const out = await within(inClone(push, fresh), deadlineMs, silent);
    if (out.code === 0) return;
    // Git's own status line for the ref: what a server hook prints around it says nothing of the verdict.
    const refused = out.stdout.split('\n').find((l) => l.startsWith('!'));
    if (!refused) throw new Error(`git push : ${out.stderr.trim() || `code ${out.code}`}`);
    if (/stale info|fetch first|non-fast-forward/.test(refused)) throw new PublishRefused('moved', `la branche ${req.branch} a bougé pendant la publication : rien n'est écrasé.`);
    throw new PublishRefused('rejected', `la forge refuse le push sur ${req.branch} : ${refused.trim().slice(0, 500)}`);
  }
}

const nothingToPublish = (branch: string) => new PublishRefused('empty', `la branche ${branch} n'a rien de plus que la branche de base.`);

/**
 * The agent's own git dir (ORC-317), read-only over its worktree: nothing here writes, and the factory's repository is mounted nowhere. Its worktree can hold
 * anything by now, so anything but a real directory is refused: a link would have the engine mount what it points at, and a `.git` file send git to another repository.
 * Only its type is read on the host.
 */
function agentGitDir(worktree: string): SandboxMount {
  const host = join(worktree, '.git');
  if (!lstatSync(host, { throwIfNoEntry: false })?.isDirectory()) throw new PublishRefused('head', "le dossier git de l'agent n'est plus un dossier : son dépôt n'est plus celui que l'usine a créé.");
  return { host, target: `${WORKSPACE_TARGET}/.git`, readOnly: true };
}

/** The default branch, by its name, and the branch's head, on the forge: `ls-remote` from a directory of ours, no repository read. */
async function readForge(exec: Exec, url: string, branch: string, opts: { cwd: string; env: Record<string, string> }): Promise<{ base: string; head?: string }> {
  const out = await mustExec(exec, 'git', [...HARDENED, 'ls-remote', '--symref', '--', url, 'HEAD', `refs/heads/${branch}`], opts);
  const base = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out)?.[1];
  if (!base) throw new Error('branche par défaut non lue sur la forge');
  const head = out.split('\n').find((l) => l.endsWith(`\trefs/heads/${branch}`))?.split('\t')[0];
  return { base, ...(head ? { head } : {}) };
}
