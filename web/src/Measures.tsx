import { formatDuration, formatTokens, plural, PrLink, tokensCell, totalTokens } from './Flow.js';
import type { MeasuredTicketView, RunMeasureView, TicketMeasuresView } from './types.js';

/** The measures the MVP doc asks for that nothing in the factory feeds yet, and the ticket that brings each (ORC-223). */
export const NO_SOURCE = [
  { label: 'Share of the usage limit', ticket: 'ORC-216', why: 'no limit in tokens yet' },
  { label: 'Minutes of human review', ticket: 'ORC-190', why: 'a review says when it was posted, not when it began' },
  { label: 'Baseline over 90 days', ticket: 'ORC-230', why: 'nothing to compare the overview with yet' },
] as const;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** An attempt that ended its duration; one running its time so far; one cut without an end none. */
export function runDuration(run: RunMeasureView, now: number): string {
  if (run.durationMs !== null) return formatDuration(run.durationMs);
  return run.status === 'running' ? `${formatDuration(now - run.startedAt)}, running` : '—';
}

/** Delegation to merge once merged, the time so far before; nothing for a ticket finished without a merge. */
export function ticketDuration(m: TicketMeasuresView, now: number, logical?: string): { text: string; title: string } {
  if (m.leadTimeMs !== null) return { text: formatDuration(m.leadTimeMs), title: 'From the delegation (or the first attempt) to the merge.' };
  if (logical === 'done') return { text: '—', title: 'Done without a merge.' };
  if (m.startedAt !== null) return { text: `${formatDuration(now - m.startedAt)} so far`, title: 'Not merged: since the delegation (or the first attempt).' };
  return { text: '—', title: 'No delegation nor attempt yet.' };
}

export const reviewRoundsCell = (r: TicketMeasuresView['reviewRounds']): string => `${r.ai} AI · ${r.human} human`;

/** The ticket's tokens, as the Flow shows them; `?` when its measures could not be read. */
export const costCell = (m: TicketMeasuresView | null) =>
  tokensCell({ measured: m !== null, tokens: m?.tokens ?? null, attemptsWithoutTokens: m?.attemptsWithoutTokens ?? 0, costUsd: m?.costUsd ?? 0 });

export interface Overview {
  /** Merged tickets. */
  delivered: number;
  medianLeadTimeMs: number | null;
  /** Mean tokens of the merged tickets that reported some; `leftOut` merged tickets reported none. */
  tokensPerMerged: { mean: number | null; leftOut: number };
  /** Merged tickets ready at the first try, of the merged ones. */
  firstTry: { yes: number; of: number };
  /** Over the human messages of the tickets: the unanswered ones left out of the answer. */
  medianSignOfLifeMs: number | null;
  medianAnswerMs: number | null;
  /** Tickets whose measures could not be read: left out of all the above. */
  unmeasured: number;
}

/** The reduced overview of the tickets served (ORC-223): only what their measures say, never a zero for a missing one. */
export function overview(tickets: MeasuredTicketView[]): Overview {
  const measured = tickets.flatMap((t) => (t.measures ? [t.measures] : []));
  const merged = measured.filter((m) => m.mergedAt !== null);
  const withTokens = merged.flatMap((m) => (m.tokens ? [totalTokens(m.tokens)] : []));
  const messages = measured.flatMap((m) => m.messages);
  return {
    delivered: merged.length,
    medianLeadTimeMs: median(merged.flatMap((m) => (m.leadTimeMs === null ? [] : [m.leadTimeMs]))),
    tokensPerMerged: { mean: withTokens.length ? withTokens.reduce((a, b) => a + b, 0) / withTokens.length : null, leftOut: merged.length - withTokens.length },
    firstTry: { yes: merged.filter((m) => m.firstTry === true).length, of: merged.length },
    medianSignOfLifeMs: median(messages.flatMap((m) => (m.signOfLifeMs === null ? [] : [m.signOfLifeMs]))),
    medianAnswerMs: median(messages.flatMap((m) => (m.answerMs === null ? [] : [m.answerMs]))),
    unmeasured: tickets.length - measured.length,
  };
}

const orDash = (v: number | null, format: (n: number) => string) => (v === null ? '—' : format(v));
const key = (t: MeasuredTicketView) => `${t.projectId}/${t.ticketId}`;

