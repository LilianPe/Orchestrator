import type { Effect } from './decide.ts';

const apiUrl = process.env.FAKE_API_URL ?? 'http://127.0.0.1:4129';

/** Executes one effect against the fake external API, keyed by the effect id. */
export async function runEffect(id: string, effect: Effect): Promise<{ commentId: string }> {
  const res = await fetch(`${apiUrl}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': id },
    body: JSON.stringify(effect),
  });
  if (!res.ok) throw new Error(`fake api ${res.status}`);
  return (await res.json()) as { commentId: string };
}

export const delegated = (n: number) => ({
  id: `linear:delivery-${n}`,
  ticket: 'ORC-1',
  type: 'ticket.delegated' as const,
  payload: { title: 'Ajouter un bouton' },
});
