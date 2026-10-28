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

/** A PR the factory opens for its branch (ORC-162; the Publisher of ORC-125 will call it). */
export interface PrRequest {
  branch: string;
  base: string;
  title: string;
  body: string;
}

/** A check run the factory publishes on a sha (ORC-162): `externalId` is the id of the effect that created it (ORC-138, point 5). */
export type CheckRunRequest = {
  sha: string;
  name: string;
  externalId: string;
  /** The check's output; GitHub shows `name` as its title when only a summary is given. */
  title?: string;
  summary?: string;
} & (
  | { status: 'queued' | 'in_progress'; conclusion?: undefined }
  /** GitHub requires a conclusion once the check is completed. */
  | { status: 'completed'; conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' }
);

/**
 * What the factory itself writes on the forge, each write idempotent (ORC-162, docs/idempotence.md):
 * a replay finds what the first one wrote and says so (`deduplicated`). Only the GitHub App adapter
 * writes: GitHub lets only an app create check runs, so `gh` and its user token cannot.
 */
export interface ForgeWriter {
  /** Opens the branch's PR, or returns its open one: never a second open PR for the branch. A closed or merged one is not reused (ORC-138, point 7). */
  ensurePr(repoPath: string, req: PrRequest): Promise<{ number: number; url: string; deduplicated: boolean }>;
  /** Creates the check run, or updates the one of the sha that carries `externalId`. */
  upsertCheckRun(repoPath: string, req: CheckRunRequest): Promise<{ id: number; deduplicated: boolean }>;
}