function OverviewTiles({ o }: { o: Overview }) {
  const tiles = [
    ['Delivered', String(o.delivered)],
    ['Median lead time', orDash(o.medianLeadTimeMs, formatDuration)],
    ['Tokens per merged ticket', `${orDash(o.tokensPerMerged.mean, (n) => formatTokens(Math.round(n)))}${o.tokensPerMerged.leftOut ? ` (${o.tokensPerMerged.leftOut} without)` : ''}`],
    ['Ready at the first try', o.firstTry.of ? `${o.firstTry.yes} / ${o.firstTry.of}` : '—'],
    ['Median first sign of life', orDash(o.medianSignOfLifeMs, formatDuration)],
    ['Median answer', orDash(o.medianAnswerMs, formatDuration)],
  ];
  return (
    <dl className="tiles">
      {tiles.map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
      ))}
    </dl>
  );
}

function Attempts({ ticket, now }: { ticket: MeasuredTicketView; now: number }) {
  const m = ticket.measures;
  if (!m) return null;
  return (
    <section className="attempts">
      <h2>Attempts of {ticket.ticketId}</h2>
      {m.runs.length ? (
        <table>
          <thead>
            <tr><th>Step</th><th>Role</th><th>Status</th><th className="num">Duration</th><th className="num">Tokens</th><th className="num">Dollars</th><th className="num">Turns</th></tr>
          </thead>
          <tbody>
            {m.runs.map((r) => (
              <tr key={r.id}>
                <td className="step">{r.job}</td>
                <td>{r.role ?? '—'}</td>
                <td>{r.status}</td>
                <td className="num">{runDuration(r, now)}</td>
                <td className="num">{r.tokens ? formatTokens(totalTokens(r.tokens)) : '—'}</td>
                <td className="num">${r.costUsd.toFixed(2)}</td>
                <td className="num">{plural(r.turns, 'turn')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="empty">No attempt yet.</p>}
      <p className="note">
        First try: {m.firstTry === null ? 'not merged' : m.firstTry ? 'yes' : `no (${m.reworks.map((r) => r.cause).join(', ')})`}
        {' · '}CI: {m.ciCost ? `${formatDuration(m.ciCost.durationMs)} over ${plural(m.ciCost.runs, 'run')}` : 'no run journaled'}
        {' · '}Reverted within 14 days: {m.revertedWithin14Days === null ? 'unknown' : m.revertedWithin14Days ? 'yes' : 'no'}
      </p>
    </section>
  );
}

function MeasuredCells({ m, logical, now }: { m: TicketMeasuresView; logical: string; now: number }) {
  const duration = ticketDuration(m, now, logical);
  const cost = costCell(m);
  return (
    <>
      <td className="num" title={duration.title}>{duration.text}</td>
      <td className="num">{formatDuration(m.workMs)}</td>
      <td className="num" title={cost.title}>{cost.text}</td>
      <td className="num">{reviewRoundsCell(m.reviewRounds)}</td>
      <td className="num">{m.attempts}</td>
    </>
  );
}

/** The measures page (ORC-223): the overview, then each ticket's cost, duration and review rounds, then the attempts of the one selected. */
export function Measures({ tickets, now, selected, onSelect }: { tickets: MeasuredTicketView[]; now: number; selected?: string; onSelect: (key: string) => void }) {
  const open = tickets.find((t) => key(t) === selected);
  return (
    <div className="measures">
      <section>
        <h2>Overview</h2>
        <OverviewTiles o={overview(tickets)} />
        <p className="note">Over the {plural(tickets.length, 'ticket')} served, the most recently updated. Computed by the factory from its journal and run records, never from what an agent wrote.</p>
      </section>
      <section>
        <h2>Tickets</h2>
        {tickets.length ? (
          <table>
            <thead>
              <tr><th>Ticket</th><th>State</th><th className="num">Duration</th><th className="num">Work</th><th className="num">Tokens</th><th className="num">Review rounds</th><th className="num">Attempts</th></tr>
            </thead>
            <tbody>
              {tickets.map((t) => {
                const m = t.measures;
                return (
                  <tr key={key(t)} className={key(t) === selected ? 'selected' : ''}>
                    <td><button className="link" onClick={() => onSelect(key(t))}>{t.ticketId}</button> {t.title} <PrLink url={t.prUrl} /></td>
                    <td>{t.logical}{t.blocked && ' · blocked'}</td>
                    {m ? <MeasuredCells m={m} logical={t.logical} now={now} /> : <td colSpan={5} className="reason">? {costCell(null).title}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="empty">No ticket tracked yet.</p>}
        <p className="note">
          Duration: delegation to merge. Work: the attempts’ own time. Review rounds: AI reviewer attempts, and handovers to Human Review by the factory.
        </p>
      </section>
      {open && <Attempts ticket={open} now={now} />}
      <section>
        <h2>No source yet</h2>
        <ul className="no-source">
          {NO_SOURCE.map((n) => <li key={n.ticket}><strong>{n.label}</strong>: {n.why} ({n.ticket}).</li>)}
        </ul>
      </section>
    </div>
  );
}
