import { z } from 'zod';
import { OUTPUT_LIMITS } from '../publish/output-limits.js';
import type { Store } from '../store/types.js';
import { formatSpec, item, list, SPEC_FRAME, specSchema } from './spec.js';
import { RISKS, TICKET_SIZES, type RunOutcome } from './types.js';

/**
 * What `intake` makes of the ticket (ORC-206): its size and risk, whether it is complete enough to start, and whether it
 * speaks of a screen. `missing` are the questions a human must answer before the run starts: required when not complete.
 */
export const intakeAssessmentSchema = z
  .object({
    size: z.enum(TICKET_SIZES),
    risk: z.enum(RISKS),
    complete: z.boolean(),
    missing: z.array(z.string().min(1)).max(3),
    screen: z.boolean(),
  })
  .strict()
  .refine((a) => a.complete || a.missing.length > 0, { path: ['missing'], message: 'at least one question when the ticket is not complete' });

/**
 * The comment of a build's end, in the factory's order and words (ORC-289, ORC-214): what the `OutputPolicy` publishes of a
 * result, never the agent's last text. Pure: the schema measures it, the policy posts it.
 */
export function formatResult(o: Pick<AgentOutput, 'summary' | 'why' | 'risks' | 'untested' | 'review_hints'>): string {
  const section = (title: string, items: string[]) => (items.length ? [`**${title}**\n${items.map((i) => `- ${i}`).join('\n')}`] : []);
  return [
    o.summary,
    ...(o.why ? [`**Why**: ${o.why}`] : []),
    ...section('Risks', o.risks),
    ...section('Untested', o.untested),
    ...section('To review', o.review_hints.map((h) => `\`${h.file}\`: ${h.reason}`)),
  ].join('\n\n');
}

/**
 * The three conflicts with the default branch the rebase step leaves to a human (ORC-146): the two sides contradict each
 * other, two migrations change the same schema, or the resolution goes beyond the ticket's scope.
 */
export const CONFLICT_CASES = ['logic', 'migrations', 'scope'] as const;
export type ConflictCase = (typeof CONFLICT_CASES)[number];

/**
 * What the agent hands back through the factory MCP's `submit_result` (ORC-188): the engine never
 * reads free text. A blocked attempt says why: a question for a human, a ticket it contests
 * (`spec_impossible`: contradictory spec, tests it cannot pass honestly) instead of cheating, or a conflict with the
 * default branch it must not resolve (`conflict`, with its case, ORC-146).
 */
export const agentOutputSchema = z
  .object({
    status: z.enum(['done', 'blocked']),
    /** Its texts capped as the `OutputPolicy` caps what the factory composes from them (ORC-214): refused here, the agent shortens them within its run. */
    summary: z.string().min(1).max(OUTPUT_LIMITS.summary),
    /** Required when blocked: the question (`needs_input`) or the justification (`spec_impossible`). */
    question: z.string().min(1).max(OUTPUT_LIMITS.field).optional(),
    /** `spec_impossible` contests the ticket, `conflict` stops a rebase; absent, a blocked attempt needs a human's answer. */
    reason: z.enum(['needs_input', 'spec_impossible', 'conflict']).optional(),
    /** Which of the three conflicts stopped the rebase: required with `reason: conflict`, and only with it. */
    conflict: z.enum(CONFLICT_CASES).optional(),
    tests_added: list,
    why: z.string().max(OUTPUT_LIMITS.field),
    assumptions: list,
    risks: list,
    untested: list,
    review_hints: z.array(z.object({ file: item.min(1), reason: item.min(1) }).strict()).max(OUTPUT_LIMITS.items),
    visual_scenario: z.object({ url: z.string().min(1), steps: z.array(z.string()) }).strict().optional(),
    /** The `intake` step's assessment (ORC-206); its guard reads nothing else. */
    intake: intakeAssessmentSchema.optional(),
    /** The `spec_draft` step's spec (ORC-212): `spec_check` judges it, the factory publishes it. */
    spec: specSchema.optional(),
  })
  .strict()
  .superRefine((o, ctx) => {
    if (o.status === 'blocked' && !o.question) ctx.addIssue({ code: 'custom', path: ['question'], message: 'required when status is blocked' });
    if (o.status === 'done' && o.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'only for a blocked status' });
    if ((o.reason === 'conflict') !== !!o.conflict) ctx.addIssue({ code: 'custom', path: ['conflict'], message: 'required with reason conflict, and only with it' });
    // Each field under its cap can still add up past a comment's: refused here, while the agent can shorten it (ORC-214).
    const published = formatResult(o).length;
    if (published > OUTPUT_LIMITS.text) ctx.addIssue({ code: 'custom', path: ['summary'], message: `summary, why, risks, untested and review_hints together make a comment of ${published} characters, more than ${OUTPUT_LIMITS.text}: shorten them` });
    const spec = o.spec && formatSpec(o.spec).length;
    if (spec && spec > OUTPUT_LIMITS.text - SPEC_FRAME) ctx.addIssue({ code: 'custom', path: ['spec'], message: `the spec makes a message of ${spec} characters, more than ${OUTPUT_LIMITS.text - SPEC_FRAME}: shorten it` });
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
 *   (even if the run then failed: the question it asked still waits for its answer). A `conflict` is a question for a
 *   human too: `decide` reads its case from the output.
 * `noop` has no source yet: a step that finds nothing to do will say so (ponytail: add a status when one does).
 */
export function attemptOutcome(run: { outcome: RunOutcome; infraError?: boolean }, output: AgentOutput | undefined): AttemptOutcome {
  if (run.infraError || run.outcome === 'stopped') return 'errored';
  if (run.outcome === 'limit') return 'timeout';
  if (!output || (output.status === 'done' && run.outcome !== 'success')) return 'failed';
  if (output.status === 'done') return 'succeeded';
  return output.reason === 'spec_impossible' ? 'spec_impossible' : 'needs_input';
}
