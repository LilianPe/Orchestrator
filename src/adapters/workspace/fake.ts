import { branchName } from '../../core/naming.js';
import type { TrunkDiff, Workspace, WorkspaceManager, WorkspaceRequest } from './types.js';

export class FakeWorkspaces implements WorkspaceManager {
  prepared: WorkspaceRequest[] = [];
  cleaned: string[] = [];
  remoteBranches = new Set<string>();
  /** The commit each worktree is on, by path, as a test sets it (a run's commits, a fetch). */
  heads = new Map<string, string>();
  /** Worktrees whose `.claude/` was reset, in order. */
  resetClaude: string[] = [];
  /** Ticket worktrees that exist: the first prepare of one is `fresh`, until its cleanup. */
  private made = new Set<string>();

  async prepare(req: WorkspaceRequest): Promise<Workspace> {
    this.prepared.push(req);
    if (req.kind === 'trunk-readonly') return { path: `/tmp/factory-fake/${req.projectId}/_trunk` };
    if (req.kind === 'knowledge') return { path: `/tmp/factory-fake/_kb/${req.runId}` };
    const path = `/tmp/factory-fake/${req.projectId}/${req.ticketId}`;
    const fresh = !this.made.has(path);
    this.made.add(path);
    return { path, port: req.portBase + req.slot, branch: branchName(req.ticketId, req.title), ...(fresh ? { fresh } : {}) };
  }

  async cleanup(projectId: string, _repoPath: string, ticketId: string): Promise<void> {
    this.cleaned.push(ticketId);
    this.made.delete(`/tmp/factory-fake/${projectId}/${ticketId}`);
  }

  async head(path: string): Promise<string | undefined> {
    return this.heads.get(path);
  }

  /** What each worktree's commits changed since the trunk, and the paths at baseSha, as a test sets them (ORC-123). */
  trunkDiffs = new Map<string, { changed: TrunkDiff['changed']; atBase?: string[] }>();

  async sinceTrunk(_repoPath: string, path: string): Promise<TrunkDiff | undefined> {
    const d = this.trunkDiffs.get(path);
    return d && { changed: d.changed, existsAtBase: async (p) => d.atBase?.includes(p) ?? false };
  }

  async resetClaudeDir(path: string): Promise<void> {
    this.resetClaude.push(path);
  }

  async gitCommonDir(): Promise<string> {
    return '/repo/.git';
  }

  async remoteBranchExists(_repoPath: string, prefix: string): Promise<boolean> {
    return [...this.remoteBranches].some((b) => b.startsWith(prefix));
  }
}
