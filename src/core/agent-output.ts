import { z } from 'zod';
import type { Store } from '../store/types.js';
import type { RunOutcome } from './types.js';

/**
 * What the agent hands back through the factory MCP's `submit_result` (ORC-188): the engine never
 * reads free text. A blocked attempt says why: a question for a human, or a ticket it contests
 * (`spec_impossible`: contradictory spec, tests it cannot pass honestly) instead of cheating.
 */
export const agentOutputSchema = z
  .object({
    status: z.enum(['done', 'blocked']),
    summary: z.string().min(1),
    /** Required when blocked: the question (`needs_input`) or the justification (`spec_impossible`). */
    question: z.string().min(1).optional(),
    /** `spec_impossible` contests the ticket; absent, a blocked attempt needs a human's answer. */
    reason: z.enum(['needs_input', 'spec_impossible']).optional(),
    tests_added: z.array(z.string()),
    why: z.string(),
    assumptions: z.array(z.string()),
    risks: z.array(z.string()),
    untested: z.array(z.string()),
    review_hints: z.array(z.object({ file: z.string().min(1), reason: z.string().min(1) }).strict()),
    visual_scenario: z.object({ url: z.string().min(1), steps: z.array(z.string()) }).strict().optional(),
  })
  .strict()
  .superRefine((o, ctx) => {
    if (o.status === 'blocked' && !o.question) ctx.addIssue({ code: 'custom', path: ['question'], message: 'required when status is blocked' });
    if (o.status === 'done' && o.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'only for a blocked status' });
  });

export type AgentOutput = z.infer<typeof agentOutputSchema>;

/** Where the factory MCP's `submit_result` keeps a run's validated output (ORC-288). */
export const agentOutputKey = (runId: string): string => `agent-output:${runId}`;

/** Keeps a run's validated output, the contract with the engine: read when the run ends. */
export const saveAgentOutput = (store: Pick<Store, 'setMeta'>, runId: string, output: AgentOutput): Promise<void> => store.setMeta(agentOutputKey(runId), JSON.stringify(output));

/** Closed outcomes of an agent attempt (doc MVP). `errored` is infrastructure: never sent back to the agent to fix. */
export type AttemptOutcome = 'succeeded' | 'failed' | 'noop' | 'needs_input' | 'timeout' | 'spec_impossible' | 'errored';

/** Validates a submitted output; the error names the offending field(s), for the agent to fix within its run. */
export function parseAgentOutput(raw: unknown): { ok: true; output: AgentOutput } | { ok: false; error: string } {
  const r = agentOutputSchema.safeParse(raw);
  if (r.success) return { ok: true, output: r.data };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || '(racine)'}: ${i.message}`).join('; ') };
}

/**
 * The attempt's outcome, from how the runner ended and what `submit_result` recorded (ORC-188):
 * - the runner broke (launch error, broken stream, sandbox down) → `errored`;
 * - a cap (duration or turns) → `timeout`; a stop → `errored` too: nothing for the agent to fix;
 * - no valid output, or a `done` from a run that failed → `failed`;
 * - otherwise the output's status: `done` → `succeeded`, `blocked` → `needs_input` or `spec_impossible`
 *   (even if the run then failed: the question it asked still waits for its answer).
 * `noop` has no source yet: a step that finds nothing to do will say so (ponytail: add a status when one does).
 */
export function attemptOutcome(run: { outcome: RunOutcome; infraError?: boolean }, output: AgentOutput | undefined): AttemptOutcome {
  if (run.infraError || run.outcome === 'stopped') return 'errored';
  if (run.outcome === 'limit') return 'timeout';
  if (!output || (output.status === 'done' && run.outcome !== 'success')) return 'failed';
  if (output.status === 'done') return 'succeeded';
  return output.reason === 'spec_impossible' ? 'spec_impossible' : 'needs_input';
}
