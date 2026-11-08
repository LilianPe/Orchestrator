import { z } from 'zod';
import { OUTPUT_LIMITS } from '../publish/output-limits.js';
import type { Store } from '../store/types.js';
import { RISKS, TICKET_SIZES, type RunOutcome } from './types.js';

/** A text of intake's three checks (ORC-207): one entry of what the factory publishes. */
const finding = z.string().min(1).max(OUTPUT_LIMITS.item);

/**
 * What `intake` makes of the ticket (ORC-206): its size and risk, whether it is complete enough to start, and whether it
 * speaks of a screen. `missing` are the questions a human must answer before the run starts: required when not complete.
 * Its three checks (ORC-207), each absent when it found nothing: `duplicates`, the work in progress elsewhere that does the
 * same (a PR, a branch, a ticket, by its link); `reuse`, the existing code close to the request, leads for `build`; `scope`,
 * a refusal of a ticket out of scope, with the split it proposes, never created.
 */
export const intakeAssessmentSchema = z
  .object({
    size: z.enum(TICKET_SIZES),
    risk: z.enum(RISKS),
    complete: z.boolean(),
    missing: z.array(z.string().min(1)).max(3),
    screen: z.boolean(),
    duplicates: z.array(z.object({ url: finding, why: finding }).strict()).max(3).optional(),
    reuse: z.array(z.object({ path: finding, symbol: finding.optional(), why: finding }).strict()).max(10).optional(),
    scope: z.object({ refuse: finding, split: z.array(z.object({ title: finding, summary: finding }).strict()).max(5).optional() }).strict().optional(),
  })
  .strict()
  .refine((a) => a.complete || a.missing.length > 0, { path: ['missing'], message: 'at least one question when the ticket is not complete' });

/** An entry of a list `submit_result` holds, and the list: capped as what the factory publishes of them (ORC-214). */
const item = z.string().max(OUTPUT_LIMITS.item);
const list = z.array(item).max(OUTPUT_LIMITS.items);

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
 * What the agent hands back through the factory MCP's `submit_result` (ORC-188): the engine never
 * reads free text. A blocked attempt says why: a question for a human, or a ticket it contests
 * (`spec_impossible`: contradictory spec, tests it cannot pass honestly) instead of cheating.
 */
export const agentOutputSchema = z
  .object({
    status: z.enum(['done', 'blocked']),
    /** Its texts capped as the `OutputPolicy` caps what the factory composes from them (ORC-214): refused here, the agent shortens them within its run. */
    summary: z.string().min(1).max(OUTPUT_LIMITS.summary),
    /** Required when blocked: the question (`needs_input`) or the justification (`spec_impossible`). */
    question: z.string().min(1).max(OUTPUT_LIMITS.field).optional(),
    /** `spec_impossible` contests the ticket; absent, a blocked attempt needs a human's answer. */
    reason: z.enum(['needs_input', 'spec_impossible']).optional(),
    tests_added: list,
    why: z.string().max(OUTPUT_LIMITS.field),
    assumptions: list,
    risks: list,
    untested: list,
    review_hints: z.array(z.object({ file: item.min(1), reason: item.min(1) }).strict()).max(OUTPUT_LIMITS.items),
    visual_scenario: z.object({ url: z.string().min(1), steps: z.array(z.string()) }).strict().optional(),
    /** The `intake` step's assessment (ORC-206); its guard reads nothing else. */
    intake: intakeAssessmentSchema.optional(),
  })
  .strict()
  .superRefine((o, ctx) => {
    if (o.status === 'blocked' && !o.question) ctx.addIssue({ code: 'custom', path: ['question'], message: 'required when status is blocked' });
    if (o.status === 'done' && o.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'only for a blocked status' });
    // Each field under its cap can still add up past a comment's: refused here, while the agent can shorten it (ORC-214).
    const published = formatResult(o).length;
    if (published > OUTPUT_LIMITS.text) ctx.addIssue({ code: 'custom', path: ['summary'], message: `summary, why, risks, untested and review_hints together make a comment of ${published} characters, more than ${OUTPUT_LIMITS.text}: shorten them` });
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
