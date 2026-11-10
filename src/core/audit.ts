import type { MeasureFacts } from '../store/types.js';
import { handedToHuman, mergeTime, ticketMeasures, type Rework, type RunMeasure } from './measures.js';
import type { ReviewFinding } from './review.js';
import { checkOf, humanReviewOf, stepCosts, type CheckVerdict, type HumanReview, type StepCost } from './run-detail.js';
import { NO_DEFINITION, type MissRate } from './serious-defect.js';
import type { Spec } from './spec.js';
import type { FactoryEvent } from './types.js';
import { upcast, type StoredEvent } from './upcast.js';

/**
 * A finding of an AI review lens as the `findings` table keeps it (ORC-183): `id`, its row's (`<run>:<lens>:<n>`), what a
 * human defect links to; `sha`, the commit the lens read; `at`, when it was kept.
 */
export type KeptFinding = ReviewFinding & { id: string; sha: string; at: number };

/**
 * A defect a human found in reviewing a PR of the factory (ORC-229), entered from the dashboard: linked to the AI finding that
 * saw it (`findingId`), or not, which makes it a miss of the AI reviewers. `definition`: the definition of a serious defect in
 * force when it was entered (`audit.serious_defect` of factory.yml), null without one; only the defects entered under the
 * definition in force are counted. `enteredBy`: the operator who entered it, as the dashboard names them.
 */
export interface ReviewDefect {
  id: string;
  projectId: string;
  ticketId: string;
  prNumber: number;
  description: string;
  findingId: string | null;
  file?: string;
  line?: number;
  definition: string | null;
  enteredBy: string;
  at: number;
}

/** A PR of the ticket and where it ended. */
export interface AuditPr {
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed';
  mergedAt: number | null;
}

/**
 * The audit sheet of a PR the factory made (ORC-229), for its human reviewer: the task (the ticket, the last spec handed
 * back), the agent's path (its steps and attempts, the factory's checks, the findings of the AI lenses from the `findings`
 * table), the result (its PRs, the human reviews, merged at the first try or with what rework, reverted within 14 days).
 * Read from the journal, the attempts and the `findings` table, never from what an agent said of its work; the defects the
 * humans entered beside.
 */
export interface AuditSheet {
  projectId: string;
  ticketId: string;
  task: { title: string; spec: Spec | null };
  path: { steps: StepCost[]; attempts: RunMeasure[]; checks: CheckVerdict[]; findings: KeptFinding[] };
  result: {
    prs: AuditPr[];
    reviews: HumanReview[];
    firstTry: boolean | null;
    reworks: Rework[];
    revertedWithin14Days: boolean | null;
  };
  defects: ReviewDefect[];
}

export { NO_DEFINITION, type MissRate };

/** The PRs of the journal, in the order they were opened, each with where it ended, a merge timed by GitHub when it says. */
export function prsOf(events: readonly FactoryEvent[]): AuditPr[] {
  const prs = new Map<number, AuditPr>();
  for (const e of events) {
    if (e.type !== 'pr.opened' && e.type !== 'pr.merged' && e.type !== 'pr.closed') continue;
    const pr = prs.get(e.payload.number) ?? { number: e.payload.number, url: e.payload.url, state: 'open', mergedAt: null };
    if (pr.state !== 'merged') {
      // A reopening is journaled as `pr.opened` again: it takes the PR back from closed.
      if (e.type === 'pr.merged') Object.assign(pr, { state: 'merged', mergedAt: mergeTime(e) });
      else pr.state = e.type === 'pr.closed' ? 'closed' : 'open';
    }
    prs.set(pr.number, pr);
  }
  return [...prs.values()];
}

/** A PR a human reviewed: one reviewed on GitHub, or handed to Human Review by the factory. */
export function humanReviewed(facts: Pick<MeasureFacts, 'events' | 'effects'>): boolean {
  return facts.events.some((e) => e.type === 'pr.reviewed') || facts.effects.some(handedToHuman);
}

/** The audit sheet of a ticket from its facts, the findings kept of it and the defects entered (ORC-229). Pure. */
export function auditSheet(
  t: { projectId: string; ticketId: string; title: string },
  facts: MeasureFacts,
  findings: readonly KeptFinding[],
  defects: readonly ReviewDefect[],
): AuditSheet {
  const events = facts.events.map((e) => upcast(e as StoredEvent));
  const measures = ticketMeasures(t.projectId, t.ticketId, facts);
  const spec = events.findLast((e): e is FactoryEvent<'run.finished'> => e.type === 'run.finished' && e.payload.output?.spec !== undefined)?.payload.output?.spec ?? null;
  return {
    projectId: t.projectId,
    ticketId: t.ticketId,
    task: { title: t.title, spec },
    path: { steps: stepCosts(measures.runs), attempts: measures.runs, checks: events.flatMap((e) => checkOf(e) ?? []), findings: [...findings] },
    result: {
      prs: prsOf(events),
      reviews: events.flatMap((e) => (e.type === 'pr.reviewed' ? [humanReviewOf(e)] : [])),
      firstTry: measures.firstTry,
      reworks: measures.reworks,
      revertedWithin14Days: measures.revertedWithin14Days,
    },
    defects: [...defects],
  };
}

/** The miss rate over the defects entered in `[since, until)`, under `definition`; none counted without one (ORC-153). Pure. */
export function missRate(period: { since: number; until: number }, defects: readonly ReviewDefect[], definition: string | undefined): MissRate {
  if (definition === undefined) return { counted: false, why: NO_DEFINITION };
  const within = defects.filter((d) => d.at >= period.since && d.at < period.until);
  const counted = within.filter((d) => d.definition === definition);
  const missed = counted.filter((d) => d.findingId === null).length;
  return { counted: true, definition, defects: counted.length, missed, rate: counted.length ? missed / counted.length : null, leftOut: within.length - counted.length };
}
