import { useState } from 'react';
import type { MaturityCardView } from './types.js';
import { uncheckedMain } from '../../src/core/maturity.js';

const time = (at: number) => new Date(at).toLocaleString('en-US');

/** What the page says once the server answered an approval (ORC-454): who holds it and since when, an earlier approval by someone else included. */
export const approvalNotice = (card: MaturityCardView) =>
  card.approvedBy === undefined ? `${card.title} approved.` : `${card.title} approved by ${card.approvedBy}${card.approvedAt === undefined ? '' : ` on ${time(card.approvedAt)}`}.`;

/**
 * A card: its title and value, approved by whom and when, or a button to approve the value as it stands; none for the `main`
 * card not checked yet (ORC-437), which the server refuses too.
 */
function Card({ card, onApprove }: { card: MaturityCardView; onApprove: (c: MaturityCardView) => Promise<void> }) {
  const [sending, setSending] = useState(false);
  const approve = () => {
    setSending(true);
    void onApprove(card).finally(() => setSending(false));
  };
  return (
    <li className="maturity-card">
      <strong>{card.title}</strong>
      <pre>{card.value}</pre>
      {card.approvedBy !== undefined ? (
        <p className="note">Approved by {card.approvedBy}{card.approvedAt === undefined ? '' : ` on ${time(card.approvedAt)}`}</p>
      ) : uncheckedMain(card) ? (
        <p className="note">To approve once checked: factory dry-run {card.projectId}</p>
      ) : (
        <button onClick={approve} disabled={sending}>Approve</button>
      )}
    </li>
  );
}

/** The maturity report of each project (ORC-410): one card per point `factory init` detected, to approve. */
export function Maturity({ cards, onApprove, notice }: { cards: MaturityCardView[]; onApprove: (c: MaturityCardView) => Promise<void>; notice?: string }) {
  const projects = new Map<string, MaturityCardView[]>();
  for (const c of cards) projects.set(c.projectId, [...(projects.get(c.projectId) ?? []), c]);
  return (
    <div className="measures">
      {notice && <p className="note" role="status">{notice}</p>}
      {projects.size ? (
        [...projects].map(([p, own]) => (
          <section key={p}>
            <h2>{p}</h2>
            <ul className="maturity-cards">
              {own.map((c) => <Card key={c.key} card={c} onApprove={onApprove} />)}
            </ul>
            <p className="note">Detected by factory init on {time(own[0]!.detectedAt)}. Running it again keeps an approval only on a value unchanged.</p>
          </section>
        ))
      ) : (
        <section><p className="empty">No maturity report yet: run factory init on a repository without .factory/config.yml.</p></section>
      )}
    </div>
  );
}
