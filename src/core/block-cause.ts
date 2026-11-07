import { PRODUCT_NAME } from '../product.js';

/** Why a ticket waits for a human, in the order the Flux shows the causes (ORC-297). */
export const BLOCK_CAUSES = ['question', 'contested', 'red', 'infra', 'limit', 'loop', 'failed', 'pickup', 'repo_config', 'dead_letter', 'pr_closed', 'stopped', 'other'] as const;
export type BlockCause = (typeof BLOCK_CAUSES)[number];

/** The head of a launch refused on the repository's `.factory/config.yml` (ORC-209 C): the repository's to fix. */
export const REPO_CONFIG_REFUSED = 'Repository configuration to fix: ';

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
  ['limit', /^(Checks|CI) still failing after /],
  ['failed', /^Checks failing after /],
  ['loop', /^Loop: /],
  ['failed', /^The run .+ failed\.$/],
  ['pickup', /^The description (is shorter than|has no)/],
  ['pickup', /^A branch .+ already exists on origin\./],
  ['pickup', /^No repository known for the Linear team /],
  ['pickup', /^Repository to specify: /],
  ['repo_config', new RegExp(`^${REPO_CONFIG_REFUSED}`)],
  ['dead_letter', /^Event .+ set aside /],
  ['pr_closed', /^PR #\d+ closed without merge$/],
  ['stopped', /^Stopped on request$/],
];

/** The cause of a block, read from its reason; `other` when no cause is known for it, never a guess. */
export function blockCause(reason: string | undefined): BlockCause {
  if (reason === undefined) return 'other';
  return CAUSES.find(([, head]) => head.test(reason))?.[0] ?? 'other';
}
