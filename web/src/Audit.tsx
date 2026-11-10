import { useState, type FormEvent } from 'react';
import { formatDuration, formatTokens, plural, PrLink, totalTokens } from './Flow.js';
import { runHash } from './Measures.js';
import { REWORK_LABELS } from './Overview.js';
import type { AuditListView, AuditSheetView, DefectEntry, ReviewDefectView } from './types.js';

const time = (at: number) => new Date(at).toLocaleString('en-US');

/** Why nothing is counted while ORC-153 is open: `NO_DEFINITION` of src/core/audit.ts, which the web cannot import. */
export const NO_DEFINITION = 'No definition of a serious defect is set (audit.serious_defect in factory.yml, ORC-153): the defects entered are kept, not counted.';

/** Where a ticket's audit sheet is (ORC-229): `#audit/<project>/<ticket>`. */
export const auditHash = (projectId: string, ticketId: string): string => `#audit/${encodeURIComponent(projectId)}/${encodeURIComponent(ticketId)}`;
export function auditTicketOf(hash: string): { projectId: string; ticketId: string } | undefined {
  const m = /^#audit\/([^/]+)\/([^/]+)$/.exec(hash);
  if (!m) return undefined;
  try {
    return { projectId: decodeURIComponent(m[1]!), ticketId: decodeURIComponent(m[2]!) };
  } catch {
    // A malformed link: no sheet, the list instead of a blank page.
    return undefined;
  }
}

