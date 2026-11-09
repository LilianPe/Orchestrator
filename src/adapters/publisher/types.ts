import type { UntrustedMark } from '../../core/clean-verify.js';

/** The factory pushes the verified sha and opens or finds the branch's PR (ORC-125). */
export interface PublishRequest {
  projectId: string;
  repoPath: string;
  ticketId: string;
  /** The attempt that wrote the work: its sandboxes are `<runId>-publish`, so `recover()` finds them among the dead. */
  runId: string;
  /** The agent's worktree: what the bundle is made from, in a sandbox, and read nowhere else. */
  worktree: string;
  branch: string;
  sha: string;
  /** The branch took untrusted content (ORC-338): what its agent commits changed since the mark in the repository's `sensitive_paths` is refused. */
  untrusted?: UntrustedMark;
  /**
   * A rebase's commit (ORC-146): the head the factory published last, which it may replace although the work no longer holds
   * it. Any other head on the forge is still refused, and the lease stays on the head read.
   */
  rewrites?: string;
  title: string;
  body: string;
}

/** A bundle a human hands back after a take-over (ORC-234), which the factory checks and pushes. */
export interface BundleRequest {
  projectId: string;
  repoPath: string;
  ticketId: string;
  /** The take-over's key: where its work goes on the host (`<runsDir>/<runId>`), and its sandboxes (`<runId>-publish-secrets`). */
  runId: string;
  branch: string;
  /** The human's bundle, a file on the host: read only as data. */
  bundle: string;
}

/** The bundle's head, on the forge now, and the head it went over: the human's push (ORC-159). */
export interface BundlePush {
  sha: string;
  before?: string;
}

export interface Publication {
  prNumber: number;
  url: string;
  sha: string;
}

/**
 * `moved`: the branch holds what the work does not (a human's commit, ORC-159, or a history the agent rewrote). `rejected`: the forge
 * refused the push (a rule of the repository). `diff`: the blocking check of the diff. `head`: the branch's head is not the verified commit.
 * `trunk`: the branch is the default one. `empty`: the branch holds nothing beyond the base, so there is no PR to open. `config`: the base's
 * `.factory/config.yml`, which the check of an untrusted branch reads, is refused (ORC-338). `bundle`: a bundle handed back after a take-over
 * that does not verify (ORC-234).
 */
export type PublishRefusal = 'moved' | 'rejected' | 'diff' | 'head' | 'trunk' | 'empty' | 'config' | 'bundle';

/** An answer, not a failure: nothing is written on the forge, and it is decided once. Any other rejection is retried. */
export class PublishRefused extends Error {
  constructor(
    readonly code: PublishRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'PublishRefused';
  }
}

export interface Publisher {
  /** Rejects `PublishRefused` with nothing written on the forge; any other rejection may leave the push done, and a replay finds it. */
  publish(req: PublishRequest): Promise<Publication>;
  /**
   * The same check and push, from a human's bundle (ORC-234), with no PR: it rejects `PublishRefused` with nothing written on the
   * forge. Absent, a bundle is refused.
   */
  publishBundle?(req: BundleRequest): Promise<BundlePush>;
}
