import { upcast, type StoredEvent } from './upcast.js';
import { TRUSTED, type EventPayloads, type FactoryEvent, type TicketState } from './types.js';

/**
 * The dead-letter of ORC-175: an inbox row whose decision throws (`decide` or `reduce`, a poison
 * event) is set aside in `dead_letter` instead of being retried forever. Its ticket is blocked by
 * the decision of a `dead_letter.added` event, and `factory run repair` repairs it with a
 * `dead_letter.repaired` event: replayed, skipped or forced, each one journaled.
 */

/** What `factory run repair` does with a dead-lettered event. */
export type RepairAction = EventPayloads['dead_letter.repaired']['action'];
export const REPAIR_ACTIONS: readonly RepairAction[] = ['replay', 'skip', 'force'];

/** `open` until repaired; then the last repair. A replay whose decision throws again reopens it. */
export type DeadLetterStatus = 'open' | 'replayed' | 'skipped' | 'forced';

export const REPAIRED_STATUS: Record<RepairAction, DeadLetterStatus> = { replay: 'replayed', skip: 'skipped', force: 'forced' };

export interface DeadLetter {
  eventId: string;
  projectId: string;
  ticketId?: string;
  /** The event as the inbox holds it. */
  event: StoredEvent;
  /** The error of its last failed decision. */
  error: string;
  /** Failed decisions of the event so far: a replay that throws again adds one. */
  failures: number;
  status: DeadLetterStatus;
  /** Who repaired it last (`factory run repair`). */
  resolvedBy?: string;
}

/** Prefix of the block reason of a dead-lettered event: its repair lifts that block, not another one. */
const reasonPrefix = (eventId: string) => `Événement ${eventId} mis de côté`;

/** The block reason of `dead_letter.added`: a simple message naming the event (the standard comment: ORC-196). */
export function deadLetterReason(p: EventPayloads['dead_letter.added']): string {
  return `${reasonPrefix(p.eventId)} (${p.eventType}) : sa décision a échoué (${p.error}).`;
}

export function blockedByDeadLetter(t: TicketState, eventId: string): boolean {
  return t.blocked && (t.blockReason?.startsWith(`${reasonPrefix(eventId)} (`) ?? false);
}

/** The event a dead-lettered row is about: a failed repair is the event it repairs, not a new dead letter. */
export function deadLetteredEvent(row: StoredEvent): StoredEvent {
  if (row.type !== 'dead_letter.repaired') return row;
  return (row.payload as EventPayloads['dead_letter.repaired']).event ?? row;
}

/**
 * The event that blocks the ticket of a dead-lettered event, written to the inbox in the transaction
 * that sets it aside: `dead-letter:<event id>:<failures>`. None for a `dead_letter.added` itself (its
 * decision threw: blocking again would throw again), nor for an event without a ticket.
 */
export function deadLetterNotice(dl: Pick<DeadLetter, 'event' | 'error' | 'failures'>, at: number): FactoryEvent | undefined {
  const { event } = dl;
  if (event.type === 'dead_letter.added' || event.ticketId === undefined) return undefined;
  return {
    ...TRUSTED,
    id: `dead-letter:${event.id}:${dl.failures}`,
    type: 'dead_letter.added',
    at,
    projectId: event.projectId,
    ticketId: event.ticketId,
    payload: { eventId: event.id, eventType: event.type, error: dl.error, failures: dl.failures },
  };
}

/**
 * The repair of a dead letter, written to the inbox by `factory run repair` (`repair:<event id>:<failures>`)
 * and decided like any event, so the repair is journaled. `replay` carries the event to decide again,
 * `force` the event whose facts are recorded without its decision; `skip` carries none.
 */
export function repairEvent(dl: Pick<DeadLetter, 'event' | 'failures'>, action: RepairAction, by: string, at: number): FactoryEvent<'dead_letter.repaired'> {
  const { event } = dl;
  return {
    ...TRUSTED,
    id: `repair:${event.id}:${dl.failures}`,
    type: 'dead_letter.repaired',
    at,
    projectId: event.projectId,
    ...(event.ticketId === undefined ? {} : { ticketId: event.ticketId }),
    payload: { eventId: event.id, action, by, ...(action === 'skip' ? {} : { event: upcast(event) }) },
  };
}

/** The event a decision is about: the one a `replay` or `force` repair carries, else the event itself. */
export function effectiveEvent(event: FactoryEvent): FactoryEvent {
  return event.type === 'dead_letter.repaired' && event.payload.event ? effectiveEvent(event.payload.event) : event;
}
