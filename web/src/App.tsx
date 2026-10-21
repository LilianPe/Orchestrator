import { useEffect, useReducer } from 'react';
import { fetchSnapshot, post, subscribe } from './api.js';
import { initialState, reducer } from './state.js';
import type { RunLine, TicketView } from './types.js';
import { PRODUCT_NAME } from '../../src/product.js';

const LABELS: Record<TicketView['logical'], string> = {
  todo: 'Todo', dev: 'En cours', human_review: 'Review humaine', ai_review: 'Review IA', ready: 'Prêt à merger', done: 'Terminé',
};
const WAITING_HUMAN = new Set(['human_review', 'ready']);

function Line({ line }: { line: RunLine }) {
  switch (line.kind) {
    case 'text':
      return <p className="line text">{line.text}</p>;
    case 'tool':
      return <p className="line tool"><span>{line.name}</span> {line.input}</p>;
    case 'tool_result':
      return line.isError ? <p className="line err">outil en erreur</p> : null;
    case 'result':
      return <p className="line result">{line.isError ? 'Échec' : 'Terminé'} · {line.turns} tours · {line.costUsd.toFixed(2)} $</p>;
    default:
      return null;
  }
}

export function App() {
  const [s, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    const load = () => fetchSnapshot().then((snapshot) => dispatch({ type: 'snapshot', snapshot })).catch(() => undefined);
    void load();
    const timer = setInterval(load, 10_000);
    const off = subscribe((message) => dispatch({ type: 'bus', message }), (connected) => dispatch({ type: 'connection', connected }));
    return () => {
      clearInterval(timer);
      off();
    };
  }, []);

  const snap = s.snapshot;
  const tickets = Object.values(s.tickets).sort((a, b) => b.updatedAt - a.updatedAt);
  const lines = s.selectedRun ? (s.runLines[s.selectedRun] ?? []) : [];

  return (
    <div className="page">
      <header>
        <h1>{PRODUCT_NAME}</h1>
        {snap && (
          <div className="stats">
            <span>Places {snap.capacity.dev.used}/{snap.capacity.dev.total}</span>
            <span>Questions {snap.capacity.questions.used}/{snap.capacity.questions.total}</span>
            <span>File {snap.queue.length}</span>
            <span>Coût du jour {snap.costTodayUsd.toFixed(2)} ${snap.budgetUsd ? ` / ${snap.budgetUsd} $` : ''}</span>
            <span className={s.connected ? 'live on' : 'live'}>{s.connected ? 'en direct' : 'déconnecté'}</span>
            {!snap.linearConnected && <a className="button primary" href="/oauth/start">Connecter Linear</a>}
            <button onClick={() => post(snap.paused ? '/api/control/resume' : '/api/control/pause')}>{snap.paused ? 'Reprendre' : 'Pause'}</button>
          </div>
        )}
      </header>
      <main>
        <section className="tickets">
          <h2>Tickets</h2>
          <table>
            <thead>
              <tr><th>Ticket</th><th>État</th><th>Attend</th><th>Coût</th><th></th></tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={`${t.projectId}/${t.ticketId}`} className={t.activeRunId === s.selectedRun ? 'selected' : ''}>
                  <td>
                    <button className="link" onClick={() => dispatch({ type: 'select', runId: t.activeRunId })}>{t.ticketId}</button> {t.title}
                  </td>
                  <td>
                    <span className={`pill ${t.logical}`}>{LABELS[t.logical]}</span>
                    {t.blocked && <span className="pill blocked" title={t.blockReason}>bloqué</span>}
                  </td>
                  <td>{t.blocked || WAITING_HUMAN.has(t.logical) ? 'vous' : t.activeRunId ? "l'agent" : '—'}</td>
                  <td className="num">{t.costUsd.toFixed(2)} $</td>
                  <td>
                    {t.prUrl && <a href={t.prUrl} target="_blank" rel="noreferrer">PR</a>}{' '}
                    {t.activeRunId && <button onClick={() => post(`/api/tickets/${t.projectId}/${t.ticketId}/stop`)}>Stop</button>}
                  </td>
                </tr>
              ))}
              {!tickets.length && (
                <tr><td colSpan={5} className="empty">Aucun ticket. Déléguez un ticket à l’agent dans Linear.</td></tr>
              )}
            </tbody>
          </table>
        </section>
        <section className="run">
          <h2>Session en direct {s.selectedRun ? `· ${s.selectedRun.slice(0, 8)}` : ''}</h2>
          <div className="lines">
            {lines.length ? lines.map((l, i) => <Line key={i} line={l} />) : <p className="empty">Choisissez un ticket en cours.</p>}
          </div>
        </section>
        <section className="journal">
          <h2>Journal</h2>
          <ul>
            {s.logs.slice(0, 5).map((l, i) => (
              <li key={`log-${i}`} className={`log ${l.level}`}>{new Date(l.at).toLocaleTimeString('fr-FR')} {l.message}</li>
            ))}
            {s.events.map((e) => (
              <li key={e.id}>{new Date(e.at).toLocaleTimeString('fr-FR')} <strong>{e.type}</strong> {e.ticketId ?? ''}</li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
