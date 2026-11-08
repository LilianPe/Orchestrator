import { z } from 'zod';
import { OUTPUT_LIMITS } from '../publish/output-limits.js';

/**
 * The spec `spec_draft` hands back (ORC-212), in the `spec` field of `submit_result`. Every section is optional to the
 * schema: whether one is missing is `spec_check`'s verdict, the factory's, not a refusal of the agent's result. The
 * sizes are capped as what the factory publishes (ORC-214), so the spec it posts in the session fits a message.
 */
const item = z.string().max(OUTPUT_LIMITS.item);
const list = z.array(item).max(OUTPUT_LIMITS.items);

export const specSchema = z
  .object({
    goal: z.string().max(OUTPUT_LIMITS.field).optional(),
    out_of_scope: list.optional(),
    /** The acceptance criteria, each a testable example (« Given …, when …, then … »): they become the frozen tests. */
    criteria: list.optional(),
    /** « For any input » properties, optional (ORC-261 freezes them): each needs its statement, input domain and target. */
    properties: z.array(z.object({ statement: item.optional(), domain: item.optional(), target: item.optional() }).strict()).max(OUTPUT_LIMITS.items).optional(),
    files: list.optional(),
    architecture: z.string().max(OUTPUT_LIMITS.field).optional(),
    risks: list.optional(),
    /** « Assumed without verification »: libraries, external services, behaviors taken as correct. Present even empty. */
    assumed: list.optional(),
    /** The `clarify` answers the spec applies (ORC-210), each question as it was asked. */
    decisions: z.array(z.object({ question: item, answer: item }).strict()).max(OUTPUT_LIMITS.items).optional(),
  })
  .strict();

export type Spec = z.infer<typeof specSchema>;

/** A version of the ticket's spec (ORC-212): published for review, approved once by a designated validator. */
export interface SpecVersion {
  /** The job that drafted it, which a `/changes` relaunches. */
  job: string;
  version: number;
  spec: Spec;
  /** When it was published. */
  at: number;
  /** Absent while it waits for review: a new version always starts without one. */
  approval?: { author: string; authorId?: string; at: number };
  /** A `/changes` asked for the next version, not published yet: nothing is approved meanwhile, a start in the queue included. */
  drafting?: true;
}

/** The commands of the spec gate, the factory's own, read in a reply of the ticket's session (ORC-212). */
export const APPROVE = '/approve';
export const CHANGES = '/changes';
export const REJECT = '/reject';
export const SPEC_COMMANDS: readonly string[] = [APPROVE, CHANGES, REJECT];

/** The sections `spec_check` requires, by their key, as the agent and the published spec name them. */
const SECTIONS = ['goal', 'out_of_scope', 'criteria', 'files', 'architecture', 'risks', 'assumed'] as const;

/**
 * `spec_check` (ORC-212), deterministic: every section present (an empty list is present), at least one acceptance
 * criterion and none empty, each property with its statement, domain and target, and each `clarify` decision of the
 * ticket carried by the spec with its answer as the human gave it. The problems found, in the order a reader fixes them; none when the spec passes.
 */
export function specCheck(spec: Spec | undefined, decisions: readonly { question: string; answer: string }[] = []): string[] {
  if (!spec) return ['No `spec` in the result.'];
  const missing = (v: string | readonly string[] | undefined) => v === undefined || (typeof v === 'string' && !v.trim());
  const problems = SECTIONS.filter((s) => missing(spec[s])).map((s) => `Section \`${s}\` is missing.`);
  if (spec.criteria?.length === 0) problems.push('No acceptance criterion: at least one is required.');
  spec.criteria?.forEach((c, i) => {
    if (!c.trim()) problems.push(`Criterion ${i + 1} is empty.`);
  });
  (spec.properties ?? []).forEach((p, i) => {
    const gaps = (['statement', 'domain', 'target'] as const).filter((k) => !p[k]?.trim());
    if (gaps.length) problems.push(`Property ${i + 1} has no ${gaps.join(', ')}.`);
  });
  for (const d of decisions) {
    const carried = spec.decisions?.find((c) => c.question === d.question);
    if (!carried) problems.push(`The decision « ${d.question} » is not in \`decisions\`.`);
    else if (carried.answer !== d.answer) problems.push(`The decision « ${d.question} » was answered « ${d.answer} », not « ${carried.answer} ».`);
  }
  return problems;
}

/** The spec as the session shows it and as later steps read it: the sections in a fixed order, empty ones said so. */
export function formatSpec(spec: Spec): string {
  const bullets = (items: readonly string[] | undefined) => (items?.length ? items.map((i) => `- ${i}`).join('\n') : '- (none)');
  return [
    `**Goal**\n${spec.goal ?? ''}`,
    `**Out of scope**\n${bullets(spec.out_of_scope)}`,
    `**Acceptance criteria**\n${(spec.criteria ?? []).map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
    ...(spec.properties?.length ? [`**Properties (for any input)**\n${bullets(spec.properties.map((p) => `${p.statement} (inputs: ${p.domain}; target: ${p.target})`))}`] : []),
    ...(spec.decisions?.length ? [`**Decisions**\n${bullets(spec.decisions.map((d) => `${d.question} → ${d.answer}`))}`] : []),
    `**Files**\n${bullets(spec.files)}`,
    `**Architecture impact**\n${spec.architecture ?? ''}`,
    `**Risks**\n${bullets(spec.risks)}`,
    `**Assumed without verification**\n${bullets(spec.assumed)}`,
  ].join('\n\n');
}

/** What the published message adds around the spec (its head and the commands), kept out of the spec's own cap. */
export const SPEC_FRAME = 600;
