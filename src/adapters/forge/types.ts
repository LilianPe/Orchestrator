import type { FeedbackItem } from '../../core/types.js';

export interface PrInfo {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  branch: string;
  /** SHA of the PR's head commit, when the forge reads it: the checks verdict is per head (ORC-134). */
  headSha?: string;
  /** SHA of the commit a merged PR put on its base branch, when the forge reads it: a revert names it (ORC-278). */
  mergeSha?: string;
  /** When a merged PR was merged, on the forge's clock (ORC-278). */
  mergedAt?: number;
  checks: 'pending' | 'pass' | 'fail' | 'none';
  failedChecks: string[];
}

export interface Forge {
  findPr(repoPath: string, branch: string): Promise<PrInfo | undefined>;
  unresolvedReviewComments(repoPath: string, prNumber: number): Promise<FeedbackItem[]>;
}

/** A PR the factory opens for its branch (ORC-162), by its Publisher (ORC-125). */
export interface PrRequest {
  branch: string;
  base: string;
  title: string;
  body: string;
  /** A draft until the factory's own work ends (`markPrReady`): only then does a human review it. */
  draft?: true;
}

/** The forge refuses the PR as the branch holds nothing its base lacks: an answer of the forge, whichever forge. */
export class NoCommitsBetween extends Error {}

/** How the factory's git reaches the repository (ORC-125): the URL, and what it needs in its environment, where no command line shows it. */
export interface GitAccess {
  url: string;
  env: Record<string, string>;
}

/**
 * The factory's own checks (`factory/…`, ORC-151): its verdict, published once it pushed, never the repository's CI. Read as
 * CI, a head with them alone would pass for green, and merge before the real CI ran.
 */
export const isFactoryCheck = (name: string): boolean => name.startsWith('factory/');

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
/**
 * The outcome of a merge (ORC-148). A refusal GitHub gives for a reason the human must hear (the head moved since
 * the review, the PR is not mergeable) is an answer, not an error: the ticket goes back to Human Review with it.
 */
export type MergeResult =
  | { merged: true; deduplicated: boolean }
  | { merged: false; reason: 'head_moved' }
  /** Asked `unchecked` (the head has no check) in a repository with a CI, or one whose workflows are unreadable. */
  | { merged: false; reason: 'checks_missing' }
  | { merged: false; reason: 'not_mergeable'; message: string };

export interface ForgeWriter {
  /**
   * Merges the PR if its head is still `sha`, the commit shown to the human reviewer: GitHub checks it in the same
   * call. A PR already merged on that head is found by a replay, and nothing is written again. `unchecked`: the head
   * had no check at all; merged only in a repository with no CI (read at the merge: the head still without check, no
   * active Actions workflow of the repository's own, the PR's base commit without check).
   */
  mergePr(repoPath: string, number: number, sha: string, opts?: { unchecked?: boolean }): Promise<MergeResult>;
  /** Opens the branch's PR, or returns its open one: never a second open PR for the branch. A closed or merged one is not reused (ORC-138, point 7). */
  ensurePr(repoPath: string, req: PrRequest): Promise<{ number: number; url: string; deduplicated: boolean }>;
  /** Takes the PR out of draft; one already out stays as it is. */
  markPrReady(repoPath: string, number: number): Promise<void>;
  /** Git access to the repository for the factory alone (ORC-125): the App's token, limited to it, never given to a run. */
  gitAccess(repoPath: string): Promise<GitAccess>;
  /** Creates the check run, or updates the one of the sha that carries `externalId`. */
  upsertCheckRun(repoPath: string, req: CheckRunRequest): Promise<{ id: number; deduplicated: boolean }>;
}
