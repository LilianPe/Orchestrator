import { AGENT_QUESTION, restatesCause, STOPPED, type BlockCause } from '../../src/core/block-cause.js';
import type { FlowTicketView, FlowView, TokensView, WorkingRunView } from './types.js';

export const CAUSE_LABELS: Record<BlockCause, string> = {
  question: AGENT_QUESTION,
  contested: 'Ticket disputed by the agent',
  conflict: 'Conflict with the default branch',
  red: 'Red not verified',
  infra: 'Infrastructure failure',
  limit: 'Limit reached',
  loop: 'Loop',
  failed: 'Run failed',
  pickup: 'Pickup refused',
  repo_config: 'Invalid repository configuration',
  dead_letter: 'Event set aside',
  pr_closed: 'PR closed without merge',
  stopped: STOPPED,
  other: 'Other cause',
};

const pad = (n: number) => String(n).padStart(2, '0');

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${pad(seconds % 60)} s`;
  return `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min`;
}

/** `1 turn`, `2 turns`. */
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The time of a line of the log or of a run's feed. */
export const clockTime = (at: number): string => new Date(at).toLocaleTimeString('en-US');

export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  // Rounded before the unit is chosen: 999 950 reads 1.0 M, not 1000.0 k.
  const k = Math.round(n / 100) / 10;
  return k < 1_000 ? `${k.toFixed(1)} k` : `${(Math.round(n / 100_000) / 10).toFixed(1)} M`;
}

/** What the dashboard calls a ticket's tokens: input, output, cache read and cache write. */
export const totalTokens = (t: TokensView): number => t.input + t.output + t.cacheRead + t.cacheCreation;

/** The measure of the ticket; the cost in dollars is what exists when no attempt reported tokens (ORC-216). */
export function tokensCell(run: Pick<WorkingRunView, 'measured' | 'tokens' | 'attemptsWithoutTokens' | 'costUsd'>): { text: string; title: string } {
  if (!run.measured) return { text: '?', title: 'This ticket’s measurements could not be read: see the log.' };
  if (!run.tokens) {
    return { text: run.costUsd > 0 ? `— ($${run.costUsd.toFixed(2)})` : '—', title: 'No finished attempt reported its tokens.' };
  }
  const { input, output, cacheRead, cacheCreation } = run.tokens;
  const missing = run.attemptsWithoutTokens > 0 ? `${plural(run.attemptsWithoutTokens, 'finished attempt')} without a measurement. ` : '';
  return {
    text: `${missing ? '≥ ' : ''}${formatTokens(totalTokens(run.tokens))}`,
    title: `${missing}Input ${formatTokens(input)}, output ${formatTokens(output)}, cache read ${formatTokens(cacheRead)}, cache write ${formatTokens(cacheCreation)}.`,
  };
}

export function PrLink({ url }: { url?: string }) {
  return url ? <a className="pr" href={url} target="_blank" rel="noreferrer">PR</a> : null;
}

function TicketRow({ ticket, detail }: { ticket: FlowTicketView; detail?: string }) {
  return (
    <li>
      <span className="ticket-head"><strong className="id">{ticket.ticketId}</strong> {ticket.title} <PrLink url={ticket.prUrl} /></span>
      {detail && <span className="reason">{detail}</span>}
    </li>
  );
}

function TicketList({ tickets }: { tickets: { ticket: FlowTicketView; detail?: string }[] }) {
  return <ul>{tickets.map(({ ticket, detail }) => <TicketRow key={`${ticket.projectId}/${ticket.ticketId}`} ticket={ticket} detail={detail} />)}</ul>;
}

function Group({ label, tone, tickets }: { label: string; tone: 'blocked' | 'human'; tickets: { ticket: FlowTicketView; detail?: string }[] }) {
  return (
    <div className={`group ${tone}`}>
      <h3>{label}</h3>
      <span className="count">{tickets.length}</span>
      <TicketList tickets={tickets} />
    </div>
  );
}

export function Flow({ flow, elapsedMs, selectedRun, onSelect, onStop }: {
  flow: FlowView;
  /** Since `flow` was received: the durations go on between two reads. */
  elapsedMs: number;
  selectedRun?: string;
  onSelect: (runId: string) => void;
  onStop: (run: WorkingRunView) => void;
}) {
  const { blocked, humanReview, gates } = flow.needsYou;
  const waiting = blocked.reduce((sum, g) => sum + g.tickets.length, humanReview.length + gates.length);
  return (
    <>
      <section className={waiting ? 'needs active' : 'needs'}>
        <h2>Needs you{waiting > 0 && <span className="count">{waiting}</span>}</h2>
        {!waiting && <p className="empty">Nothing is waiting for a human.</p>}
        {blocked.map((g) => <Group key={g.cause} label={CAUSE_LABELS[g.cause]} tone="blocked" tickets={g.tickets.map((ticket) => ({ ticket, detail: restatesCause(ticket.kind) ? undefined : ticket.reason }))} />)}
        {humanReview.length > 0 && <Group label="PRs in Human Review" tone="human" tickets={humanReview.map((ticket) => ({ ticket }))} />}
        {gates.length > 0 && <Group label="Pending gates" tone="human" tickets={gates.map((ticket) => ({ ticket, detail: 'Merge gate' }))} />}
      </section>
      <section className="working">
        <h2>Working{flow.working.length > 0 && <span className="count">{flow.working.length}</span>}</h2>
        {flow.working.length > 0 ? (
          <table>
            <thead>
              <tr><th>Ticket</th><th>Step</th><th className="num">Duration</th><th className="num">Ticket tokens</th><th></th></tr>
            </thead>
            <tbody>
              {flow.working.map((run) => {
                const tokens = tokensCell(run);
                return (
                  <tr key={run.runId} className={run.runId === selectedRun ? 'selected' : ''}>
                    <td><button className="link" onClick={() => onSelect(run.runId)}>{run.ticketId}</button> {run.title} <PrLink url={run.prUrl} /></td>
                    <td className="step">{run.step}{run.verifying && ' · verification'}</td>
                    <td className="num">{formatDuration(run.durationMs + elapsedMs)}</td>
                    <td className="num" title={tokens.title}>{tokens.text}</td>
                    <td className="actions">{run.stoppable && <button onClick={() => onStop(run)}>Stop</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="empty">No run in progress.</p>}
        {flow.working.length > 0 && <p className="note">Tokens of the ticket’s finished attempts. A run in progress counts when it ends.</p>}
        {flow.queued.length > 0 && (
          <p className="queued"><span>Queued</span> {flow.queued.map((q) => `${q.ticketId} (${q.job})`).join(', ')}</p>
        )}
      </section>
      <section className="done">
        <h2>Done</h2>
        {flow.done.length > 0 ? <TicketList tickets={flow.done.map((ticket) => ({ ticket }))} /> : <p className="empty">No ticket finished this week.</p>}
        {flow.others.length > 0 && (
          <details>
            <summary>Other tracked tickets ({flow.others.length})</summary>
            <TicketList tickets={flow.others.map((ticket) => ({ ticket }))} />
          </details>
        )}
      </section>
    </>
  );
}
