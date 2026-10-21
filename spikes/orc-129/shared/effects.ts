import type { Effect, EngineEvent } from './decide.ts';

export const FAKE_API = 'http://127.0.0.1:4129';

/** Executes one effect against the fake external API, keyed by the effect id. */
export async function runEffect(id: string, effect: Effect): Promise<{ commentId: string }> {
  const res = await fetch(`${FAKE_API}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': id },
    body: JSON.stringify(effect),
  });
  if (!res.ok) throw new Error(`fake api ${res.status}`);
  return (await res.json()) as { commentId: string };
}

export const delegated = (n: number): EngineEvent => ({
  id: `linear:delivery-${n}`,
  ticket: 'ORC-1',
  type: 'ticket.delegated',
  payload: { title: 'Ajouter un bouton' },
});

/** The result of an effect, as it re-enters the engine; its id dedups it. */
export const effectDone = (id: string, ticket: string, result: { commentId: string }): EngineEvent => ({
  id: `effect:${id}`,
  ticket,
  type: 'effect.done',
  payload: { effectId: id, result },
});
