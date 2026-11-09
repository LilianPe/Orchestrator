import { useCallback, useEffect, useReducer, useRef, useState, type ComponentProps } from 'react';
import { fetchBlocks, fetchFlow, fetchMeasures, fetchOverview, fetchRunDetail, fetchRunSecurity, fetchSecurity, fetchSnapshot, fetchTakeOverShell, post, postBundle, refusal, subscribe } from './api.js';
import { clockTime, Flow } from './Flow.js';
import { Inspection } from './Inspection.js';
import { Measures, runIdOf } from './Measures.js';
import { Overview } from './Overview.js';
import { TakenOver, type ShellCommand } from './TakeOver.js';
import { Line, RunDetail } from './RunDetail.js';
import { Security } from './Security.js';
import { feedKey, initialState, reducer } from './state.js';
import type { FlowView, RunDetailView, RunSecurityView, WorkingRunView } from './types.js';
import { PRODUCT_NAME } from '../../src/product.js';

/** A burst of ticket updates reads the Flow once. */
const FLOW_DEBOUNCE_MS = 300;
const MEASURES_POLL_MS = 30_000;
/** The overview reads every ticket of 90 days, one journal each, and moves with merges: read less often (ORC-299). */
const OVERVIEW_POLL_MS = 5 * 60_000;

/** The durations go on between two reads: only the Flow renders each second, not the session nor the journal. */
function LiveFlow({ flow, flowAt, frozen, ...rest }: { flow: FlowView; flowAt: number; frozen: boolean } & Omit<ComponentProps<typeof Flow>, 'flow' | 'elapsedMs'>) {
  const [now, setNow] = useState(() => Date.now());
  const ticking = !frozen && flow.working.length > 0;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);
  return <Flow flow={flow} elapsedMs={Math.max(0, now - flowAt)} {...rest} />;
}

type View = 'flow' | 'overview' | 'measures' | 'run' | 'security';
const PAGES: Record<string, View> = { '#overview': 'overview', '#measures': 'measures', '#security': 'security' };
const viewOf = (hash: string): View => (runIdOf(hash) !== undefined ? 'run' : PAGES[hash] ?? 'flow');

/**
 * What `read` gives, read now and every `everyMs` (30 s) while the page is shown and its tab visible, again when `deps` change; an
 * answer to an earlier read never replaces a later one. `failed`: the last read failed, `data` still the one before.
 */
