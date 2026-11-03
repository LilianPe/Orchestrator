export type WorkspaceKind = 'worktree' | 'trunk-readonly' | 'knowledge';

export interface WorkspaceRequest {
  projectId: string;
  repoPath: string;
  ticketId: string;
  title: string;
  kind: WorkspaceKind;
  slot: number;
  portBase: number;
  runId: string;
}

export interface Workspace {
  path: string;
  port?: number;
  branch?: string;
  /** True when `prepare` just created the worktree: the repository's `setup` is then the caller's to run (ORC-204). */
  fresh?: boolean;
}

export interface TrunkDiff {
  changed: { path: string; deleted: boolean }[];
  existsAtBase(path: string): Promise<boolean>;
}

export interface WorkspaceManager {
  prepare(req: WorkspaceRequest): Promise<Workspace>;
  cleanup(projectId: string, repoPath: string, ticketId: string): Promise<void>;
  remoteBranchExists(repoPath: string, prefix: string): Promise<boolean>;
  /** The commit a worktree's run ended on (ORC-148: only it may be recorded as reviewed); none for a path that is no worktree. */
  head(path: string): Promise<string | undefined>;
  /**
   * What a worktree's commits changed since it left the trunk (baseSha: their merge-base), and whether a path
   * exists at baseSha (ORC-123). Read on the factory's repository by the worktree's head; none for a path that is
   * no worktree.
   */
  sinceTrunk(repoPath: string, path: string): Promise<TrunkDiff | undefined>;
  /** Hides the repository's `.claude/` from a worktree before each session (ORC-284), without its PR deleting it. */
  resetClaudeDir(path: string): Promise<void>;
  /** The absolute git dir a worktree's `.git` file points into (ORC-204: mounted in its sandbox for git to work there). */
  gitCommonDir(path: string): Promise<string>;
}
