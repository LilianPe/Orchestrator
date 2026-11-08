/** Why a ticket waits for a human, in the order the Flow shows the causes (ORC-297). */
export const BLOCK_CAUSES = ['question', 'contested', 'red', 'infra', 'limit', 'loop', 'failed', 'pickup', 'repo_config', 'dead_letter', 'pr_closed', 'stopped', 'other'] as const;
export type BlockCause = (typeof BLOCK_CAUSES)[number];

/**
 * What a block is, set on `ticket.blocked` by the code that builds it (ORC-345): the engine decides on it, the Flow
 * classes by it, and the reason is only shown. A cause, or one of the kinds the engine tells apart within a cause:
 * `asked`, a question the agent asks during its run, whose reason says no more than its cause; `stuck`, a pending job
 * no settle could start (ORC-339), which a reply starts; `ci_bound`, the red-CI bound (ORC-270), which a green CI lifts.
 */
export type BlockKind = BlockCause | 'asked' | 'stuck' | 'ci_bound';

const WITHIN: Partial<Record<BlockKind, BlockCause>> = { asked: 'question', stuck: 'infra', ci_bound: 'limit' };

/** The cause the Flow shows a block under; `other` for a ticket blocked without a kind, never a guess. */
export const causeOf = (kind: BlockKind | undefined): BlockCause => (kind === undefined ? 'other' : (WITHIN[kind] ?? (kind as BlockCause)));

/** The kinds whose reason says no more than their cause: the Flow does not repeat it under it (ORC-332). */
export const restatesCause = (kind: BlockKind | undefined): boolean => kind === 'stopped' || kind === 'asked';

/** The reason of a stop: the label of its cause in the Flow too. */
export const STOPPED = 'Stopped on request';
/** The reason of a question the agent asks during its run: the label of its cause in the Flow too. */
export const AGENT_QUESTION = 'Question asked by the agent';

/** The head of the guard before In Progress refusing a ticket `intake` found incomplete (ORC-206): the ticket's to complete. */
export const INCOMPLETE = 'The ticket is not complete enough to start:';
/** The reason of an `intake` whose result carries no assessment (ORC-206): the ticket does not start. */
export const NO_ASSESSMENT = 'Intake returned no assessment of the ticket.';

/** The head of a launch refused on the repository's `.factory/config.yml` (ORC-209 C): the repository's to fix. */
export const REPO_CONFIG_REFUSED = 'Repository configuration to fix: ';

/** The head of a launch refused on the ticket's token budget (`budgets.per_ticket_tokens`, ORC-340). */
export const TICKET_TOKENS_REACHED = 'Token budget of the ticket reached: ';