/** The PRs a human reviewed (ORC-229), each to its audit sheet. */
export function AuditList({ list }: { list: AuditListView }) {
  return (
    <div className="measures">
      <section>
        <h2>Reviewed PRs</h2>
        {list.sheets.length ? (
          <table>
            <thead><tr><th>Ticket</th><th>State</th><th>Merged</th></tr></thead>
            <tbody>
              {list.sheets.map((s) => (
                <tr key={`${s.projectId}/${s.ticketId}`}>
                  <td><a href={auditHash(s.projectId, s.ticketId)}>{s.ticketId}</a> {s.title} <PrLink url={s.prUrl} /></td>
                  <td>{s.logical}</td>
                  <td>{s.mergedAt === null ? '—' : time(s.mergedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="empty">No PR reviewed by a human yet.</p>}
        <p className="note">The PRs a human reviewed on GitHub, or the factory handed to Human Review, among the 50 tickets with a PR updated last.</p>
      </section>
    </div>
  );
}

function Task({ task }: Pick<AuditSheetView, 'task'>) {
  const spec = task.spec;
  return (
    <section>
      <h2>The task</h2>
      <p><strong>{task.title}</strong></p>
      {spec ? (
        <>
          {spec.goal && <p>Goal: {spec.goal}</p>}
          {spec.criteria?.length ? <ul>{spec.criteria.map((c, i) => <li key={i}>{c}</li>)}</ul> : null}
          {spec.out_of_scope?.length ? <p>Out of scope: {spec.out_of_scope.join(' · ')}</p> : null}
          <p className="note">The last spec the factory was handed back (ORC-212).</p>
        </>
      ) : <p className="empty">No spec: the ticket was worked from its description.</p>}
    </section>
  );
}

function AgentPath({ path }: Pick<AuditSheetView, 'path'>) {
  return (
    <section>
      <h2>The agent’s path</h2>
      <table>
        <thead><tr><th>Step</th><th className="num">Attempts</th><th className="num">Tokens</th><th className="num">Turns</th><th className="num">Work</th></tr></thead>
        <tbody>
          {path.steps.map((s) => (
            <tr key={s.job}>
              <td className="step">{s.job}</td>
              <td className="num">{s.attempts}</td>
              <td className="num">{s.tokens ? formatTokens(totalTokens(s.tokens)) : '—'}</td>
              <td className="num">{plural(s.turns, 'turn')}</td>
              <td className="num">{formatDuration(s.workMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">Attempts: {path.attempts.length ? path.attempts.map((a) => <a key={a.id} href={runHash(a.id)}>{`${a.job} (${a.status}) `}</a>) : 'none'}</p>
      <h3>Checks</h3>
      {path.checks.length ? (
        <ul>{path.checks.map((c) => <li key={c.id}>{time(c.at)} · {c.check} {c.result}{c.names.length ? `: ${c.names.join(', ')}` : ''}{c.red ? ` (${c.red})` : ''}</li>)}</ul>
      ) : <p className="empty">No check.</p>}
      <h3>AI review findings</h3>
      {path.findings.length ? (
        <ul>
          {path.findings.map((f) => (
            <li key={f.id}><strong>{f.severity}</strong> · {f.lens} lens on {f.sha.slice(0, 7)} · {f.file}:{f.line}: {f.explanation} <span className="note">({f.id})</span></li>
          ))}
        </ul>
      ) : <p className="empty">No finding kept.</p>}
    </section>
  );
}

function Result({ result }: Pick<AuditSheetView, 'result'>) {
  return (
    <section>
      <h2>The result</h2>
      <ul>
        {result.prs.map((p) => <li key={p.number}><a href={p.url}>PR #{p.number}</a>: {p.state}{p.mergedAt === null ? '' : `, ${time(p.mergedAt)}`}</li>)}
      </ul>
      {result.reviews.length ? (
        <ul>{result.reviews.map((r) => <li key={r.id}>{time(r.at)} · <strong>{r.author}</strong> on PR #{r.pr}: {r.kind === 'review' ? (r.state?.replace(/_/g, ' ') ?? 'review') : 'comment on the diff'}</li>)}</ul>
      ) : <p className="empty">No review on GitHub.</p>}
      <p className="note">
        First try: {result.firstTry === null ? 'not merged' : result.firstTry ? 'yes' : `no (${result.reworks.map((r) => REWORK_LABELS[r.cause]).join(', ')})`}
        {' · '}Reverted within 14 days: {result.revertedWithin14Days === null ? 'unknown' : result.revertedWithin14Days ? 'yes' : 'no'}
      </p>
    </section>
  );
}

/** Whether a defect counts under the definition in force, said without a figure. */
function standing(d: ReviewDefectView, definition: string | null): string {
  if (definition === null || d.definition === definition) return '';
  return d.definition === null ? ' · entered under no definition: not counted' : ' · entered under another definition: not counted';
}

function DefectForm({ sheet, onDefect }: { sheet: AuditSheetView; onDefect: (e: DefectEntry) => void }) {
  const [prNumber, setPr] = useState(sheet.result.prs.at(-1)?.number ?? 0);
  const [description, setDescription] = useState('');
  const [findingId, setFinding] = useState('');
  const [file, setFile] = useState('');
  const [line, setLine] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onDefect({ prNumber, description, ...(findingId ? { findingId } : {}), ...(file.trim() ? { file: file.trim() } : {}), ...(Number(line) > 0 ? { line: Number(line) } : {}) });
    setDescription('');
  };
  return (
    <form className="defect" onSubmit={submit}>
      <label>PR <select value={prNumber} onChange={(e) => setPr(Number(e.target.value))}>{sheet.result.prs.map((p) => <option key={p.number} value={p.number}>#{p.number}</option>)}</select></label>
      <label>Defect <textarea required value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <label>
        AI finding that saw it{' '}
        <select value={findingId} onChange={(e) => setFinding(e.target.value)}>
          <option value="">None: the AI reviewers missed it</option>
          {sheet.path.findings.map((f) => <option key={f.id} value={f.id}>{`${f.file}:${f.line} · ${f.lens} · ${f.severity}`}</option>)}
        </select>
      </label>
      <label>File <input value={file} onChange={(e) => setFile(e.target.value)} /></label>
      <label>Line <input inputMode="numeric" value={line} onChange={(e) => setLine(e.target.value)} /></label>
      <button type="submit" disabled={!sheet.result.prs.length}>Enter the defect</button>
    </form>
  );
}

/**
 * The defects humans found in review (ORC-229), each linked to the AI finding that saw it or missed by the AI reviewers, and
 * the entry of one. No figure while no definition of a serious defect is set (ORC-153).
 */
function Defects({ sheet, onDefect, notice }: { sheet: AuditSheetView; onDefect: (e: DefectEntry) => void; notice?: string | undefined }) {
  return (
    <section>
      <h2>Defects found in human review</h2>
      <p className="note">{sheet.definition === null ? NO_DEFINITION : `Counted by the definition of a serious defect: ${sheet.definition}`}</p>
      {sheet.defects.length ? (
        <ul>
          {sheet.defects.map((d) => (
            <li key={d.id}>
              {time(d.at)} · PR #{d.prNumber}{d.file ? ` · ${d.file}${d.line ? `:${d.line}` : ''}` : ''}: {d.description}{' '}
              <em>{d.findingId === null ? 'missed by the AI reviewers' : `seen by finding ${d.findingId}`}</em>
              <span className="note"> · {d.enteredBy}{standing(d, sheet.definition)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="empty">No defect entered.</p>}
      {notice && <p className="flow-failed" role="status">{notice}</p>}
      <DefectForm sheet={sheet} onDefect={onDefect} />
    </section>
  );
}

/** The audit sheet of a reviewed PR (ORC-229): the task, the agent's path, the result, from the factory's records; then the defects. */
export function AuditSheet({ sheet, onDefect, notice }: { sheet: AuditSheetView; onDefect: (e: DefectEntry) => void; notice?: string | undefined }) {
  return (
    <div className="measures audit">
      <section><h2>Audit sheet · {sheet.ticketId}</h2></section>
      <Task task={sheet.task} />
      <AgentPath path={sheet.path} />
      <Result result={sheet.result} />
      <Defects sheet={sheet} onDefect={onDefect} notice={notice} />
    </div>
  );
}
