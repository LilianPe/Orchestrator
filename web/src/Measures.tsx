import { CAUSE_LABELS, formatDuration, formatTokens, plural, PrLink, tokensCell, totalTokens } from './Flow.js';
import type { MeasuredTicketView, RunMeasureView, TicketMeasuresView } from './types.js';

/** Where a run's detail is (ORC-298): `#run/<id>`. */
export const runHash = (runId: string): string => `#run/${encodeURIComponent(runId)}`;
export function runIdOf(hash: string): string | undefined {
  if (!hash.startsWith('#run/')) return undefined;
  try {
    return decodeURIComponent(hash.slice(5)) || undefined;
  } catch {
    // A malformed link: no run, the Flow instead of a blank page.
    return undefined;
  }
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

const key = (t: MeasuredTicketView) => `${t.projectId}/${t.ticketId}`;

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
                <td className="step"><a href={runHash(r.id)}>{r.job}</a></td>
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

/** The measures page (ORC-223): each ticket's cost, duration and review rounds, then the attempts of the one selected. */
export function Measures({ tickets, now, selected, onSelect }: { tickets: MeasuredTicketView[]; now: number; selected?: string; onSelect: (key: string) => void }) {
  const open = tickets.find((t) => key(t) === selected);
  return (
    <div className="measures">
      <section>
        <h2>Tickets</h2>
        <p className="note">The {plural(tickets.length, 'ticket')} most recently updated. The figures over all the tickets of a period are on the <a href="#overview">Overview</a>.</p>
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
                    <td>{t.logical}{t.blockCause && ` · blocked: ${CAUSE_LABELS[t.blockCause]}`}</td>
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
    </div>
  );
}
