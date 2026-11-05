import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { branchName } from '../../core/naming.js';
import { execCmd, HARDENING, mustExec, type Exec } from '../exec.js';
import { readCapped } from '../read-capped.js';
import type { StepDiff, Workspace, WorkspaceManager, WorkspaceRequest } from './types.js';

function assertSafe(id: string): void {
  if (/[\\/]/.test(id) || id.includes('..')) throw new Error(`Identifiant invalide : ${id}`);
}

/**
 * What the agent's repository does not take of the repository's own config, which the agent read before and which no
 * agent writes: what describes that repository's layout, or names a host's path for hooks. The rest stays as it was for
 * a run: identity, remotes, credentials, filters, line endings.
 */
const NOT_INHERITED = /^(core\.(bare|repositoryformatversion|worktree|hookspath|fsmonitor|sparsecheckout|sparsecheckoutcone)$|extensions\.)/i;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Git's own rules on a ref's name (`git check-ref-format`), as a name out of them cannot be its branch. Never `..`: it becomes a path. */
const BRANCH_REF = /^refs\/heads\/(?!-|\.)(?!.*(\.\.|@\{|\/\.|\/\/|\.lock(\/|$)))[^\s\p{Cc}~^:?*[\\]+$/u;
const MAX_REFS_BYTES = 16 * 1024 * 1024;

/**
 * A file of the agent's git dir, as data. It can be anything by the time it is opened: not out of that dir by a link on
 * the way, never a link itself, never a FIFO that would hold the daemon, never more than the cap. Whatever else it is, it reads as absent.
 */
function agentFile(gitDir: string, name: string): string | undefined {
  try {
    const path = join(gitDir, name);
    if (!realpathSync(path).startsWith(realpathSync(gitDir) + sep)) return undefined;
    const read = readCapped(path, MAX_REFS_BYTES);
    return read && read !== 'not a file' && !read.cut ? read.text : undefined;
  } catch {
    return undefined;
  }
}

const isDir = (path: string) => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Where a workspace's HEAD is, read as data: no git runs in a directory the agent writes, whose `.git` it can point at
 * a config of its own (ORC-317). As `rev-parse --abbrev-ref HEAD`, `branch` is `HEAD` when detached. It says what the
 * agent left, as git would: only a verdict on a commit out of its reach (`verify`) is proof.
 */
function agentHead(work: string): { branch: string; sha?: string } | undefined {
  const gitDir = join(work, '.git');
  if (!isDir(gitDir)) return undefined;
  const head = agentFile(gitDir, 'HEAD')?.trim();
  if (!head) return undefined;
  if (SHA.test(head)) return { branch: 'HEAD', sha: head };
  const ref = /^ref: (\S+)$/.exec(head)?.[1];
  if (!ref || !BRANCH_REF.test(ref)) return undefined;
  const branch = ref.slice('refs/heads/'.length);
  const loose = agentFile(gitDir, ref)?.trim();
  if (loose && SHA.test(loose)) return { branch, sha: loose };
  const packed = agentFile(gitDir, 'packed-refs')?.split('\n').find((l) => l.endsWith(` ${ref}`))?.split(' ')[0];
  return packed && SHA.test(packed) ? { branch, sha: packed } : { branch };
}

/** The paths of `git status --porcelain -z`, a rename's or copy's both sides included (ORC-123). */
export function parseStatus(out: string): string[] {
  const fields = out.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    paths.push(fields[i]!.slice(3));
    if (/^[RC]/.test(fields[i]!)) paths.push(fields[++i]!);
  }
  return paths;
}

/** The default branch as `origin/<name>`; `origin/main` when the clone does not know it. */
export async function originHead(exec: Exec, repo: string): Promise<string> {
  const r = await exec('git', ['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  return r.code === 0 ? r.stdout.trim() : 'origin/main';
}

export class GitWorkspaces implements WorkspaceManager {
  private exec: Exec;

  constructor(private o: { root: string; knowledgeRepo?: string; exec?: Exec }) {
    this.exec = o.exec ?? execCmd;
  }

  private git(repo: string, ...args: string[]): Promise<string> {
    return mustExec(this.exec, 'git', ['-C', repo, ...args]);
  }

  async prepare(req: WorkspaceRequest): Promise<Workspace> {
    assertSafe(req.projectId);
    assertSafe(req.ticketId);
    if (req.kind === 'trunk-readonly') return this.trunkWorkspace(req);
    if (req.kind === 'knowledge') return this.knowledgeWorkspace(req);
    const path = join(this.o.root, req.projectId, req.ticketId);
    const port = req.portBase + req.slot;
    if (existsSync(path)) {
      const branch = agentHead(path)?.branch;
      if (!branch) throw new Error(`Le dépôt git de ${path} n'est pas celui que l'usine a créé, ou n'est plus lisible : ce worktree doit être supprimé.`);
      return { path, port, branch };
    }
    await this.git(req.repoPath, 'fetch', 'origin');
    const branch = branchName(req.ticketId, req.title);
    const has = async (ref: string) =>
      (await this.exec('git', ['-C', req.repoPath, 'rev-parse', '--verify', '--quiet', ref])).code === 0;
    const trunk = await originHead(this.exec, req.repoPath);
    let existing: string | undefined;
    let checkout = ['--no-track', '-b', branch, trunk];
    let local: string | undefined;
    // The forge first: an agent's commits reach it, never the repository's own branch, which can only lag behind.
    if (await has(`refs/remotes/origin/${branch}`)) {
      existing = `refs/remotes/origin/${branch}`;
      checkout = ['-b', branch, `origin/${branch}`];
    } else if (await has(`refs/heads/${branch}`)) {
      existing = local = `refs/heads/${branch}`;
      checkout = [branch];
    }
    // On a branch that already existed: only its commits beyond the default branch count.
    const ahead = !!existing && (await this.git(req.repoPath, 'rev-list', '--count', `${trunk}..${existing}`)).trim() !== '0';
    await this.agentRepository(req.repoPath, path, trunk, checkout, local);
    return { path, port, branch, fresh: true, ...(ahead ? { ahead } : {}) };
  }

  /**
   * The agent's own repository at `path`, its `.git` inside its worktree (ORC-317). Everything in it, config, hooks,
   * refs, the `.git` itself, is the agent's: the repository of `repo`, its config, its hooks and its refs, is never
   * mounted in a sandbox, so that git can go on running on it on the host. No git of the host runs in `path` afterwards:
   * `agentHead` and `stepDiff` read it as data, and what git must do in it is done here, before any agent.
   *
   * Left out of its sparse checkout but for `.claude/CLAUDE.md`, which the factory reads as the
   * repo's conventions (`readConventions`) and the session does not load (`--setting-sources ""`, ORC-128).
   * The rest: the agent's session cannot load it, `git status`, `add -A`
   * or `commit -a` neither see nor commit it as deleted, so a PR never drops the repo's `.claude/`, and a
   * merge or rebase that changes it does not write it back (skip-worktree alone did). The index keeps it.
   * `!/.claude/*`, not `!/.claude/`: git re-includes a file only if its parent directory is not excluded.
   *
   * Its objects are copied, not shared: a hard link would let the agent rewrite the factory's, and an alternate needs a
   * mount at the same path. What is fetched is what the forge has and the ticket's own branch, not another ticket's.
   * Made aside, then renamed: a daemon killed halfway leaves no directory the next launch would take for a worktree.
   */
  private async agentRepository(repo: string, path: string, trunk: string, checkout: readonly string[], localRef?: string): Promise<void> {
    const making = `${path}.new`;
    await rm(making, { recursive: true, force: true });
    mkdirSync(dirname(path), { recursive: true });
    // Nothing of an agent has run in it: the checkout runs no hook, as `--template=` left none, and reads the daemon's own config.
    const here = (...args: string[]) => mustExec(this.exec, 'git', [...HARDENING.flatMap((c) => ['-c', c]), ...args]);
    try {
      await here('init', '--quiet', '--template=', making);
      const config = (await this.git(repo, 'config', '--local', '-z', '--list')).split('\0').filter(Boolean);
      for (const entry of config) {
        const at = entry.indexOf('\n');
        if (at < 0 || NOT_INHERITED.test(entry.slice(0, at))) continue;
        await here('-C', making, 'config', '--add', entry.slice(0, at), entry.slice(at + 1));
      }
      // Resolved: it is read from `making`, and `repoPath` can be relative.
      await here('-C', making, 'fetch', '--quiet', '--no-tags', '--', resolve(repo), '+refs/remotes/origin/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*', ...(localRef ? [`+${localRef}:${localRef}`] : []));
      await here('-C', making, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/${trunk}`);
      await here('-C', making, 'checkout', '--quiet', ...checkout);
      await here('-C', making, 'sparse-checkout', 'set', '--no-cone', '/*', '!/.claude/*', '/.claude/CLAUDE.md');
      renameSync(making, path);
    } catch (err) {
      await rm(making, { recursive: true, force: true });
      throw err;
    }
  }

  /** One per question, gone with it (`release`): what a question's agent left is for nobody else, and nothing has to be put back. */
  private async trunkWorkspace(req: WorkspaceRequest): Promise<Workspace> {
    assertSafe(req.runId);
    const path = join(this.o.root, req.projectId, '_trunk', req.runId);
    await this.git(req.repoPath, 'fetch', 'origin');
    const ref = await originHead(this.exec, req.repoPath);
    await this.agentRepository(req.repoPath, path, ref, ['--detach', ref]);
    return { path };
  }

  private async knowledgeWorkspace(req: WorkspaceRequest): Promise<Workspace> {
    const kb = this.o.knowledgeRepo;
    if (!kb) throw new Error('Aucun dépôt de connaissance configuré.');
    await this.git(kb, 'fetch', 'origin');
    const path = join(this.o.root, '_kb', req.runId);
    const branch = `learn/${req.ticketId.toLowerCase()}-${req.runId.slice(0, 8)}`;
    const trunk = await originHead(this.exec, kb);
    await this.agentRepository(kb, path, trunk, ['-b', branch, trunk]);
    return { path, branch };
  }

  /** No git here: its `.git` goes with it, the commits it did not push too. */
  async cleanup(projectId: string, ticketId: string): Promise<void> {
    assertSafe(projectId);
    assertSafe(ticketId);
    await rm(join(this.o.root, projectId, ticketId), { recursive: true, force: true });
  }

  /** By its project and its run, whatever the workflow says now of the job: it cannot name a ticket's worktree, which holds unpushed commits. */
  async release(projectId: string, runId: string): Promise<void> {
    assertSafe(projectId);
    assertSafe(runId);
    await rm(join(this.o.root, projectId, '_trunk', runId), { recursive: true, force: true });
  }

  async head(path: string): Promise<string | undefined> {
    return agentHead(path)?.sha;
  }

  /**
   * On the factory's repository, its config and its hooks: the agent's objects are only one more place to read objects
   * from, whatever their `info/alternates` says. A link for `objects` could reach another repository's: not followed.
   */
  async stepDiff(repoPath: string, path: string, base: string): Promise<StepDiff | undefined> {
    const head = await this.head(path);
    // Absolute: read from `repoPath`, and the workspaces' root can be relative.
    const objects = resolve(path, '.git', 'objects');
    if (!head || !isDir(objects)) return undefined;
    const env = { GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
    const git = (...args: string[]) => mustExec(this.exec, 'git', ['-C', repoPath, ...args], { env });
    // Without renames, a source file moved into a test is its deletion: a change outside the tests.
    const fields = (await git('diff', '--name-status', '--no-renames', '-z', base, head)).split('\0').filter(Boolean);
    const changed: StepDiff['changed'] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) changed.push({ path: fields[i + 1]!, deleted: fields[i] === 'D' });
    const show = async (rev: string, p: string) => {
      const r = await this.exec('git', ['-C', repoPath, 'show', `${rev}:${p}`], { env });
      return r.code === 0 ? r.stdout : undefined;
    };
    return {
      head,
      changed,
      existsAtBase: async (paths) => {
        if (paths.length === 0) return new Set();
        // One process for every candidate: the files at the base under these paths.
        const listed = (await git('--literal-pathspecs', 'ls-tree', '-r', '--name-only', '-z', base, '--', ...paths)).split('\0');
        return new Set(paths.filter((p) => listed.some((f) => f === p || f.startsWith(`${p}/`))));
      },
      showAtBase: (p) => show(base, p),
      showAtHead: (p) => show(head, p),
      filesAtHead: async () => (await git('ls-tree', '-r', '--name-only', '-z', head)).split('\0').filter(Boolean),
    };
  }

  /** Git in the agent's directory, on the host: only without sandboxes (`FACTORY_ALLOW_HOST_VERIFY`), where the agent runs on the host anyway. */
  async uncommitted(path: string): Promise<string[]> {
    return parseStatus(await this.git(path, 'status', '--porcelain', '-z', '--untracked-files=all'));
  }

  /**
   * What the sparse checkout (`agentRepository`) does not own: an untracked settings.local.json, what a setup or an
   * agent wrote, what an agent brought back. No git here. A `.claude` that is a link goes, not what it names.
   */
  async resetClaudeDir(path: string): Promise<void> {
    const dir = join(path, '.claude');
    const entries = isDir(dir) ? readdirSync(dir) : [];
    if (!entries.includes('CLAUDE.md')) rmSync(dir, { recursive: true, force: true });
    else for (const e of entries) if (e !== 'CLAUDE.md') rmSync(join(dir, e), { recursive: true, force: true });
  }

  async remoteBranchExists(repoPath: string, prefix: string): Promise<boolean> {
    const out = await this.git(repoPath, 'ls-remote', '--heads', 'origin');
    return out
      .split('\n')
      .map((l) => l.split('\t')[1]?.replace(/^refs\/heads\//, ''))
      .some((name) => !!name && name.startsWith(prefix));
  }
}
