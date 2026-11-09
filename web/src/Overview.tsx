import { formatDuration, formatTokens, plural } from './Flow.js';
import type { OverviewView, ReworkCause } from './types.js';

/** The measures of the MVP doc that nothing in the factory feeds yet, and the ticket that brings each (ORC-223). */
export const NO_SOURCE = [
  { label: 'Minutes of human review', ticket: 'ORC-190', why: 'a review says when it was posted, not when it began' },
  { label: 'Baseline over 90 days', ticket: 'ORC-230', why: 'nothing to compare the overview with yet' },
] as const;

/** Why a merged ticket was not ready at the first try, in the dashboard's words (`Rework` of src/core/measures.ts). */
const REWORK_LABELS: Record<ReworkCause, string> = {
  'pr.checks_failed': 'CI checks failed',
  'verify.failed': 'factory checks failed',
  'push.human': 'a human pushed',
  feedback: 'a human replied',
  sent_back: 'sent back to dev',
  changes_requested: 'changes requested',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const orDash = (v: number | null, format: (n: number) => string) => (v === null ? '—' : format(v));
const percent = (share: number) => `${Math.round(share * 100)} %`;
const without = (leftOut: number) => (leftOut ? `${leftOut} merged without` : '');
const join = (...parts: string[]) => parts.filter(Boolean).join(' · ');

/** A figure of the overview; `baseline` on the headline ones only, null while ORC-230 computes none. */
export interface Tile {
  label: string;
  value: string;
  detail?: string;
  baseline?: null;
}

/** The figures of the overview: the four headline ones face the baseline, then the human messages and the quality signals. */
export function overviewTiles(o: OverviewView): Tile[] {
  const reworks = o.firstTry.reworks.map((r) => `${REWORK_LABELS[r.cause]}: ${r.tickets}`).join(', ');
  return [
    { label: 'Delivered', value: String(o.delivered), detail: 'tickets merged', baseline: o.baseline },
    { label: 'Median lead time', value: orDash(o.medianLeadTimeMs, formatDuration), detail: 'delegation (or first attempt) to merge', baseline: o.baseline },
    {
      label: 'Tokens per merged ticket',
      value: orDash(o.tokensPerMerged.mean, (n) => formatTokens(Math.round(n))),
      detail: join(
        without(o.tokensPerMerged.leftOut),
        o.usageLimitShare.mean === null ? '' : `code runs used ${percent(o.usageLimitShare.mean)} of the ticket budget${o.usageLimitShare.leftOut ? ` (${o.usageLimitShare.leftOut} without a share)` : ''}`,
      ),
      baseline: o.baseline,
    },
    {
      label: 'Ready at the first try',
      value: o.firstTry.of ? percent(o.firstTry.yes / o.firstTry.of) : '—',
      detail: join(o.firstTry.of ? `${o.firstTry.yes} of ${o.firstTry.of}` : '', reworks),
      baseline: o.baseline,
    },
    { label: 'Median first sign of life', value: orDash(o.messages.medianSignOfLifeMs, formatDuration), detail: join(plural(o.messages.count, 'human message'), o.messages.withoutSignOfLife ? `${o.messages.withoutSignOfLife} without` : '') },
    { label: 'Median answer', value: orDash(o.messages.medianAnswerMs, formatDuration), detail: join(`over ${plural(o.messages.questions, 'question')} or command${o.messages.questions === 1 ? '' : 's'}`, o.messages.unanswered ? `${o.messages.unanswered} unanswered` : '') },
    { label: 'Reverted within 14 days', value: o.reverted.known ? `${o.reverted.yes} of ${o.reverted.known}` : '—', detail: 'merged tickets where it is known' },
    { label: 'CI per merged ticket', value: orDash(o.ciPerMerged.meanMs, formatDuration), detail: without(o.ciPerMerged.leftOut) },
    { label: 'Red check', value: o.red.verified + o.red.wouldHaveBlocked ? `${o.red.verified} verified` : '—', detail: o.red.verified + o.red.wouldHaveBlocked ? `would have blocked ${o.red.wouldHaveBlocked}` : 'no verdict' },
  ];
}

/** The reduced overview (ORC-299): computed by the factory from its journal and run records, compared with the baseline once ORC-230 brings one. */
export function Overview({ overview: o }: { overview: OverviewView }) {
  const tiles = overviewTiles(o);
  return (
    <div className="measures">
      <section>
        <h2>Overview · Last {Math.round((o.until - o.since) / DAY_MS)} days</h2>
        <table>
          <thead>
            <tr><th>Measure</th><th className="num">Value</th><th className="num">Baseline (90 days)</th><th></th></tr>
          </thead>
          <tbody>
            {tiles.map((t) => (
              <tr key={t.label}>
                <td>{t.label}</td>
                <td className="num">{t.value}</td>
                <td className="num" title={t.baseline === null ? 'No baseline before ORC-230.' : undefined}>{t.baseline === null ? '— (ORC-230)' : ''}</td>
                <td className="note">{t.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note">
          Over the tickets merged and the human messages received in the period. Computed by the factory from its journal and run records, never from what an agent wrote.
          {o.unmeasured > 0 && ` Left out: ${plural(o.unmeasured, 'ticket')} whose measures could not be read.`}
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
