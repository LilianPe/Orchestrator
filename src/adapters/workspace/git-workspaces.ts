import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { branchName } from '../../core/naming.js';
import { execCmd, mustExec, type Exec } from '../exec.js';
import type { StepDiff, Workspace, WorkspaceManager, WorkspaceRequest } from './types.js';

function assertSafe(id: string): void {
  if (/[\\/]/.test(id) || id.includes('..')) throw new Error(`Identifiant invalide : ${id}`);
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

export class GitWorkspaces implements WorkspaceManager {
  private exec: Exec;

  constructor(private o: { root: string; knowledgeRepo?: string; exec?: Exec }) {
    this.exec = o.exec ?? execCmd;
  }

  private git(repo: string, ...args: string[]): Promise<string> {
    return mustExec(this.exec, 'git', ['-C', repo, ...args]);
  }

  private async trunk(repo: string): Promise<string> {
    const r = await this.exec('git', ['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    return r.code === 0 ? r.stdout.trim().replace(/^origin\//, '') : 'main';
  }

  async prepare(req: WorkspaceRequest): Promise<Workspace> {
    assertSafe(req.projectId);
    assertSafe(req.ticketId);
    if (req.kind === 'trunk-readonly') return this.trunkWorkspace(req);
    if (req.kind === 'knowledge') return this.knowledgeWorkspace(req);
    const path = join(this.o.root, req.projectId, req.ticketId);
    const port = req.portBase + req.slot;
    if (existsSync(path)) {
      const branch = (await this.git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
      return { path, port, branch };
    }
    mkdirSync(dirname(path), { recursive: true });
    await this.git(req.repoPath, 'fetch', 'origin');
    const branch = branchName(req.ticketId, req.title);
    const has = async (ref: string) =>
      (await this.exec('git', ['-C', req.repoPath, 'rev-parse', '--verify', '--quiet', ref])).code === 0;
    const trunk = `origin/${await this.trunk(req.repoPath)}`;
    if (await has(`refs/heads/${branch}`)) {
      await this.git(req.repoPath, 'worktree', 'add', path, branch);
    } else if (await has(`refs/remotes/origin/${branch}`)) {
      await this.git(req.repoPath, 'worktree', 'add', path, '-b', branch, `origin/${branch}`);
    } else {
      await this.git(req.repoPath, 'worktree', 'add', '--no-track', '-b', branch, path, trunk);
      return { path, port, branch, fresh: true };
    }
    const ahead = (await this.git(path, 'rev-list', '--count', `${trunk}..HEAD`)).trim() !== '0';
    return { path, port, branch, fresh: true, ...(ahead ? { ahead } : {}) };
  }

  private async trunkWorkspace(req: WorkspaceRequest): Promise<Workspace> {
    const path = join(this.o.root, req.projectId, '_trunk');
    await this.git(req.repoPath, 'fetch', 'origin');
    const ref = `origin/${await this.trunk(req.repoPath)}`;
    if (existsSync(path)) await this.git(path, 'checkout', '-f', '--detach', ref);
    else {
      mkdirSync(dirname(path), { recursive: true });
      await this.git(req.repoPath, 'worktree', 'add', '--detach', path, ref);
    }
    return { path };
  }

  private async knowledgeWorkspace(req: WorkspaceRequest): Promise<Workspace> {
    const kb = this.o.knowledgeRepo;
    if (!kb) throw new Error('Aucun dépôt de connaissance configuré.');
    await this.git(kb, 'fetch', 'origin');
    const path = join(this.o.root, '_kb', req.runId);
    const branch = `learn/${req.ticketId.toLowerCase()}-${req.runId.slice(0, 8)}`;
    mkdirSync(dirname(path), { recursive: true });
    await this.git(kb, 'worktree', 'add', '-b', branch, path, `origin/${await this.trunk(kb)}`);
    return { path, branch };
  }

  async cleanup(projectId: string, repoPath: string, ticketId: string): Promise<void> {
    assertSafe(projectId);
    assertSafe(ticketId);
    const path = join(this.o.root, projectId, ticketId);
    if (existsSync(path)) await this.git(repoPath, 'worktree', 'remove', '--force', path);
  }

  async head(path: string): Promise<string | undefined> {
    if (!existsSync(path)) return undefined;
    const r = await this.exec('git', ['-C', path, 'rev-parse', 'HEAD']);
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  async stepDiff(repoPath: string, path: string, base: string): Promise<StepDiff | undefined> {
    const head = await this.head(path);
    if (!head) return undefined;
    // Without renames, a source file moved into a test is its deletion: a change outside the tests.
    const fields = (await this.git(repoPath, 'diff', '--name-status', '--no-renames', '-z', base, head)).split('\0').filter(Boolean);
    const changed: StepDiff['changed'] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) changed.push({ path: fields[i + 1]!, deleted: fields[i] === 'D' });
    const show = async (rev: string, p: string) => {
      const r = await this.exec('git', ['-C', repoPath, 'show', `${rev}:${p}`]);
      return r.code === 0 ? r.stdout : undefined;
    };
    return {
      changed,
      existsAtBase: async (paths) => {
        if (paths.length === 0) return new Set();
        // One process for every candidate: the files at the base under these paths.
        const listed = (await this.git(repoPath, '--literal-pathspecs', 'ls-tree', '-r', '--name-only', '-z', base, '--', ...paths)).split('\0');
        return new Set(paths.filter((p) => listed.some((f) => f === p || f.startsWith(`${p}/`))));
      },
      showAtBase: (p) => show(base, p),
      showAtHead: (p) => show(head, p),
    };
  }

  async uncommitted(path: string): Promise<string[]> {
    return parseStatus(await this.git(path, 'status', '--porcelain', '-z', '--untracked-files=all'));
  }

  async gitCommonDir(path: string): Promise<string> {
    return (await this.git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim();
  }

  /**
   * Left out of the worktree's sparse checkout but for `.claude/CLAUDE.md`, which the factory reads as the
   * repo's conventions (`readConventions`) and the session does not load (`--setting-sources ""`, ORC-128).
   * The rest: the agent's session cannot load it, `git status`, `add -A`
   * or `commit -a` neither see nor commit it as deleted, so a PR never drops the repo's `.claude/`, and a
   * merge or rebase that changes it does not write it back (skip-worktree alone did). The index keeps it.
   * Sparse checkout is per worktree (`extensions.worktreeConfig`, set by git): the repo's own checkout keeps
   * its `.claude/`. The rm takes what the checkout does not own (an untracked settings.local.json).
   * `!/.claude/*`, not `!/.claude/`: git re-includes a file only if its parent directory is not excluded.
   */
  async resetClaudeDir(path: string): Promise<void> {
    await this.git(path, 'sparse-checkout', 'set', '--no-cone', '/*', '!/.claude/*', '/.claude/CLAUDE.md');
    const dir = join(path, '.claude');
    const entries = existsSync(dir) ? readdirSync(dir) : [];
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
