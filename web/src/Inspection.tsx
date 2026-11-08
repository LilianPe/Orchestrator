import type { FeedLine, WorkingRunView } from './types.js';

/** Of the ticket's feed, this run's: its composed activities and the ticket's events, not another run's activities. */
const ofRun = (feed: FeedLine[], runId: string) => feed.filter((l) => l.kind === 'event' || l.runId === runId);

/**
 * A run's live inspection (ORC-301): its feed in the factory's words (ORC-214), never the agent's text nor its tools'
 * parameters, which the live session alone shows; pause and stop, checked on the matrix; take over comes with ORC-234.
 */
export function Inspection({ run, feed, notice, onPause, onStop }: {
  run: WorkingRunView;
  feed: FeedLine[];
  /** The answer to the last action, when it was refused. */
  notice?: string;
  onPause: () => void;
  onStop: () => void;
}) {
  const lines = ofRun(feed, run.runId);
  return (
    <section className="inspection">
      <h2>Inspection · {run.ticketId} · {run.step}</h2>
      <div className="actions">
        <button disabled={!run.stoppable} onClick={onPause}>Pause</button>
        <button disabled={!run.stoppable} onClick={onStop}>Stop</button>
        <button disabled title="Taking over a run comes with ORC-234">Take over</button>
      </div>
      {notice && <p className="flow-failed" role="alert">{notice}</p>}
      <ul className="feed">
        {lines.length ? (
          lines.map((l, i) => (
            <li key={l.kind === 'event' ? l.id : `a-${i}`}>
              {new Date(l.at).toLocaleTimeString('en-US')} {l.kind === 'activity' ? <><strong>{l.action}</strong> {l.parameter}</> : <span className="event">{l.type}</span>}
            </li>
          ))
        ) : (
          <li className="empty">Nothing received from this run since the page was opened.</li>
        )}
      </ul>
    </section>
  );
}
