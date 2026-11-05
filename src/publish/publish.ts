import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execCmd, mustExec, type Exec, type ExecResult } from '../adapters/exec.js';
import type { ForgeWriter } from '../adapters/forge/types.js';
import { PublishRefused, type Publication, type Publisher, type PublishRequest } from '../adapters/publisher/types.js';
import { DEFAULT_REQUIREMENTS, type SandboxMount, type SandboxProvider } from '../adapters/sandbox/types.js';
import { BASE, checkClone, cloneGit, EMPTY_TREE, scanSecrets, withDeadline, within, type Boxes } from '../core/clean-verify.js';
import { BUNDLE_TARGET, extractWork, HARDENING, hostGitEnv } from './extract.js';

/** Git and a scan, no command of the repository: a stop waits behind the publication, so it is not given `verify`'s time. */
const PUBLISH_DEADLINE_MS = 10 * 60_000;
const REMOTE_HEAD = 'refs/factory/remote';
const HARDENED = HARDENING.flatMap((c) => ['-c', c]);

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
 * The PR's text until the factory composes it (ORC-195, through the `OutputPolicy` of ORC-214): the ticket's id and title, its own
 * sentence, and nothing an agent wrote. No closing keyword: it is a claim on the whole ticket, and nothing here can make it.
 */
export function prText(t: { ticketId: string; title: string }): { title: string; body: string } {
  return { title: `${t.ticketId} ${t.title}`, body: `Ticket : ${t.ticketId}\n\nPubliée par l'usine : chaque commit poussé a passé sa vérification.` };
}