function usePolled<T>(read: () => Promise<T>, deps: readonly unknown[], everyMs = MEASURES_POLL_MS): { data?: T; failed: boolean } {
  const [state, setState] = useState<{ data?: T; failed: boolean }>({ failed: false });
  useEffect(() => {
    let live = true;
    const load = () =>
      void read().then(
        (data) => live && setState({ data, failed: false }),
        () => live && setState((s) => ({ ...s, failed: true })),
      );
    load();
    const timer = setInterval(() => document.hidden || load(), everyMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // `read` is rebuilt each render: `deps` say when it changes.
  }, deps);
  return state;
}

/** The reduced overview (ORC-299), read when shown and every 5 min while it is: the factory computes it over the last 90 days. */
function OverviewPage() {
  const { data, failed } = usePolled(fetchOverview, [], OVERVIEW_POLL_MS);
  return (
    <div className="flow">
      {failed && <p className="flow-failed" role="alert">{data ? 'Overview out of date: reading it failed. Retrying within 5 min.' : 'Overview unavailable: reading it failed. Retrying within 5 min.'}</p>}
      {data ? <Overview overview={data} /> : !failed && <section><p className="empty">Loading the overview…</p></section>}
    </div>
  );
}

/** The measures page (ORC-223), read when shown and every 30 s while it is: its figures change slowly, each read is a journal per ticket. */
function MeasuresPage() {
  const { data, failed } = usePolled(async () => ({ tickets: await fetchMeasures(), now: Date.now() }), []);
  const [selected, setSelected] = useState<string>();
  return (
    <div className="flow">
      {failed && <p className="flow-failed" role="alert">{data ? 'Measures out of date: reading them failed. Retrying within 30 s.' : 'Measures unavailable: reading them failed. Retrying within 30 s.'}</p>}
      {data ? <Measures tickets={data.tickets} now={data.now} selected={selected} onSelect={setSelected} /> : !failed && <section><p className="empty">Loading the measures…</p></section>}
    </div>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIODS = [7, 30, 90] as const;

/** The security log and the Pareto of the blocks (ORC-300), over the last days chosen, read when shown and every 30 s while it is. */
function SecurityPage() {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(7);
  const { data, failed } = usePolled(() => {
    const until = Date.now();
    const since = until - days * DAY_MS;
    return Promise.all([fetchSecurity(since, until), fetchBlocks(since, until)]).then(([period, blocks]) => ({ period, blocks }));
  }, [days]);
  const [run, setRun] = useState<{ runId: string; view?: RunSecurityView; failed?: boolean }>();
  // Another period lists other runs: the one selected goes with the last one.
  const choose = (d: (typeof PERIODS)[number]) => {
    setDays(d);
    setRun(undefined);
  };
  // Picking a run reads it, picking it again reads it again: a failed read is the run's, not the period's.
  const select = (runId: string) => {
    setRun({ runId });
    void fetchRunSecurity(runId).then(
      (view) => setRun((r) => (r?.runId === runId ? { runId, view } : r)),
      () => setRun((r) => (r?.runId === runId ? { runId, failed: true } : r)),
    );
  };
  return (
    <div className="flow">
      <nav className="periods" aria-label="Period">
        {PERIODS.map((d) => <button key={d} aria-pressed={d === days} onClick={() => choose(d)}>Last {d} days</button>)}
      </nav>
      {failed && <p className="flow-failed" role="alert">{data ? 'Security log out of date: reading it failed. Retrying within 30 s.' : 'Security log unavailable: reading it failed. Retrying within 30 s.'}</p>}
      {data ? <Security period={data.period} blocks={data.blocks} run={run?.view} runFailed={run?.failed} selected={run?.runId} onSelect={select} /> : !failed && <section><p className="empty">Loading the security log…</p></section>}
    </div>
  );
}

/** The detail of a run (ORC-298), read when opened: a finished run's detail changes no more. */
function RunPage({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<RunDetailView>();
  const [failed, setFailed] = useState<'missing' | 'error'>();
  useEffect(() => {
    let live = true;
    setDetail(undefined);
    setFailed(undefined);
    void fetchRunDetail(runId).then(
      (d) => live && (d ? setDetail(d) : setFailed('missing')),
      () => live && setFailed('error'),
    );
    return () => {
      live = false;
    };
  }, [runId]);
  return (
    <div className="flow">
      <p><a href="#measures">← Measures</a></p>
      {failed && <p className="flow-failed" role="alert">{failed === 'missing' ? `No run ${runId}.` : 'Run detail unavailable: reading it failed. Reload to retry.'}</p>}
      {detail ? <RunDetail detail={detail} now={Date.now()} /> : !failed && <section><p className="empty">Loading the run…</p></section>}
    </div>
  );
}

export function App() {
  const [hash, setHash] = useState(() => window.location.hash);
  const view = viewOf(hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [s, dispatch] = useReducer(reducer, initialState);
  const lastRead = useRef(0);

  // Reads overlap (the poll, a ticket update, Stop): only the latest one counts, an older answer is out of date.
  const loadFlow = useCallback(() => {
    const read = ++lastRead.current;
    const latest = (action: Parameters<typeof dispatch>[0]) => {
      if (read === lastRead.current) dispatch(action);
    };
    return fetchFlow().then((flow) => latest({ type: 'flow', flow, at: Date.now() })).catch(() => latest({ type: 'flowFailed' }));
  }, []);

  useEffect(() => {
    const load = () => void fetchSnapshot().then((snapshot) => dispatch({ type: 'snapshot', snapshot })).catch(() => undefined);
    load();
    const timer = setInterval(load, 10_000);
    const off = subscribe((message) => dispatch({ type: 'bus', message }), (connected) => dispatch({ type: 'connection', connected }));
    return () => {
      clearInterval(timer);
      off();
    };
  }, []);

  // The Flow is read while it is shown, not behind the measures.
  useEffect(() => {
    if (view !== 'flow') return;
    void loadFlow();
    const timer = setInterval(() => void loadFlow(), 10_000);
    return () => clearInterval(timer);
  }, [view, loadFlow]);

  useEffect(() => {
    if (s.flowStale === 0 || view !== 'flow') return;
    const timer = setTimeout(() => void loadFlow(), FLOW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [s.flowStale, view, loadFlow]);

  // A pause or a stop of a run, from its inspection or Working (ORC-301): a refusal is said in its inspection, a success reads the Flow again.
  const [notice, setNotice] = useState<{ runId: string; text: string }>();
  const control = (run: WorkingRunView, action: 'pause' | 'stop' | 'take-over') => () =>
    void post(`/api/runs/${run.runId}/${action}`).then(
      async (res) => {
        if (res.ok) {
          setNotice(undefined);
          return loadFlow();
        }
        setNotice({ runId: run.runId, text: await refusal(res, action) });
      },
      () => setNotice({ runId: run.runId, text: `${action} not sent: the server did not answer` }),
    );

  const snap = s.snapshot;
  const lines = s.selectedRun ? (s.runLines[s.selectedRun] ?? []) : [];
  const inspected = s.flow?.working.find((w) => w.runId === s.selectedRun);
  // The tickets a human took over (ORC-234): how to reach their container, and the bundles handed back.
  const takenOver = s.flow?.needsYou.blocked.flatMap((g) => g.tickets).filter((t) => t.kind === 'taken_over') ?? [];
  const [shells, setShells] = useState<Record<string, ShellCommand>>({});
  const [takeOverNotice, setTakeOverNotice] = useState<Record<string, string | undefined>>({});
  const tell = (key: string, text?: string) => setTakeOverNotice((n) => ({ ...n, [key]: text }));
  const unanswered = (key: string) => () => tell(key, 'not sent: the server did not answer');
  const askShell = (t: { projectId: string; ticketId: string }) => () => {
    const key = feedKey(t.projectId, t.ticketId);
    void fetchTakeOverShell(t.projectId, t.ticketId).then(async (res) => {
      if (!res.ok) return tell(key, await refusal(res, 'shell'));
      const shell = (await res.json()) as ShellCommand;
      setShells((sh) => ({ ...sh, [key]: shell }));
      tell(key);
    }, unanswered(key));
  };
  const handBack = (t: { projectId: string; ticketId: string }) => (file: File) => {
    const key = feedKey(t.projectId, t.ticketId);
    void postBundle(t.projectId, t.ticketId, file).then(
      async (res) => tell(key, res.ok ? 'Bundle handed back: the factory checks it, then pushes it if it passes. Its verdict comes on the ticket.' : await refusal(res, 'bundle')),
      unanswered(key),
    );
  };

  return (
    <div className="page">
      <header>
        <h1>{PRODUCT_NAME}</h1>
        <nav className="views">
          <a href="#flow" aria-current={view === 'flow' ? 'page' : undefined}>Flow</a>
          <a href="#overview" aria-current={view === 'overview' ? 'page' : undefined}>Overview</a>
          <a href="#measures" aria-current={view === 'measures' || view === 'run' ? 'page' : undefined}>Measures</a>
          <a href="#security" aria-current={view === 'security' ? 'page' : undefined}>Security</a>
        </nav>
        {snap && (
          <div className="stats">
            <span>Slots {snap.capacity.dev.used}/{snap.capacity.dev.total}</span>
            <span>Questions {snap.capacity.questions.used}/{snap.capacity.questions.total}</span>
            <span>Queue {snap.queue.length}</span>
            <span>Today’s cost ${snap.costTodayUsd.toFixed(2)}</span>
            <span className={s.connected ? 'live on' : 'live'}>{s.connected ? 'live' : 'disconnected'}</span>
            {!snap.linearConnected && <a className="button primary" href="/oauth/start">Connect Linear</a>}
            <button onClick={() => post(snap.paused ? '/api/control/resume' : '/api/control/pause')}>{snap.paused ? 'Resume' : 'Pause'}</button>
          </div>
        )}
      </header>
      {snap?.usageLimitedUntil && (
        <p className="usage-limit" role="status">
          Paused by the usage limit of the Claude account: no run starts until {new Date(snap.usageLimitedUntil).toLocaleString()}.
        </p>
      )}
      {view === 'run' ? <main className="single"><RunPage runId={runIdOf(hash)!} /></main> : view === 'overview' ? <main className="single"><OverviewPage /></main> : view === 'measures' ? <main className="single"><MeasuresPage /></main> : view === 'security' ? <main className="single"><SecurityPage /></main> : <main>
        <div className="flow">
          {s.flowFailed && <p className="flow-failed" role="alert">{s.flow ? 'Flow out of date: reading it failed, what follows may be stale. Retrying within 10 s.' : 'Flow unavailable: reading it failed. Retrying within 10 s.'}</p>}
          {s.flow ? (
            <LiveFlow flow={s.flow} flowAt={s.flowAt} frozen={s.flowFailed} selectedRun={s.selectedRun} onSelect={(runId) => dispatch({ type: 'select', runId })} onStop={(run) => control(run, 'stop')()} />
          ) : !s.flowFailed && <section><p className="empty">Loading the Flow…</p></section>}
        </div>
        {inspected && (
          <Inspection run={inspected} feed={s.feeds[feedKey(inspected.projectId, inspected.ticketId)] ?? []} notice={notice?.runId === inspected.runId ? notice.text : undefined} onPause={control(inspected, 'pause')} onStop={control(inspected, 'stop')} onTakeOver={control(inspected, 'take-over')} />
        )}
        {takenOver.map((t) => {
          const key = feedKey(t.projectId, t.ticketId);
          return <TakenOver key={key} ticket={t} shell={shells[key]} notice={takeOverNotice[key]} onShell={askShell(t)} onBundle={handBack(t)} />;
        })}
        <section className="run">
          <h2>Live session {s.selectedRun ? `· ${s.selectedRun.slice(0, 8)}` : ''}</h2>
          <div className="lines">
            {lines.length ? lines.map((l, i) => <Line key={i} line={l} />) : <p className="empty">{s.selectedRun ? 'Nothing received from this run since the page was opened.' : 'Pick a run in Working.'}</p>}
          </div>
        </section>
        <section className="journal">
          <h2>Log</h2>
          <ul>
            {s.logs.slice(0, 5).map((l, i) => (
              <li key={`log-${i}`} className={`log ${l.level}`}>{clockTime(l.at)} {l.message}</li>
            ))}
            {s.events.map((e) => (
              <li key={e.id}>{clockTime(e.at)} <strong>{e.type}</strong> {e.ticketId ?? ''}</li>
            ))}
          </ul>
        </section>
      </main>}
    </div>
  );
}
