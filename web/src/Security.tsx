import { CAUSE_LABELS, plural } from './Flow.js';
import type { BlockParetoView, RunSecurityView, SecurityPeriodView } from './types.js';

/** What the security log of the MVP doc asks for that nothing in the factory records yet, and the ticket of its source. */
export const NO_SECURITY_SOURCE = [
  { label: 'Dependencies added and refused', ticket: 'ORC-165', why: 'the dependency check exists, but verify does not run it yet: nothing records what it finds' },
] as const;

export const percent = (share: number): string => `${Math.round(share * 100)}%`;

const time = (at: number) => new Date(at).toLocaleString();

function Pareto({ blocks }: { blocks: BlockParetoView }) {
  return (
    <section>
      <h2>Block causes{blocks.total > 0 && <span className="count">{blocks.total}</span>}</h2>
      {blocks.causes.length ? (
        <table>
          <thead>
            <tr><th>Cause</th><th className="num">Blocks</th><th className="num">Share</th><th className="num">Running share</th></tr>
          </thead>
          <tbody>
            {blocks.causes.map((c) => (
              <tr key={c.cause}>
                <td>{CAUSE_LABELS[c.cause]}<span className="bar" style={{ width: percent(c.share) }} /></td>
                <td className="num">{c.count}</td>
                <td className="num">{percent(c.share)}</td>
                <td className="num">{percent(c.cumulative)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="empty">No ticket moved into Blocked over the period.</p>}
      <p className="note">Each move of a ticket into Blocked over the period, by the cause the factory typed when it blocked it.</p>
    </section>
  );
}

function Counts<T>({ title, head, items, cells, empty }: { title: string; head: string[]; items: T[]; cells: (item: T) => (string | number)[]; empty: string }) {
  return (
    <div>
      <h3>{title}</h3>
      {items.length ? (
        <table>
          <thead>
            <tr>{head.map((h, i) => <th key={h} className={i ? 'num' : undefined}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {items.map((item, k) => <tr key={k}>{cells(item).map((c, i) => <td key={i} className={i ? 'num' : undefined}>{c}</td>)}</tr>)}
          </tbody>
        </table>
      ) : <p className="empty">{empty}</p>}
    </div>
  );
}

function Run({ run }: { run: RunSecurityView }) {
  const skipped = run.skipped.egress + run.skipped.refusals;
  return (
    <section>
      <h2>Run {run.runId.slice(0, 8)} · {run.ticketId}</h2>
      <div className="split">
        <Counts title="Refusals per rule" head={['Rule', 'Refusals']} items={run.rules} cells={(r) => [r.rule, r.refusals]} empty="No refusal of the hook." />
        <Counts title="Hosts refused" head={['Host', 'Refused']} items={run.refusedHosts} cells={(h) => [h.host, h.refused]} empty="No request refused by the proxy." />
      </div>
      {run.refusals.length > 0 && (
        <ul className="refusals">
          {run.refusals.map((r, i) => <li key={i}>{time(r.at)} <span className="step">{r.tool}</span> {r.rule}</li>)}
        </ul>
      )}
      {skipped > 0 && <p className="note">{plural(skipped, 'log line')} ignored (malformed or forged).</p>}
    </section>
  );
}

/**
 * The security log and the Pareto of the block causes (ORC-300), read-only, as the factory computed them: over the
 * period, then the run selected. Only rules and hosts: never a command nor a path, which can hold a secret.
 */
export function Security({ period, blocks, run, selected, onSelect }: { period: SecurityPeriodView; blocks: BlockParetoView; run?: RunSecurityView; selected?: string; onSelect: (runId: string) => void }) {
  const quiet = period.runs.length === 0;
  return (
    <div className="measures">
      <Pareto blocks={blocks} />
      {quiet ? <section><h2>Security log</h2><p className="empty">No security log over the period.</p></section> : (
        <>
          <section>
            <h2>Runs</h2>
            <table>
              <thead>
                <tr><th>Ticket</th><th>Run</th><th className="num">Requests</th><th className="num">Refused</th><th className="num">Hook refusals</th></tr>
              </thead>
              <tbody>
                {period.runs.map((r) => (
                  <tr key={r.runId} className={r.runId === selected ? 'selected' : undefined}>
                    <td>{r.ticketId}</td>
                    <td><button className="link" onClick={() => onSelect(r.runId)}>{r.runId.slice(0, 8)}</button></td>
                    <td className="num">{r.requests}</td>
                    <td className="num">{r.refused}</td>
                    <td className="num">{r.refusals}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {run && <Run run={run} />}
          <section>
            <h2>Security log of the period</h2>
            <div className="split">
              <Counts title="Refusals per rule" head={['Rule', 'Refusals']} items={period.rules} cells={(r) => [r.rule, r.refusals]} empty="No refusal of the hook." />
              <Counts title="Hosts contacted" head={['Host', 'Requests', 'Refused']} items={period.hosts} cells={(h) => [h.host, h.requests, h.refused]} empty="No request through the proxy." />
            </div>
          </section>
        </>
      )}
      <section>
        <h2>No source yet</h2>
        <ul className="no-source">
          {NO_SECURITY_SOURCE.map((n) => <li key={n.ticket}><strong>{n.label}</strong>: {n.why} ({n.ticket}).</li>)}
        </ul>
      </section>
    </div>
  );
}
