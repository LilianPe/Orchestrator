import { useState } from 'react';
import type { MaturityCardView } from './types.js';

const time = (at: number) => new Date(at).toLocaleString('en-US');

/** A card: its title and value, approved by whom and when, or a button to approve the value as it stands. */
function Card({ card, onApprove }: { card: MaturityCardView; onApprove: (c: MaturityCardView) => Promise<boolean> }) {
  const [sending, setSending] = useState(false);
  const approve = () => {
    setSending(true);
    void onApprove(card).finally(() => setSending(false));
  };
  return (
    <li className="maturity-card">
      <strong>{card.title}</strong>
      <pre>{card.value}</pre>
      {card.approvedBy === undefined ? (
        <button onClick={approve} disabled={sending}>Approve</button>
      ) : (
        <p className="note">Approved by {card.approvedBy}{card.approvedAt === undefined ? '' : ` on ${time(card.approvedAt)}`}</p>
      )}
    </li>
  );
}

/** The maturity report of each project (ORC-410): one card per point `factory init` detected, to approve. */
export function Maturity({ cards, onApprove, notice }: { cards: MaturityCardView[]; onApprove: (c: MaturityCardView) => Promise<boolean>; notice?: string }) {
  const projects = [...new Set(cards.map((c) => c.projectId))];
  return (
    <div className="measures">
      {notice && <p className="note" role="status">{notice}</p>}
      {projects.length ? (
        projects.map((p) => (
          <section key={p}>
            <h2>{p}</h2>
            <ul className="maturity-cards">
              {cards.filter((c) => c.projectId === p).map((c) => <Card key={c.key} card={c} onApprove={onApprove} />)}
            </ul>
            <p className="note">Detected by factory init on {time(Math.max(...cards.filter((c) => c.projectId === p).map((c) => c.detectedAt)))}. Running it again keeps an approval only on a value unchanged.</p>
          </section>
        ))
      ) : (
        <section><p className="empty">No maturity report yet: run factory init on a repository without .factory/config.yml.</p></section>
      )}
    </div>
  );
}
