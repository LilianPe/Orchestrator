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
  /** True when a fresh worktree came on commits beyond the default branch, a previous agent's: its `setup` then runs code nobody reviewed, and gets no secret (ORC-211). */
  ahead?: boolean;
}

/** What a step's commits changed, read on the factory's repository (ORC-123): the `red` check's view of the step. */
export interface StepDiff {
  changed: { path: string; deleted: boolean }[];
  /** Of `paths`, those that exist at the base (a file, or a directory). */
  existsAtBase(paths: readonly string[]): Promise<Set<string>>;
  showAtBase(path: string): Promise<string | undefined>;
  showAtHead(path: string): Promise<string | undefined>;
}

export interface WorkspaceManager {
  prepare(req: WorkspaceRequest): Promise<Workspace>;
  cleanup(projectId: string, repoPath: string, ticketId: string): Promise<void>;
  remoteBranchExists(repoPath: string, prefix: string): Promise<boolean>;
  /** The commit a worktree's run ended on (ORC-148: only it may be recorded as reviewed); none for a path that is no worktree. */
  head(path: string): Promise<string | undefined>;
  /** What the commits from `base` to a worktree's head changed (ORC-123); none for a path that is no worktree. */
  stepDiff(repoPath: string, path: string, base: string): Promise<StepDiff | undefined>;
  /** The worktree's changes that are not committed, untracked files included, read on the host (ORC-123). */
  uncommitted(path: string): Promise<string[]>;
  /** Hides the repository's `.claude/` from a worktree before each session (ORC-284), without its PR deleting it. */
  resetClaudeDir(path: string): Promise<void>;
  /** The absolute git dir a worktree's `.git` file points into (ORC-204: mounted in its sandbox for git to work there). */
  gitCommonDir(path: string): Promise<string>;
}
