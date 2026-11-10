import type { BranchReader, HumanPush } from '../../core/clean-verify.js';
import { branchName, legacyBranchName } from '../../core/naming.js';
import type { StepDiff, Workspace, WorkspaceManager, WorkspaceRequest } from './types.js';

export class FakeWorkspaces implements WorkspaceManager {
  prepared: WorkspaceRequest[] = [];
  cleaned: string[] = [];
  remoteBranches = new Set<string>();
  /** The commit each worktree is on, by path, as a test sets it (a run's commits, a fetch). */
  heads = new Map<string, string>();
  /** Worktrees whose `.claude/` was reset, in order. */
  resetClaude: string[] = [];
  /** Trunks given back, in order. */
  released: string[] = [];
  /** Tickets whose branch has commits beyond the default branch, as a test sets it (ORC-211). */
  ahead = new Set<string>();
  /** Ticket worktrees that exist: the first prepare of one is `fresh`, until its cleanup. */
  private made = new Set<string>();
  private trunks = new Set<string>();

  /** The diff a `published` workspace gives of each commit, as a test sets it (ORC-183); a one-file diff by default. */
  diffs = new Map<string, string>();

  async prepare(req: WorkspaceRequest): Promise<Workspace> {
    this.prepared.push(req);
    if (req.kind === 'published' && !req.sha) throw new Error('An AI review needs the published commit, and there is no published commit to review.');
    if (req.kind === 'trunk-readonly' || req.kind === 'published') {
      const trunk = `/tmp/factory-fake/${req.projectId}/_trunk/${req.runId}`;
      this.trunks.add(trunk);
      return req.sha ? { path: trunk, diff: this.diffs.get(req.sha) ?? 'diff --git a/src/export.ts b/src/export.ts\n+export const csv = 1;' } : { path: trunk };
    }
    const path = `/tmp/factory-fake/${req.projectId}/${req.ticketId}`;
    const fresh = !this.made.has(path);
    this.made.add(path);
    // A legacy branch the ticket already has on the forge is kept (ORC-283), as `GitWorkspaces` does.
    const asked = req.branch ?? branchName(req.ticketId, req.title);
    const legacy = legacyBranchName(req.ticketId, req.title);
    const branch = !this.remoteBranches.has(asked) && this.remoteBranches.has(legacy) ? legacy : asked;
    return { path, port: req.portBase + req.slot, branch, ...(fresh ? { fresh } : {}), ...(fresh && this.ahead.has(req.ticketId) ? { ahead: true } : {}) };
  }

  async cleanup(projectId: string, ticketId: string): Promise<void> {
    this.cleaned.push(ticketId);
    this.made.delete(`/tmp/factory-fake/${projectId}/${ticketId}`);
  }

  async head(path: string): Promise<string | undefined> {
    return this.heads.get(path);
  }

  /** Each ticket worktree's diff against the trunk, by path, as a test sets it (ORC-182); none by default. */
  ticketDiffs = new Map<string, string>();

  async ticketDiff(_repoPath: string, path: string): Promise<string | undefined> {
    return this.ticketDiffs.get(path);
  }

  /**
   * What the commits changed in each worktree, as a test sets it (ORC-123): files at the base and the head by content.
   * Keyed by path, or by `<path>@<base>` for the diff from one base only (the freeze's commit, ORC-131).
   */
  steps = new Map<string, { changed: StepDiff['changed']; base?: Record<string, string>; head?: Record<string, string>; uncommitted?: string[] }>();

  async stepDiff(_repoPath: string, path: string, from: string): Promise<StepDiff | undefined> {
    const d = this.steps.get(`${path}@${from}`) ?? this.steps.get(path);
    if (!d) return undefined;
    const base = d.base ?? {};
    return {
      head: this.heads.get(path) ?? 'head',
      changed: d.changed,
      existsAtBase: async (paths) => new Set(paths.filter((p) => p in base || Object.keys(base).some((f) => f.startsWith(`${p}/`)))),
      showAtBase: async (p) => base[p],
      showAtHead: async (p) => d.head?.[p],
      filesAtHead: async () => Object.keys(d.head ?? {}),
    };
  }

  /**
   * Each worktree's branch as the path rules read it (ORC-338), as a test sets it: what it changed since the fork point,
   * what it changed since each of its ancestors, and the default branch's config. A worktree not set changed nothing;
   * one in `gone` is no worktree at all.
   */
  branches = new Map<string, { changed: StepDiff['changed']; since?: Record<string, string[]>; baseConfig?: string }>();
  gone = new Set<string>();
  /** What each `changedSince` was asked: the mark, and the human heads left out. */
  sinceAsked: { rev: string; humanPushes: readonly HumanPush[] }[] = [];
  /** How each branch was read: from the forge (`fetch`) or not (ORC-358). */
  branchReads: { fetch: boolean }[] = [];

  async branchReader(_repoPath: string, path: string, o: { fetch: boolean }): Promise<BranchReader | undefined> {
    this.branchReads.push({ fetch: o.fetch });
    if (this.gone.has(path)) return undefined;
    const b = this.branches.get(path) ?? { changed: [] };
    return {
      changed: async () => b.changed,
      agentChanges: async (rev, humanPushes) => {
        this.sinceAsked.push({ rev, humanPushes });
        return b.since?.[rev] ?? b.changed.map((f) => f.path);
      },
      showAtFork: async () => undefined,
      showAtHead: async () => undefined,
      baseConfig: async () => b.baseConfig,
    };
  }

  async uncommitted(path: string): Promise<string[]> {
    return this.steps.get(path)?.uncommitted ?? [];
  }

  async resetClaudeDir(path: string): Promise<void> {
    this.resetClaude.push(path);
  }

  async release(projectId: string, runId: string): Promise<void> {
    const trunk = `/tmp/factory-fake/${projectId}/_trunk/${runId}`;
    if (this.trunks.delete(trunk)) this.released.push(trunk);
  }

  async remoteBranchExists(_repoPath: string, matches: (name: string) => boolean): Promise<boolean> {
    return [...this.remoteBranches].some(matches);
  }
}
