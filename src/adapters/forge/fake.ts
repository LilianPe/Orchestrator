import type { FeedbackItem } from '../../core/types.js';
import type { Forge, PrInfo } from './types.js';

export class FakeForge implements Forge {
  private prs = new Map<string, PrInfo>();
  private comments = new Map<number, FeedbackItem[]>();

  setPr(branch: string, pr: Omit<PrInfo, 'branch'>): void {
    this.prs.set(branch, { ...pr, branch });
  }

  setReviewComments(prNumber: number, items: FeedbackItem[]): void {
    this.comments.set(prNumber, items);
  }

  async findPr(_repoPath: string, branch: string): Promise<PrInfo | undefined> {
    const pr = this.prs.get(branch);
    return pr && { ...pr, failedChecks: [...pr.failedChecks] };
  }

  async unresolvedReviewComments(_repoPath: string, prNumber: number): Promise<FeedbackItem[]> {
    return (this.comments.get(prNumber) ?? []).map((c) => ({ ...c }));
  }
}
