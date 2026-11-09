/**
 * The state of reference over 90 days (ORC-230): what the team delivered without the factory, read from Linear and GitHub
 * over the 90 days before the factory started, for one project, and frozen in the store, one row per measure, for the
 * reduced overview (ORC-299) to face its measures with. Computed by `factory baseline`, never by the daemon.
 */
import { median } from './overview.js';

export const BASELINE_DAYS = 90;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The measures of the overview the baseline faces, in the order the overview shows them. */
export const BASELINE_MEASURES = ['delivered', 'lead_time', 'tokens_per_merged', 'first_try'] as const;
export type BaselineMeasure = (typeof BASELINE_MEASURES)[number];

/** An issue of the project's team completed in the period, as Linear reads it: `startedAt`, null when it never went through a started state; `links`, the URLs attached to it. */
export interface CompletedIssue {
  identifier: string;
  startedAt: number | null;
  completedAt: number;
  links: string[];
}

/** A PR of the project's repository merged in the period, as GitHub reads it: `changesRequested`, a review asked changes of it. */
export interface MergedPr {
  url: string;
  title: string;
  branch: string;
  mergedAt: number;
  changesRequested: boolean;
}

/**
 * What one measure of a baseline says. `value`: null when there is nothing to compute it over, or no source (`noSource`):
 * never a zero that reads as a measure. `over`: how many it is computed over (issues completed for `delivered`, delivered
 * issues with a start for `lead_time`, their merged PRs for `first_try`); `leftOut`: how many it leaves out.
 */
export interface BaselineValue {
  value: number | null;
  over: number;
  leftOut: number;
  noSource: boolean;
}

/**
 * A project's baseline over `[since, until)`, computed at `computedAt`: what the store freezes, one row per measure, and what
 * the overview serves. A measure without a row has no baseline.
 */
export interface Baseline {
  projectId: string;
  since: number;
  until: number;
  computedAt: number;
  measures: Partial<Record<BaselineMeasure, BaselineValue>>;
}

/** The 90 days before `start`, `start` left out. */
export function baselinePeriod(start: number): { since: number; until: number } {
  return { since: start - BASELINE_DAYS * DAY_MS, until: start };
}

/** Whether a PR is the issue's: Linear links it to the issue, or its branch or its title names the issue as a whole (`ORC-3`, not `orc-30`). */
function prsOf(issue: CompletedIssue): (pr: MergedPr) => boolean {
  const named = new RegExp(`(^|[^a-z0-9])${issue.identifier.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^0-9])`);
  return (pr) => issue.links.includes(pr.url) || named.test(pr.branch.toLowerCase()) || named.test(pr.title.toLowerCase());
}

/**
 * A project's baseline over the period. Delivered: the issues completed in it that have a PR merged in it. Lead time: the
 * median, over the delivered issues, from the issue's start to its first merged PR; an issue never started, or started
 * after it, is left out. First try: the share of the delivered issues' merged PRs no review asked changes of. Tokens per
 * merged ticket: human work spends none the factory can read, so no value, said as no source. The period is applied here,
 * whatever the sources read around it. Pure.
 */
export function computeBaseline(projectId: string, period: { since: number; until: number }, issues: readonly CompletedIssue[], prs: readonly MergedPr[], computedAt: number): Baseline {
  const within = (at: number) => at >= period.since && at < period.until;
  const completed = issues.filter((i) => within(i.completedAt));
  const merged = prs.filter((p) => within(p.mergedAt));
  const delivered = completed.flatMap((issue) => {
    const own = merged.filter(prsOf(issue));
    return own.length ? [{ issue, prs: own }] : [];
  });
  const leadTimes = delivered.flatMap(({ issue, prs: own }) => {
    const firstMerge = Math.min(...own.map((p) => p.mergedAt));
    return issue.startedAt === null || issue.startedAt > firstMerge ? [] : [firstMerge - issue.startedAt];
  });
  const deliveredPrs = [...new Set(delivered.flatMap((d) => d.prs))];
  const firstTry = deliveredPrs.filter((p) => !p.changesRequested).length;
  return {
    projectId,
    ...period,
    computedAt,
    measures: {
      delivered: { value: delivered.length, over: completed.length, leftOut: completed.length - delivered.length, noSource: false },
      lead_time: { value: median(leadTimes), over: leadTimes.length, leftOut: delivered.length - leadTimes.length, noSource: false },
      tokens_per_merged: { value: null, over: 0, leftOut: delivered.length, noSource: true },
      first_try: { value: deliveredPrs.length ? firstTry / deliveredPrs.length : null, over: deliveredPrs.length, leftOut: 0, noSource: false },
    },
  };
}
