import type { FeedbackItem } from '../../core/types.js';
import type { CheckRunRequest, Forge, ForgeWriter, PrInfo, PrRequest } from './types.js';

export interface FakeCheckRun extends CheckRunRequest {
  id: number;
}

export class FakeForge implements Forge, ForgeWriter {
  private prs = new Map<string, PrInfo>();
  /** The PRs `ensurePr` opened, in order. */
  opened: (PrRequest & { number: number })[] = [];
  /** The check runs on the forge, as GitHub keeps them: by id, with their sha and external id. */
  checkRuns: FakeCheckRun[] = [];
  private comments = new Map<number, FeedbackItem[]>();
  /** A forge that does not answer: every read rejects. */
  offline = false;

  setPr(branch: string, pr: Omit<PrInfo, 'branch'>): void {
    this.prs.set(branch, { ...pr, branch });
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
