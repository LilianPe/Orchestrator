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
 * `trunk`: the branch is the default one. `empty`: the branch holds nothing beyond the base, so there is no PR to open.
 */
export type PublishRefusal = 'moved' | 'rejected' | 'diff' | 'head' | 'trunk' | 'empty';

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
}