/**
 * The factory publishes, and the agent has no way to (ORC-125). It trusts nothing the agent wrote, and runs none of it:
 *
 * 1. on the forge, with the App's token, the base and the branch's head. A head already at the commit needs no push: the
 *    replay of a publication cut before its PR goes straight to the PR, and that is how it never pushes twice;
 * 2. in a sandbox of its own, without network, `git bundle` of the branch, whose head must be the commit `verify` found
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
  constructor(private d: GitPublisherDeps) {}

  async publish(req: PublishRequest): Promise<Publication> {
    const access = await this.d.forge.gitAccess(req.repoPath);
    const workDir = join(this.d.runsDir, req.runId, `publish-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true });
    try {
      const env = { ...hostGitEnv(workDir, workDir), GIT_TERMINAL_PROMPT: '0', ...access.env };
      const onForge = await readForge(this.d.exec ?? execCmd, access.url, req.branch, { cwd: workDir, env });
      if (req.branch === onForge.base) throw new PublishRefused('trunk', `la branche du ticket est la branche par défaut (${onForge.base}).`);
      if (onForge.head === req.sha) this.d.log(`publish of ${req.ticketId}: ${req.sha} is already on the forge, not pushed again`);
      else await this.pushChecked(req, access.url, env, workDir, onForge.head);
      const pr = await this.d.forge.ensurePr(req.repoPath, { branch: req.branch, base: onForge.base, title: req.title, body: req.body, draft: true }).catch((err: Error) => {
        // Only here can the forge's branch hold nothing the base lacks: a head on the commit skips the check of step 3.
        throw /No commits between/.test(err.message) ? new PublishRefused('empty', `la branche ${req.branch} n'a rien de plus que la branche de base.`) : err;
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
    const exec = this.d.exec ?? execCmd;
    const sandboxes = withDeadline(this.d.sandboxes, deadlineMs);
    const bundleDir = join(workDir, 'bundle');
    const cloneDir = join(workDir, 'clone');
    mkdirSync(bundleDir);

    await this.inBox(sandboxes, req, 'publish', req.worktree, [{ host: bundleDir, target: BUNDLE_TARGET, readOnly: false }, ...repositoryGitDir(req)], async (sandboxId) => {
      const { sha } = await extractWork({ sandboxes, sandboxId, branch: req.branch, bundleDir, cloneDir, ...(this.d.exec ? { exec: this.d.exec } : {}) });
      if (sha !== req.sha) throw new PublishRefused('head', `la tête de la branche (${sha.slice(0, 12)}) n'est pas le commit vérifié (${req.sha.slice(0, 12)}).`);
    });

    const git = cloneGit({ workDir, ...(this.d.exec ? { exec: this.d.exec } : {}) }, cloneDir);
    const fetched = [HARDENED, ['-C', cloneDir, 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--', url, `+HEAD:${BASE}`, ...(known ? [`+refs/heads/${req.branch}:${REMOTE_HEAD}`] : [])]].flat();
    await within(mustExec(exec, 'git', fetched, { env }), deadlineMs, silent);
    // The head fetched is the one the lease names: read after the fetch, it is the one compared with the work.
    const remote = known ? await git('rev-parse', REMOTE_HEAD) : undefined;
    // Git's own answers, 0 and 1, and no other code: a failure of git here is retried, never taken for a verdict on the branch.
    const inClone = (...args: string[]) => exec('git', [...HARDENED, '-C', cloneDir, ...args], { env });
    const answer = <T>(r: ExecResult, yes: T, no: T) => {
      if (r.code > 1) throw new Error(`git merge-base : ${r.stderr.trim() || `code ${r.code}`}`);
      return r.code === 0 ? yes : no;
    };
    if (remote && !answer(await inClone('merge-base', '--is-ancestor', remote, req.sha), true, false)) {
      throw new PublishRefused('moved', `la branche ${req.branch} porte sur la forge un commit que ce travail n'a pas (${remote.slice(0, 12)}) : un push humain, ou un historique réécrit. Rien n'est écrasé : intégrez-le dans la branche du ticket.`);
    }
    const common = await inClone('merge-base', BASE, req.sha);
    const from = answer(common, common.stdout.trim(), EMPTY_TREE);
    if (from === req.sha) throw new PublishRefused('empty', `la branche ${req.branch} n'a rien de plus que la branche de base.`);

    const failures = await checkClone(git, from, req.sha, undefined);
    if (this.d.gitleaks !== false) {
      await this.inBox(sandboxes, req, 'publish-secrets', cloneDir, [], async (id) => void failures.push(...(await scanSecrets(sandboxes, id, from, req.sha))));
    }
    if (failures.length) throw new PublishRefused('diff', failures.map((f) => `${f.command} : ${f.output}`).join('\n'));

    // `--force-with-lease` and no other force: a fast-forward by the check above, whose lease makes the read and the write one step.
    const push = [HARDENED, ['-C', cloneDir, 'push', '--porcelain', '--no-verify', '--recurse-submodules=no', `--force-with-lease=refs/heads/${req.branch}:${remote ?? ''}`, '--', url, `${req.sha}:refs/heads/${req.branch}`]].flat();
    const out = await within(exec('git', push, { env }), deadlineMs, silent);
    if (out.code === 0) return;
    const said = `${out.stdout}\n${out.stderr}`;
    if (/stale info|fetch first|non-fast-forward/.test(said)) throw new PublishRefused('moved', `la branche ${req.branch} a bougé pendant la publication : rien n'est écrasé.`);
    if (/\[(remote )?rejected\]/.test(said)) throw new PublishRefused('rejected', `la forge refuse le push sur ${req.branch} : ${said.trim().slice(0, 500)}`);
    throw new Error(`git push : ${out.stderr.trim() || `code ${out.code}`}`);
  }

  private async inBox(sandboxes: Boxes, req: PublishRequest, suffix: string, workspacePath: string, mounts: readonly SandboxMount[], work: (id: string) => Promise<void>): Promise<void> {
    const { id } = await sandboxes.create({ runId: `${req.runId}-${suffix}`, ticketId: req.ticketId, workspacePath, network: 'none', requirements: DEFAULT_REQUIREMENTS, mounts });
    try {
      await work(id);
    } finally {
      await sandboxes.destroy(id).catch((err: Error) => this.d.log(`sandbox ${id} not destroyed: ${err.message}`));
    }
  }
}

/**
 * Where a linked worktree's `.git` file points, read-only for the bundle's git; nothing when the git dir is in the worktree. A path of the
 * project's: no git runs, and nothing the agent can write is read but that `.git` is a file (ORC-317). What it could point elsewhere is
 * only ever read in the sandbox, and its head has to be the verified commit. Goes away with the worktrees that hold their own git dir.
 */
function repositoryGitDir(req: Pick<PublishRequest, 'repoPath' | 'worktree'>): SandboxMount[] {
  if (lstatSync(join(req.worktree, '.git')).isDirectory()) return [];
  const gitDir = existsSync(join(req.repoPath, '.git')) ? join(req.repoPath, '.git') : req.repoPath;
  return [{ host: gitDir, target: gitDir, readOnly: true }];
}

/** The default branch, by its name, and the branch's head, on the forge: `ls-remote` from a directory of ours, no repository read. */
async function readForge(exec: Exec, url: string, branch: string, opts: { cwd: string; env: Record<string, string> }): Promise<{ base: string; head?: string }> {
  const out = await mustExec(exec, 'git', [...HARDENED, 'ls-remote', '--symref', '--', url, 'HEAD', `refs/heads/${branch}`], opts);
  const base = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out)?.[1];
  if (!base) throw new Error('branche par défaut non lue sur la forge');
  const head = out.split('\n').find((l) => l.endsWith(`\trefs/heads/${branch}`))?.split('\t')[0];
  return { base, ...(head ? { head } : {}) };
}
