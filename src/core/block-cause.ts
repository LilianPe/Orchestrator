import { PRODUCT_NAME } from '../product.js';
import { BEFORE_ORC_331 } from './legacy-messages.js';

/** Why a ticket waits for a human, in the order the Flow shows the causes (ORC-297). */
export const BLOCK_CAUSES = ['question', 'contested', 'red', 'infra', 'limit', 'loop', 'failed', 'pickup', 'repo_config', 'dead_letter', 'pr_closed', 'stopped', 'other'] as const;
export type BlockCause = (typeof BLOCK_CAUSES)[number];

/** The reason of a stop: the label of its cause in the Flow too. */
export const STOPPED = 'Stopped on request';
/** The reason of a question the agent asks during its run: the label of its cause in the Flow too. */
export const AGENT_QUESTION = 'Question asked by the agent';

/** The reasons that say no more than their cause, before ORC-331 too: the Flow does not repeat them under it (ORC-332). */
const CAUSE_ONLY: Partial<Record<BlockCause, readonly string[]>> = {
  stopped: [STOPPED, BEFORE_ORC_331.stopped],
  question: [AGENT_QUESTION, BEFORE_ORC_331.question],
};

export const onlyRestatesCause = (cause: BlockCause, reason: string): boolean => CAUSE_ONLY[cause]?.includes(reason) ?? false;

/** The head of the guard before In Progress refusing a ticket `intake` found incomplete (ORC-206): the ticket's to complete. */
export const INCOMPLETE = 'The ticket is not complete enough to start:';
/** The reason of an `intake` whose result carries no assessment (ORC-206): the ticket does not start. */
export const NO_ASSESSMENT = 'Intake returned no assessment of the ticket.';

/** The head of a launch refused on the repository's `.factory/config.yml` (ORC-209 C): the repository's to fix. */
export const REPO_CONFIG_REFUSED = 'Repository configuration to fix: ';

/** The head of a launch refused on the ticket's token budget (`budgets.per_ticket_tokens`, ORC-340). */
export const TICKET_TOKENS_REACHED = 'Token budget of the ticket reached: ';

/**
 * Each anchored on the head of a reason, which the factory writes: what follows may quote an error or
 * a job name. A block's cause lives in its reason alone, the projection has no field for it: a new
 * one would change what the replay compares (ORC-174).
 */
const CAUSES: readonly (readonly [Exclude<BlockCause, 'other'>, RegExp])[] = [
  ['question', /^(Question asked by the agent|Waiting for an answer to the agent's question)/],
  ['contested', /^The agent disputes the ticket/],
  ['red', /^Red not verified after /],
  ['infra', /^The run .+ was interrupted: infrastructure failure/],
  ['infra', /^The red check of .+ could not run: infrastructure failure/],
  ['infra', /^The verification of .+ could not run: infrastructure failure/],
  ['infra', /^Launch error: /],
  ['infra', /^Error: /],
  ['infra', new RegExp(`^${PRODUCT_NAME} restarted during `)],
  ['infra', /^The lease of the run .+ expired \d+ times: /],
  ['limit', /^The run .+ reached a limit/],
  ['limit', /^The run .+ has written nothing for /],
  ['limit', /^Too many relaunches after a cut: /],
  ['limit', new RegExp(`^${TICKET_TOKENS_REACHED}`)],
  ['limit', /^(Checks|CI) still failing after /],
  ['failed', /^Checks failing after /],
  ['loop', /^Loop: /],
  ['failed', /^The run .+ failed\.$/],
  ['failed', new RegExp(`^${NO_ASSESSMENT}`)],
  ['pickup', /^The description (is shorter than|has no)/],
  ['pickup', /^A branch .+ already exists on origin\./],
  ['pickup', /^No repository known for the Linear team /],
  ['pickup', /^Repository to specify: /],
  ['pickup', new RegExp(`^${INCOMPLETE}`)],
  ['repo_config', new RegExp(`^${REPO_CONFIG_REFUSED}`)],
  ['dead_letter', /^Event .+ set aside /],
  ['pr_closed', /^PR #\d+ closed without merge$/],
  ['stopped', /^Stopped on request$/],
  // A ticket blocked before ORC-331 keeps its French reason until it is unblocked.
  ...BEFORE_ORC_331.causes,
];

/** The cause of a block, read from its reason; `other` when no cause is known for it, never a guess. */
export function blockCause(reason: string | undefined): BlockCause {
  if (reason === undefined) return 'other';
  return CAUSES.find(([, head]) => head.test(reason))?.[0] ?? 'other';
}
