import { z } from 'zod';
import { describePr, FACTS_ROOM, formatRecap } from '../publish/describe.js';
import { OUTPUT_LIMITS } from '../publish/output-limits.js';
import type { Store } from '../store/types.js';
import { formatSpec, item, list, SPEC_FRAME, specSchema } from './spec.js';
import { RISKS, TICKET_SIZES, type RunOutcome } from './types.js';

/** A question `clarify` asks (ORC-210): its options are the hypotheses the agent sees, a free answer always possible. */
export const clarifyQuestionSchema = z.object({ question: z.string().min(1), options: z.array(z.string().min(1)).min(2).max(5) }).strict();

/**
 * What `intake` makes of the ticket (ORC-206): its size and risk, whether it is complete enough to start, and whether it
 * speaks of a screen. `missing` are the questions a human must answer before the run starts: required when not complete.
 * Each is a question with its options (ORC-210), or a bare one when the agent sees none, answered freely.
 */
export const intakeAssessmentSchema = z
  .object({
    size: z.enum(TICKET_SIZES),
    risk: z.enum(RISKS),
    complete: z.boolean(),
    missing: z.array(z.union([z.string().min(1), clarifyQuestionSchema])).max(3),
    screen: z.boolean(),
  })
  .strict()
  .refine((a) => a.complete || a.missing.length > 0, { path: ['missing'], message: 'at least one question when the ticket is not complete' });

/** How a review lens weighs a finding (ORC-183): only a `blocking` one fails `factory/review`. */
export const FINDING_SEVERITIES = ['blocking', 'minor', 'out_of_scope'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * A finding of a review lens (ORC-183), on a line of the commit it read. `fact`: the id of the Claim Ledger fact it violates,
 * once the reviewers get the facts of the diff's paths as a checklist (ORC-254), to measure their misses (ORC-229).
 */
export const findingSchema = z
  .object({
    file: item.min(1),
    line: z.number().int().positive(),
    severity: z.enum(FINDING_SEVERITIES),
    explanation: z.string().min(1).max(OUTPUT_LIMITS.field),
    suggestion: z.string().max(OUTPUT_LIMITS.field),
    fact: item.min(1).optional(),
  })
  .strict();

export type Finding = z.infer<typeof findingSchema>;

/** A commit the agent names: a short or full sha. */
const commitSha = z.string().regex(/^[0-9a-f]{7,40}$/, 'a commit sha (7 to 40 hex characters)');

/**
 * What the fix of the review loop did with each blocking finding it was given (ORC-184), by its id in the input
 * (`correctness-1`): fixed by its own commit, or contested with a justification, the finding then staying open for the next review.
 */
const fixedSchema = z.array(z.object({ finding: item.min(1), commit: commitSha }).strict()).max(OUTPUT_LIMITS.findings);
const contestedSchema = z.array(z.object({ finding: item.min(1), justification: z.string().min(1).max(OUTPUT_LIMITS.field) }).strict()).max(OUTPUT_LIMITS.findings);

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
    /** « Trusted without verification » (ORC-195): libraries, external services and behaviours taken as correct, the approved spec's section carried to the PR. Optional: results older than it lack it. */
    trusted: list.optional(),
    review_hints: z.array(z.object({ file: item.min(1), reason: item.min(1) }).strict()).max(OUTPUT_LIMITS.items),
    visual_scenario: z.object({ url: z.string().min(1), steps: z.array(z.string()) }).strict().optional(),
    /** The `intake` step's assessment (ORC-206); its guard reads nothing else. */
    intake: intakeAssessmentSchema.optional(),
    /** The `spec_draft` step's spec (ORC-212): `spec_check` judges it, the factory publishes it. */
    spec: specSchema.optional(),
    /** A review lens's findings (ORC-183), an empty list when it found nothing: the factory publishes them, never its summary alone. */
    findings: z.array(findingSchema).max(OUTPUT_LIMITS.findings).optional(),
    /** The fix of the review loop (ORC-184): each finding fixed, with the one commit that fixes it. */
    fixed: fixedSchema.optional(),
    /** The fix of the review loop (ORC-184): each finding contested, with why; it stays open for the next review. */
    contested: contestedSchema.optional(),
  })
  .strict()
  .superRefine((o, ctx) => {
    if (o.status === 'blocked' && !o.question) ctx.addIssue({ code: 'custom', path: ['question'], message: 'required when status is blocked' });
    if (o.status === 'done' && o.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'only for a blocked status' });
    if ((o.reason === 'conflict') !== !!o.conflict) ctx.addIssue({ code: 'custom', path: ['conflict'], message: 'required with reason conflict, and only with it' });
    // One commit per finding fixed (ORC-184): two findings in one commit, or one finding both fixed and contested, are refused.
    const commits = (o.fixed ?? []).map((f) => f.commit);
    if (commits.some((c, i) => commits.findIndex((d) => d.startsWith(c) || c.startsWith(d)) !== i)) ctx.addIssue({ code: 'custom', path: ['fixed'], message: 'one commit per finding: each fixed finding names its own commit' });
    const ids = [...(o.fixed ?? []), ...(o.contested ?? [])].map((f) => f.finding);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['contested'], message: 'each finding once, fixed or contested' });
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
 * Fields each under their cap can still add up past what the factory publishes of them (ORC-214, ORC-195): the recap past a
 * comment's cap, the PR description past a body's less `FACTS_ROOM`, the room the factory's own facts take, the spec past its
 * message's less `SPEC_FRAME` (ORC-212). Checked when the agent
 * submits, so it shortens them within its run; never on a stored result, which was valid when it was written.
 */
function publishedSizeIssues(o: AgentOutput): string[] {
  const issues: string[] = [];
  const recap = formatRecap(o, []).length;
  if (recap > OUTPUT_LIMITS.text) issues.push(`summary: summary, why, risks, untested, review_hints and tests_added together make a recap of ${recap} characters, more than ${OUTPUT_LIMITS.text}: shorten them`);
  const pr = describePr(o, { ticketId: '', title: '', sha: '' }).body.length;
  const room = OUTPUT_LIMITS.text - FACTS_ROOM;
  if (pr > room) issues.push(`summary: the fields together make a PR description of ${pr} characters, more than ${room}: shorten them`);
  const spec = o.spec && formatSpec(o.spec).length;
  if (spec && spec > OUTPUT_LIMITS.text - SPEC_FRAME) issues.push(`spec: the spec makes a message of ${spec} characters, more than ${OUTPUT_LIMITS.text - SPEC_FRAME}: shorten it`);
  return issues;
}

/** What `submit_result` takes: a valid output whose published texts stay under their caps. */
export function parseSubmittedResult(raw: unknown): ReturnType<typeof parseAgentOutput> {
  const parsed = parseAgentOutput(raw);
  if (!parsed.ok) return parsed;
  const issues = publishedSizeIssues(parsed.output);
  return issues.length ? { ok: false, error: issues.join('; ') } : parsed;
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
