/**
 * The state of reference over 90 days (ORC-230): what the team delivered without the factory, read from Linear and GitHub
 * over the 90 days before the factory started, for one project, and frozen in the store, one row per measure, for the
 * reduced overview (ORC-299) to face its measures with. Computed by `factory baseline`, never by the daemon.
 */
import { median } from './overview.js';

export const BASELINE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  number: number;
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

/** A frozen row of the store: one measure of a project's baseline over `[since, until)`, and when it was computed. */
export interface BaselineRow extends BaselineValue {
  projectId: string;
  measure: BaselineMeasure;
  since: number;
  until: number;
  computedAt: number;
}

/** A baseline as the overview serves it: its rows by measure; a measure without a row has no baseline. */
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

/** `ORC-3` in a branch or a title, as a whole: not in `orc-30`. */
const names = (identifier: string, text: string) =>
  new RegExp(`(^|[^a-z0-9])${identifier.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^0-9])`).test(text.toLowerCase());

/** A PR is the issue's when Linear links it to the issue, or when its branch or its title names the issue. */
const isOf = (issue: CompletedIssue, pr: MergedPr) => issue.links.includes(pr.url) || names(issue.identifier, pr.branch) || names(issue.identifier, pr.title);

/**
 * The rows of a project's baseline over the period. Delivered: the issues completed in it that have a PR merged in it. Lead
 * time: the median, over the delivered issues, from the issue's start to its first merged PR; an issue never started, or
 * started after it, is left out. First try: the share of the delivered issues' merged PRs no review asked changes of.
 * Tokens per merged ticket: human work spends none the factory can read, so no value, said as no source. Pure.
 */
export function baselineRows(projectId: string, period: { since: number; until: number }, issues: readonly CompletedIssue[], prs: readonly MergedPr[], computedAt: number): BaselineRow[] {
  const within = (at: number) => at >= period.since && at < period.until;
  const completed = issues.filter((i) => within(i.completedAt));
  const merged = prs.filter((p) => within(p.mergedAt));
  const delivered = completed.flatMap((issue) => {
    const own = merged.filter((p) => isOf(issue, p));
    return own.length ? [{ issue, prs: own }] : [];
  });
  const leadTimes = delivered.flatMap(({ issue, prs: own }) => {
    const firstMerge = Math.min(...own.map((p) => p.mergedAt));
    return issue.startedAt === null || issue.startedAt > firstMerge ? [] : [firstMerge - issue.startedAt];
  });
  const deliveredPrs = [...new Set(delivered.flatMap((d) => d.prs))];
  const firstTry = deliveredPrs.filter((p) => !p.changesRequested).length;
  const values: Record<BaselineMeasure, BaselineValue> = {
    delivered: { value: delivered.length, over: completed.length, leftOut: completed.length - delivered.length, noSource: false },
    lead_time: { value: median(leadTimes), over: leadTimes.length, leftOut: delivered.length - leadTimes.length, noSource: false },
    tokens_per_merged: { value: null, over: 0, leftOut: delivered.length, noSource: true },
    first_try: { value: deliveredPrs.length ? firstTry / deliveredPrs.length : null, over: deliveredPrs.length, leftOut: 0, noSource: false },
  };
  return BASELINE_MEASURES.map((measure) => ({ projectId, measure, ...period, ...values[measure], computedAt }));
}

/** The rows of one baseline, gathered by measure; null without rows. */
export function baselineOf(rows: readonly BaselineRow[]): Baseline | null {
  const first = rows[0];
  if (!first) return null;
  const measures: Baseline['measures'] = {};
  for (const { measure, value, over, leftOut, noSource } of rows) measures[measure] = { value, over, leftOut, noSource };
  return { projectId: first.projectId, since: first.since, until: first.until, computedAt: first.computedAt, measures };
}
