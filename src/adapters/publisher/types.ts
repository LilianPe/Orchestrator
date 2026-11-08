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

export interface Publication {
  prNumber: number;
  url: string;
  sha: string;
}

/**
 * `moved`: the branch holds what the work does not (a human's commit, ORC-159, or a history the agent rewrote). `rejected`: the forge
 * refused the push (a rule of the repository). `diff`: the blocking check of the diff. `head`: the branch's head is not the verified commit.
 * `trunk`: the branch is the default one. `empty`: the branch holds nothing beyond the base, so there is no PR to open. `config`: the base's
 * `.factory/config.yml`, which the check of an untrusted branch reads, is refused (ORC-338).
 */
export type PublishRefusal = 'moved' | 'rejected' | 'diff' | 'head' | 'trunk' | 'empty' | 'config';

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

/**
 * The PR's text until the factory composes it (ORC-195, through the `OutputPolicy` of ORC-214): the ticket's id and title, its own
 * sentence, and nothing an agent wrote. No closing keyword: it is a claim on the whole ticket, and nothing here can make it.
 */
export function prText(t: { ticketId: string; title: string }): { title: string; body: string } {
  return { title: `${t.ticketId} ${t.title}`, body: `Ticket: ${t.ticketId}\n\nPublished by the factory: every pushed commit passed its verification.` };
}

export interface Publisher {
  /** Rejects `PublishRefused` with nothing written on the forge; any other rejection may leave the push done, and a replay finds it. */
  publish(req: PublishRequest): Promise<Publication>;
}
