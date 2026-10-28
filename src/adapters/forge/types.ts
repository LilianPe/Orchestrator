import type { FeedbackItem } from '../../core/types.js';

export interface PrInfo {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  branch: string;
  /** SHA of the PR's head commit, when the forge reads it: the checks verdict is per head (ORC-134). */
  headSha?: string;
  checks: 'pending' | 'pass' | 'fail' | 'none';
  failedChecks: string[];
}

export interface Forge {
  findPr(repoPath: string, branch: string): Promise<PrInfo | undefined>;
  unresolvedReviewComments(repoPath: string, prNumber: number): Promise<FeedbackItem[]>;
}
