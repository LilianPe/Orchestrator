import type { FeedbackItem } from '../../core/types.js';
import type { RepoPermission, RepoPermissions } from '../roles/types.js';
import type { CheckRunRequest, Forge, ForgeWriter, MergeResult, PrInfo, PrRequest } from './types.js';

export type FakeCheckRun = CheckRunRequest & { id: number };

export class FakeForge implements Forge, ForgeWriter, RepoPermissions {
  private prs = new Map<string, PrInfo>();
  /** The PRs `ensurePr` opened, in order. */
  opened: (PrRequest & { number: number })[] = [];
  /** The check runs on the forge, as GitHub keeps them: by id, with their sha and external id. */
  checkRuns: FakeCheckRun[] = [];
  private comments = new Map<number, FeedbackItem[]>();
  private permissions = new Map<string, RepoPermission>();
  /** A forge that does not answer: every read rejects. */
  offline = false;

  setPr(branch: string, pr: Omit<PrInfo, 'branch'>): void {
    this.prs.set(branch, { ...pr, branch });
  }

  /** A GitHub user's permission on the repo (ORC-186); `none` until set. */
  setRepoPermission(login: string, permission: RepoPermission): void {
    this.permissions.set(login, permission);
  }

  async repoPermission(_repoPath: string, login: string): Promise<RepoPermission> {
    this.answer();
    return this.permissions.get(login) ?? 'none';
  }

  setReviewComments(prNumber: number, items: FeedbackItem[]): void {
    this.comments.set(prNumber, items);
  }

  private answer(): void {
    if (this.offline) throw new Error('forge unreachable');
  }

  async findPr(_repoPath: string, branch: string): Promise<PrInfo | undefined> {
    this.answer();
    const pr = this.prs.get(branch);
    return pr && { ...pr, failedChecks: [...pr.failedChecks] };
  }

  async unresolvedReviewComments(_repoPath: string, prNumber: number): Promise<FeedbackItem[]> {
    this.answer();
    return (this.comments.get(prNumber) ?? []).map((c) => ({ ...c }));
  }

  async ensurePr(_repoPath: string, req: PrRequest): Promise<{ number: number; url: string; deduplicated: boolean }> {
    this.answer();
    const pr = this.prs.get(req.branch);
    if (pr?.state === 'OPEN') return { number: pr.number, url: pr.url, deduplicated: true };
    const number = Math.max(0, ...[...this.prs.values()].map((p) => p.number), ...this.opened.map((p) => p.number)) + 1;
    const url = `https://github.test/pr/${number}`;
    this.opened.push({ ...req, number });
    this.setPr(req.branch, { number, url, state: 'OPEN', checks: 'pending', failedChecks: [] });
    return { number, url, deduplicated: false };
  }

  /** The merges asked (ORC-148), with the head each one required. */
  merges: { number: number; sha: string }[] = [];
  /** The checks of the PRs' base commit: `none` is a repository with no CI (ORC-148). */
  baseChecks: PrInfo['checks'] = 'none';

  /** As GitHub: merged only if the PR's head is still `sha`; a PR already merged on it is found again. */
  async mergePr(_repoPath: string, number: number, sha: string, opts: { unchecked?: boolean } = {}): Promise<MergeResult> {
    this.answer();
    const pr = [...this.prs.values()].find((p) => p.number === number);
    if (!pr) throw new Error(`no PR #${number}`);
    if (pr.state === 'MERGED' && pr.headSha === sha) return { merged: true, deduplicated: true };
    if (pr.headSha !== sha) return { merged: false, reason: 'head_moved' };
    if (pr.state !== 'OPEN' || pr.checks === 'fail') return { merged: false, reason: 'not_mergeable', message: 'Pull Request is not mergeable' };
    if (opts.unchecked && this.baseChecks !== 'none') return { merged: false, reason: 'checks_missing' };
    this.merges.push({ number, sha });
    this.prs.set(pr.branch, { ...pr, state: 'MERGED' });
    return { merged: true, deduplicated: false };
  }

  async upsertCheckRun(_repoPath: string, req: CheckRunRequest): Promise<{ id: number; deduplicated: boolean }> {
    this.answer();
    const existing = this.checkRuns.find((c) => c.sha === req.sha && c.externalId === req.externalId);
    if (existing) {
      Object.assign(existing, req);
      return { id: existing.id, deduplicated: true };
    }
    const id = this.checkRuns.length + 1;
    this.checkRuns.push({ ...req, id });
    return { id, deduplicated: false };
  }
}
