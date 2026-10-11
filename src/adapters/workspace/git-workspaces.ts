import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { branchName } from '../../core/naming.js';
import { runVerify, type Verifier } from '../../core/verify.js';
import { execCmd, mustExec, type Exec } from '../exec.js';
import type { Workspace, WorkspaceManager, WorkspaceRequest } from './types.js';

function assertSafe(id: string): void {
  if (/[\\/]/.test(id) || id.includes('..')) throw new Error(`Identifiant invalide : ${id}`);
}

export class GitWorkspaces implements WorkspaceManager {
  private exec: Exec;
  private verify: Verifier;

  constructor(private o: { root: string; knowledgeRepo?: string; exec?: Exec; verify?: Verifier }) {
    this.exec = o.exec ?? execCmd;
    this.verify = o.verify ?? runVerify;
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
    if (await has(`refs/heads/${branch}`)) {
      await this.git(req.repoPath, 'worktree', 'add', path, branch);
    } else if (await has(`refs/remotes/origin/${branch}`)) {
      await this.git(req.repoPath, 'worktree', 'add', path, '-b', branch, `origin/${branch}`);
    } else {
      await this.git(req.repoPath, 'worktree', 'add', '--no-track', '-b', branch, path, `origin/${await this.trunk(req.repoPath)}`);
    }
    if (req.setup.length) {
      const res = await this.verify(path, req.setup);
      if (!res.ok) {
        await this.exec('git', ['-C', req.repoPath, 'worktree', 'remove', '--force', path]).catch(() => undefined);
        throw new Error(`Le setup du worktree a échoué : ${res.failures[0]!.command}`);
      }
    }
    return { path, port, branch };
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

  async remoteBranchExists(repoPath: string, prefix: string): Promise<boolean> {
    const out = await this.git(repoPath, 'ls-remote', '--heads', 'origin');
    return out
      .split('\n')
      .map((l) => l.split('\t')[1]?.replace(/^refs\/heads\//, ''))
      .some((name) => !!name && name.startsWith(prefix));
  }
}
