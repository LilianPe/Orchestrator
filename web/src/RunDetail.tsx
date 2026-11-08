import { formatDuration, formatTokens, plural, totalTokens } from './Flow.js';
import { runDuration, runHash } from './Measures.js';
import type { RunDetailView, RunLine } from './types.js';

const time = (at: number) => new Date(at).toLocaleString('en-US');

/** A line of an agent's session, live or from its transcript. */
export function Line({ line }: { line: RunLine }) {
  switch (line.kind) {
    case 'text':
      return <p className="line text">{line.text}</p>;
    case 'tool':
      return <p className="line tool"><span>{line.name}</span> {line.input}</p>;
    case 'tool_result':
      return line.isError ? <p className="line err">tool error</p> : null;
    case 'result':
      return <p className="line result">{line.isError ? 'Failed' : 'Done'} · {plural(line.turns, 'turn')} · ${line.costUsd.toFixed(2)}</p>;
    default:
      return null;
  }
}

function Timeline({ entries }: { entries: RunDetailView['timeline'] }) {
  return (
    <section>
      <h2>Timeline</h2>
      <ol className="timeline">
        {entries.map((e) => (
          <li key={e.id} className={e.ofRun ? 'of-run' : undefined} title={e.type}>
            <time>{time(e.at)}</time> {e.what || e.type}
          </li>
        ))}
      </ol>
      <p className="note">The ticket’s journal, in order; the events of this run stand out.</p>
    </section>
  );
}

function GatesAndDecisions({ gates, decisions }: Pick<RunDetailView, 'gates' | 'decisions'>) {
  return (
    <section>
      <h2>Gates and human decisions</h2>
      {gates.length ? (
        <ul>
          {gates.map((g) => (
            <li key={`${g.gate}-${g.openedAt}`}>
              <strong>{g.gate}</strong> gate opened {time(g.openedAt)}: {g.outcome ? `${g.outcome}, ${time(g.closedAt!)}` : 'still open'}
            </li>
          ))}
        </ul>
      ) : <p className="empty">No gate yet.</p>}
      {decisions.length ? (
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Where</th><th>What</th></tr></thead>
          <tbody>
            {decisions.map((d) => (
              <tr key={d.id}><td>{time(d.at)}</td><td>{d.who ?? '—'}</td><td>{d.channel}</td><td>{d.what}</td></tr>
            ))}
          </tbody>
        </table>
      ) : <p className="empty">No human decision yet.</p>}
    </section>
  );
}

function Findings({ findings }: Pick<RunDetailView, 'findings'>) {
  return (
    <section>
      <h2>Findings</h2>
      {findings.length ? (
        <ul>
          {findings.map((f) =>
            f.source === 'human' ? (
              <li key={f.id}>{time(f.at)} · <strong>{f.author}</strong> on PR #{f.pr}: {f.kind === 'review' ? (f.state ?? 'review') : 'comment on the diff'}</li>
            ) : (
              <li key={f.runId}>{time(f.at)} · <a href={runHash(f.runId)}>AI review</a> ({f.job}): {f.outcome ?? f.status}</li>
            ),
          )}
        </ul>
      ) : <p className="empty">No finding yet.</p>}
      <p className="note">Human reviews as GitHub states them; AI review rounds by how their attempt ended. What a reviewer wrote is in its transcript.</p>
    </section>
  );
}

function Checks({ checks }: Pick<RunDetailView, 'checks'>) {
  return (
    <section>
      <h2>Checks</h2>
      {checks.length ? (
        <table>
          <thead><tr><th>When</th><th>Check</th><th>Step</th><th>Result</th><th>Detail</th></tr></thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.id}>
                <td>{time(c.at)}</td>
                <td>{c.check}</td>
                <td>{c.runId ? <a href={runHash(c.runId)}>{c.job}</a> : '—'}</td>
                <td>{c.result}</td>
                <td>{[c.red, c.names.join(', ')].filter(Boolean).join(' · ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="empty">No check yet.</p>}
    </section>
  );
}

function Steps({ steps }: Pick<RunDetailView, 'steps'>) {
  return (
    <section>
      <h2>Cost per step</h2>
      <table>
        <thead><tr><th>Step</th><th className="num">Attempts</th><th className="num">Tokens</th><th className="num">Turns</th><th className="num">Work</th></tr></thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.job}>
              <td className="step">{s.job}</td>
              <td className="num">{s.attempts}</td>
              <td className="num">{s.tokens ? formatTokens(totalTokens(s.tokens)) : '—'}{s.attemptsWithoutTokens ? ` (${s.attemptsWithoutTokens} without tokens)` : ''}</td>
              <td className="num">{plural(s.turns, 'turn')}</td>
              <td className="num">{formatDuration(s.workMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Output({ output }: Pick<RunDetailView, 'output'>) {
  const lists = output ? ([['Tests added', output.tests_added], ['Assumptions', output.assumptions], ['Risks', output.risks], ['Untested', output.untested]] as const) : [];
  return (
    <section>
      <h2>Structured output</h2>
      {output ? (
        <>
          <p><strong>{output.status}</strong>: {output.summary}</p>
          {output.question && <p>Question: {output.question}</p>}
          {output.why && <p>Why: {output.why}</p>}
          {lists.map(([title, items]) => items.length > 0 && <p key={title}>{title}: {items.join(' · ')}</p>)}
          {output.review_hints.length > 0 && <p>To review: {output.review_hints.map((h) => `${h.file} (${h.reason})`).join(' · ')}</p>}
          <p className="note">What the agent handed back through submit_result, as the factory validated it: its own words, not a measure.</p>
        </>
      ) : <p className="empty">No structured output: the run handed back nothing through submit_result.</p>}
    </section>
  );
}

function Transcript({ transcript }: Pick<RunDetailView, 'transcript'>) {
  return (
    <section className="run">
      <h2>Transcript</h2>
      {transcript.status === 'kept' ? (
        <div className="lines">{transcript.lines.length ? transcript.lines.map((l, i) => <Line key={i} line={l} />) : <p className="empty">The transcript is empty.</p>}</div>
      ) : (
        <p className="empty">{transcript.status === 'purged' ? 'Transcript purged: transcripts are kept 30 days.' : 'No transcript recorded for this run.'}</p>
      )}
    </section>
  );
}

/** The detail of a run (ORC-298): what happened to it and to its ticket, as the factory recorded it. Read-only. */
export function RunDetail({ detail, now }: { detail: RunDetailView; now: number }) {
  const r = detail.run;
  return (
    <div className="measures run-detail">
      <section>
        <h2>{r.ticketId} · {r.job} · {r.id.slice(0, 8)}</h2>
        <p>
          {r.status}{r.outcome ? ` (${r.outcome})` : ''}{r.infra ? ', infrastructure failure' : ''} · {runDuration(r, now)} · {r.tokens ? `${formatTokens(totalTokens(r.tokens))} tokens` : 'no tokens reported'} · {plural(r.turns, 'turn')}
          {' · '}started {time(r.startedAt)}
        </p>
        {r.labels && <p className="note">Labels: {Object.entries(r.labels).filter(([k, v]) => k !== 'pending' && typeof v !== 'object').map(([k, v]) => `${k} ${v ?? '—'}`).join(' · ')}</p>}
      </section>
      <Timeline entries={detail.timeline} />
      <GatesAndDecisions gates={detail.gates} decisions={detail.decisions} />
      <Findings findings={detail.findings} />
      <Checks checks={detail.checks} />
      <Steps steps={detail.steps} />
      <Output output={detail.output} />
      <Transcript transcript={detail.transcript} />
    </div>
  );
}
