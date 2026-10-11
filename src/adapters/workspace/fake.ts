import { branchName } from '../../core/naming.js';
import type { Workspace, WorkspaceManager, WorkspaceRequest } from './types.js';

export class FakeWorkspaces implements WorkspaceManager {
  prepared: WorkspaceRequest[] = [];
  cleaned: string[] = [];
  remoteBranches = new Set<string>();

  async prepare(req: WorkspaceRequest): Promise<Workspace> {
    this.prepared.push(req);
    if (req.kind === 'trunk-readonly') return { path: `/tmp/relais-fake/${req.projectId}/_trunk` };
    if (req.kind === 'knowledge') return { path: `/tmp/relais-fake/_kb/${req.runId}` };
    return {
      path: `/tmp/relais-fake/${req.projectId}/${req.ticketId}`,
      port: req.portBase + req.slot,
      branch: branchName(req.ticketId, req.title),
    };
  }

  async cleanup(_projectId: string, _repoPath: string, ticketId: string): Promise<void> {
    this.cleaned.push(ticketId);
  }

  async remoteBranchExists(_repoPath: string, prefix: string): Promise<boolean> {
    return [...this.remoteBranches].some((b) => b.startsWith(prefix));
  }
}
