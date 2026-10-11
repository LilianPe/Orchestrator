import type { FeedbackItem } from '../../core/types.js';

export interface PrInfo {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  branch: string;
  checks: 'pending' | 'pass' | 'fail' | 'none';
  failedChecks: string[];
}

export interface Forge {
  findPr(repoPath: string, branch: string): Promise<PrInfo | undefined>;
  unresolvedReviewComments(repoPath: string, prNumber: number): Promise<FeedbackItem[]>;
}
