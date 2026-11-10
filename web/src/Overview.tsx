import { formatDuration, formatTokens, percent, plural } from './Flow.js';
import type { BaselineValueView, BaselineView, MissRateView, OverviewView, ReworkCause } from './types.js';

/** The measures of the MVP doc that nothing in the factory feeds yet, and the ticket that brings each (ORC-223). */
export const NO_SOURCE = [
  { label: 'Minutes of human review', ticket: 'ORC-190', why: 'the review loop knows how long a PR waited for a human, not how long one read it: to be decided' },
] as const;

/** Why a merged ticket was not ready at the first try, in the dashboard's words (`Rework` of src/core/measures.ts). */
export const REWORK_LABELS: Record<ReworkCause, string> = {
  'pr.checks_failed': 'CI checks failed',
  'verify.failed': 'factory checks failed',
  'push.human': 'a human pushed',
  feedback: 'a human replied',
  sent_back: 'sent back to dev',
  changes_requested: 'changes requested',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const orDash = (v: number | null, format: (n: number) => string) => (v === null ? '—' : format(v));
const without = (leftOut: number) => (leftOut ? `${leftOut} merged without` : '');
const join = (...parts: string[]) => parts.filter(Boolean).join(' · ');
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A figure of the overview; a headline one faces the 90-day baseline, `baseline` and what it is over in `baselineDetail`. */
export interface Tile {
  label: string;
  value: string;
  detail?: string;
  headline?: true;
  baseline?: string;
  baselineDetail?: string;
}

/**
 * A headline figure's baseline (ORC-230): the measure's row, as `show` gives it; `no baseline` when the baseline has no row
 * for it, or there is none; `no source` for what human work cannot measure, never an invented value.
 */
function facing(b: BaselineView | null, measure: keyof BaselineView['measures'], show: (v: BaselineValueView) => { baseline: string; baselineDetail?: string }): Pick<Tile, 'baseline' | 'baselineDetail'> {
  const v = b?.measures[measure];
  if (!v) return { baseline: 'no baseline' };
  return v.noSource ? { baseline: 'no source', baselineDetail: 'human work' } : show(v);
}

/**
 * The AI reviewers' miss rate (ORC-229): no figure at all while no definition of a serious defect is set, only why; then the
 * share of the defects found in human review that no AI finding saw, over those entered under the definition.
 */
function missRateTile(m: MissRateView): Tile {
  const label = 'AI reviewers’ miss rate';
  if (!m.counted) return { label, value: 'not counted', detail: m.why };
  return {
    label,
    value: orDash(m.rate, percent),
    detail: join(`${m.missed} of ${plural(m.defects, 'defect')} found in human review without an AI finding`, m.leftOut ? `${m.leftOut} entered under another definition or none` : ''),
  };
}

/** The figures of the overview: the four headline ones face the baseline, then the human messages and the quality signals. */
export function overviewTiles(o: OverviewView): Tile[] {
  const verdicts = o.red.verified + o.red.wouldHaveBlocked;
  const reworks = o.firstTry.reworks.map((r) => `${REWORK_LABELS[r.cause]}: ${r.tickets}`).join(', ');
  const b = o.baseline;
  return [
    {
      label: 'Delivered', value: String(o.delivered), detail: 'tickets merged', headline: true,
      ...facing(b, 'delivered', (v) => ({ baseline: orDash(v.value, String), baselineDetail: `of ${plural(v.over, 'issue')} completed` })),
    },
    {
      label: 'Median lead time', value: orDash(o.medianLeadTimeMs, formatDuration), detail: 'delegation (or first attempt) to merge', headline: true,
      ...facing(b, 'lead_time', (v) => ({ baseline: orDash(v.value, formatDuration), ...(v.leftOut ? { baselineDetail: `${v.leftOut} delivered without a start` } : {}) })),
    },
    {
      label: 'Tokens per merged ticket',
      value: orDash(o.tokensPerMerged.mean, (n) => formatTokens(Math.round(n))),
      detail: join(
        without(o.tokensPerMerged.leftOut),
        o.usageLimitShare.mean === null ? '' : `code runs used ${percent(o.usageLimitShare.mean)} of the ticket budget${o.usageLimitShare.leftOut ? ` (${o.usageLimitShare.leftOut} without a share)` : ''}`,
      ),
      headline: true,
      ...facing(b, 'tokens_per_merged', (v) => ({ baseline: orDash(v.value, (n) => formatTokens(Math.round(n))) })),
    },
    {
      label: 'Ready at the first try',
      value: o.firstTry.of ? percent(o.firstTry.yes / o.firstTry.of) : '—',
      detail: join(o.firstTry.of ? `${o.firstTry.yes} of ${o.firstTry.of}` : '', reworks),
      headline: true,
      ...facing(b, 'first_try', (v) => ({ baseline: orDash(v.value, percent), baselineDetail: plural(v.over, 'merged PR') })),
    },
    { label: 'Median first sign of life', value: orDash(o.messages.medianSignOfLifeMs, formatDuration), detail: join(plural(o.messages.count, 'human message'), o.messages.withoutSignOfLife ? `${o.messages.withoutSignOfLife} without` : '') },
    { label: 'Median answer', value: orDash(o.messages.medianAnswerMs, formatDuration), detail: join(`over ${plural(o.messages.questions, 'question')} or command${o.messages.questions === 1 ? '' : 's'}`, o.messages.unanswered ? `${o.messages.unanswered} unanswered` : '') },
    { label: 'Reverted within 14 days', value: o.reverted.known ? `${o.reverted.yes} of ${o.reverted.known}` : '—', detail: 'merged tickets where it is known' },
    { label: 'CI per merged ticket', value: orDash(o.ciPerMerged.mean, formatDuration), detail: without(o.ciPerMerged.leftOut) },
    { label: 'Red check', value: verdicts ? `${o.red.verified} verified` : '—', detail: verdicts ? `would have blocked ${o.red.wouldHaveBlocked}` : 'no verdict' },
    ...(o.aiReviewMisses ? [missRateTile(o.aiReviewMisses)] : []),
  ];
}

/** The reduced overview (ORC-299): computed by the factory from its journal and run records, facing the baseline `factory baseline` froze (ORC-230). */
export function Overview({ overview: o }: { overview: OverviewView }) {
  const tiles = overviewTiles(o);
  const b = o.baseline;
  return (
    <div className="measures">
      <section>
        <h2>Overview · Last {Math.round((o.until - o.since) / DAY_MS)} days</h2>
        <table>
          <thead>
            <tr><th>Measure</th><th className="num">Value</th><th className="num">{`Baseline (${b ? `${day(b.since)} → ${day(b.until)}` : '90 days'})`}</th><th></th></tr>
          </thead>
          <tbody>
            {tiles.map((t) => (
              <tr key={t.label}>
                <td>{t.label}</td>
                <td className="num">{t.value}</td>
                <td className="num">{t.baseline}</td>
                <td className="note">{join(t.detail ?? '', t.baselineDetail ? `baseline: ${t.baselineDetail}` : '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note">
          Over the tickets merged and the human messages received in the period. Computed by the factory from its journal and run records, never from what an agent wrote.
          {o.unmeasured > 0 && ` Left out: ${plural(o.unmeasured, 'ticket')} whose measures could not be read.`}
          {b
            ? ` The baseline was computed for ${b.projectId} from Linear and GitHub on ${day(b.computedAt)}, over the days before the factory started: issues completed with a merged PR, never the factory's own work.`
            : ' No baseline yet: `factory baseline <project> --since <start date>` computes it from Linear and GitHub.'}
        </p>
      </section>
      <section>
        <h2>No source yet</h2>
        <ul className="no-source">
          {NO_SOURCE.map((n) => <li key={n.ticket}><strong>{n.label}</strong>: {n.why} ({n.ticket}).</li>)}
        </ul>
      </section>
    </div>
  );
}
