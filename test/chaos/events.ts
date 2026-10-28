import type { EventType } from '../../src/core/types.js';

/** Lease of a claimed outbox row in the chaos daemon, on the simulated clock: the driver moves past it after each kill. */
export const CHAOS_LEASE_MS = 60_000;

/** An event from Linear, as the driver sends it: the daemon stamps it with its clock. */
export interface ChaosEvent {
  id: string;
  type: EventType;
  projectId: string;
  ticketId: string;
  payload: object;
}

/** From the driver to the daemon. */
export type ChaosMessage = { type: 'event'; event: ChaosEvent } | { type: 'clock'; now: number };
/** From the daemon to the driver. */
export type DaemonMessage = { type: 'ready' } | { type: 'ack'; id: string } | { type: 'nack'; id: string };

export const ticketIds = (n: number): string[] => Array.from({ length: n }, (_, i) => `REL-${i + 1}`);

/** mulberry32: the same seed gives the same events and the same kill delays. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `count` events from Linear over `tickets` tickets, drawn from `random`: each ticket is delegated
 * first, then gets replies, questions, label changes (a stop, a restart), moves to AI review, and
 * now and then its delegation again (a webhook resent by Linear under a new delivery id).
 */
export function chaosEvents(random: () => number, count: number, tickets: number): ChaosEvent[] {
  const ids = ticketIds(tickets);
  const delegated = new Set<string>();
  const events: ChaosEvent[] = [];
  for (let n = 1; n <= count; n++) {
    const ticketId = ids[Math.floor(random() * ids.length)]!;
    const linearSessionId = `ls-${ticketId}`;
    const base = { id: `c-${n}`, projectId: 'p', ticketId };
    const r = random();
    let event: ChaosEvent;
    if (!delegated.has(ticketId) || r < 0.1) {
      delegated.add(ticketId);
      event = { ...base, type: 'ticket.delegated', payload: { linearSessionId } };
    } else if (r < 0.55) {
      event = { ...base, type: 'session.prompted', payload: { linearSessionId, body: `retour ${n}`, author: 'L' } };
    } else if (r < 0.65) {
      event = { ...base, type: 'session.mentioned', payload: { linearSessionId: `${linearSessionId}-q${n}`, body: `question ${n}`, author: 'L' } };
    } else if (r < 0.75) {
      event = { ...base, type: 'label.changed', payload: { label: 'agent:stop', change: 'added' } };
    } else if (r < 0.85) {
      event = { ...base, type: 'label.changed', payload: { label: 'agent:reprendre', change: 'added' } };
    } else {
      event = { ...base, type: 'status.changed', payload: { from: 'human_review', to: 'ai_review' } };
    }
    events.push(event);
  }
  return events;
}
