import { useCallback, useEffect, useReducer, useState } from 'react';
import { fetchFlow, fetchSnapshot, post, subscribe } from './api.js';
import { Flow } from './Flow.js';
import { initialState, reducer } from './state.js';
import type { RunLine, WorkingRunView } from './types.js';
import { PRODUCT_NAME } from '../../src/product.js';

/** A burst of ticket updates reads the Flux once. */
const FLOW_DEBOUNCE_MS = 300;

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
  const [now, setNow] = useState(() => Date.now());

  const loadFlow = useCallback(
    () => fetchFlow().then((flow) => dispatch({ type: 'flow', flow, at: Date.now() })).catch(() => undefined),
    [],
  );

  useEffect(() => {
    const load = () => {
      void fetchSnapshot().then((snapshot) => dispatch({ type: 'snapshot', snapshot })).catch(() => undefined);
      void loadFlow();
    };
    load();
    const timer = setInterval(load, 10_000);
    const off = subscribe((message) => dispatch({ type: 'bus', message }), (connected) => dispatch({ type: 'connection', connected }));
    return () => {
      clearInterval(timer);
      off();
    };
  }, [loadFlow]);

  useEffect(() => {
    if (s.flowStale === 0) return;
    const timer = setTimeout(() => void loadFlow(), FLOW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [s.flowStale, loadFlow]);

  const ticking = (s.flow?.working.length ?? 0) > 0;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);

  const stop = (run: WorkingRunView) => void post(`/api/tickets/${run.projectId}/${run.ticketId}/stop`).then(loadFlow);

  const snap = s.snapshot;
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
        {s.flow ? (
          <Flow flow={s.flow} elapsedMs={Math.max(0, now - s.flowAt)} selectedRun={s.selectedRun} onSelect={(runId) => dispatch({ type: 'select', runId })} onStop={stop} />
        ) : <div className="flow"><section><p className="empty">Chargement du Flux…</p></section></div>}
        <section className="run">
          <h2>Session en direct {s.selectedRun ? `· ${s.selectedRun.slice(0, 8)}` : ''}</h2>
          <div className="lines">
            {lines.length ? lines.map((l, i) => <Line key={i} line={l} />) : <p className="empty">{s.selectedRun ? 'Rien reçu de ce run depuis l’ouverture de la page.' : 'Choisissez un run dans Working.'}</p>}
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
