import type { BlockCause } from '../../src/core/block-cause.js';
import type { FlowTicketView, FlowView, WorkingRunView } from './types.js';

const CAUSE_LABELS: Record<BlockCause, string> = {
  question: 'Question de l’agent',
  contested: 'Ticket contesté par l’agent',
  red: 'Rouge non vérifié',
  infra: 'Panne d’infrastructure',
  limit: 'Plafond atteint',
  loop: 'Boucle',
  failed: 'Run en échec',
  pickup: 'Prise en charge refusée',
  repo_config: 'Configuration du dépôt invalide',
  dead_letter: 'Événement mis de côté',
  pr_closed: 'PR fermée sans merge',
  stopped: 'Stopped on request',
  other: 'Autre cause',
};

const pad = (n: number) => String(n).padStart(2, '0');

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${pad(seconds % 60)} s`;
  return `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min`;
}

const decimal = (n: number, digits = 1) => n.toFixed(digits).replace('.', ',');

export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  return n < 1_000_000 ? `${decimal(n / 1_000)} k` : `${decimal(n / 1_000_000)} M`;
}

/** The measure of the ticket; the cost in dollars is what exists when no attempt reported tokens (ORC-216). */
export function tokensCell(run: WorkingRunView): { text: string; title: string } {
  if (!run.measured) return { text: '?', title: 'Les mesures de ce ticket sont illisibles : voir le journal.' };
  if (!run.tokens) {
    return { text: run.costUsd > 0 ? `— (${decimal(run.costUsd, 2)} $)` : '—', title: 'Aucune tentative terminée n’a rapporté ses tokens.' };
  }
  const { input, output, cacheRead, cacheCreation } = run.tokens;
  const missing = run.attemptsWithoutTokens > 0 ? `${run.attemptsWithoutTokens} tentative(s) terminée(s) sans mesure. ` : '';
  return {
    text: `${missing ? '≥ ' : ''}${formatTokens(input + output + cacheRead + cacheCreation)}`,
    title: `${missing}Entrée ${formatTokens(input)}, sortie ${formatTokens(output)}, cache lu ${formatTokens(cacheRead)}, cache écrit ${formatTokens(cacheCreation)}.`,
  };
}

function PrLink({ url }: { url?: string }) {
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
        {!waiting && <p className="empty">Rien n’attend un humain.</p>}
        {blocked.map((g) => <Group key={g.cause} label={CAUSE_LABELS[g.cause]} tone="blocked" tickets={g.tickets.map((ticket) => ({ ticket, detail: ticket.reason === CAUSE_LABELS[g.cause] ? undefined : ticket.reason }))} />)}
        {humanReview.length > 0 && <Group label="PR en Human Review" tone="human" tickets={humanReview.map((ticket) => ({ ticket }))} />}
        {gates.length > 0 && <Group label="Portes en attente" tone="human" tickets={gates.map((ticket) => ({ ticket, detail: 'Porte de merge' }))} />}
      </section>
      <section className="working">
        <h2>Working{flow.working.length > 0 && <span className="count">{flow.working.length}</span>}</h2>
        {flow.working.length > 0 ? (
          <table>
            <thead>
              <tr><th>Ticket</th><th>Étape</th><th className="num">Durée</th><th className="num">Tokens du ticket</th><th></th></tr>
            </thead>
            <tbody>
              {flow.working.map((run) => {
                const tokens = tokensCell(run);
                return (
                  <tr key={run.runId} className={run.runId === selectedRun ? 'selected' : ''}>
                    <td><button className="link" onClick={() => onSelect(run.runId)}>{run.ticketId}</button> {run.title} <PrLink url={run.prUrl} /></td>
                    <td className="step">{run.step}{run.verifying && ' · vérification'}</td>
                    <td className="num">{formatDuration(run.durationMs + elapsedMs)}</td>
                    <td className="num" title={tokens.title}>{tokens.text}</td>
                    <td className="actions">{run.stoppable && <button onClick={() => onStop(run)}>Stop</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="empty">Aucun run en cours.</p>}
        {flow.working.length > 0 && <p className="note">Tokens des tentatives terminées du ticket. Un run en cours compte à sa fin.</p>}
        {flow.queued.length > 0 && (
          <p className="queued"><span>En file</span> {flow.queued.map((q) => `${q.ticketId} (${q.job})`).join(', ')}</p>
        )}
      </section>
      <section className="done">
        <h2>Done</h2>
        {flow.done.length > 0 ? <TicketList tickets={flow.done.map((ticket) => ({ ticket }))} /> : <p className="empty">Aucun ticket terminé cette semaine.</p>}
        {flow.others.length > 0 && (
          <details>
            <summary>Autres tickets suivis ({flow.others.length})</summary>
            <TicketList tickets={flow.others.map((ticket) => ({ ticket }))} />
          </details>
        )}
      </section>
    </>
  );
}
