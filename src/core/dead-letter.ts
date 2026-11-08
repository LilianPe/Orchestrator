import { upcast, type StoredEvent } from './upcast.js';
import { TRUSTED, type EventPayloads, type FactoryEvent, type TicketState } from './types.js';

/**
 * The dead-letter of ORC-175: an inbox row whose decision throws (`decide` or `reduce`, a poison
 * event), or out of attempts (ORC-320), is set aside in `dead_letter` instead of being retried forever. Its ticket is blocked by
 * the decision of a `dead_letter.added` event, and `factory run repair` repairs it with a
 * `dead_letter.repaired` event: replayed, skipped or forced, each one journaled.
 */

/** What `factory run repair` does with a dead-lettered event. */
export type RepairAction = EventPayloads['dead_letter.repaired']['action'];

/** The status of a dead letter once repaired by each action. */
export const REPAIRED_STATUS = { replay: 'replayed', skip: 'skipped', force: 'forced' } as const satisfies Record<RepairAction, string>;
export const REPAIR_ACTIONS = Object.keys(REPAIRED_STATUS) as readonly RepairAction[];

/** `open` until repaired; then the last repair. A replay whose decision throws again reopens it. */
export type DeadLetterStatus = 'open' | (typeof REPAIRED_STATUS)[RepairAction];

/** The action as said to the operator and in the ticket's session. */
export const REPAIR_LABELS: Record<RepairAction, string> = { replay: 'replayed', skip: 'skipped', force: 'forced' };

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

/**
 * The block reason of `dead_letter.added`, naming the event: `Raison` of its standard comment (ORC-196). A row out of
 * attempts (`attempts`, ORC-320) may have failed for a store or a Linear down: its decision never came, none failed.
 * A row without the field threw in its decision, or was journaled before, and keeps its sentence.
 */
export function deadLetterReason(p: EventPayloads['dead_letter.added']): string {
  const what = p.attempts ? `${p.attempts} attempts without success` : 'its decision failed';
  return `Event ${p.eventId} set aside (${p.eventType}): ${what} (${p.error}).`;
}

/** What was tried, in the block's comment: `failures` counts the times it was set aside, not the attempts behind each. */
export function deadLetterTried(p: EventPayloads['dead_letter.added']): string {
  return p.attempts ? `${p.attempts} attempts to process this event.` : `${p.failures} decision(s) of this event.`;
}

/** Blocked by that dead-lettered event (ORC-345: by its kind and event, not its reason): its repair lifts that block, not another one. */
const blockedByDeadLetter = (t: TicketState, eventId: string): boolean => t.blocked && t.blockKind === 'dead_letter' && t.blockedEvent === eventId;

/** The ticket with the block of a dead-lettered event lifted, or as it is when blocked by anything else (`decide` and `reduce` of a repair). */
export function liftDeadLetterBlock<T extends TicketState | undefined>(t: T, eventId: string): T {
  return t && blockedByDeadLetter(t, eventId) ? { ...t, blocked: false, blockReason: undefined, blockKind: undefined, blockedEvent: undefined } : t;
}

/** The event a dead-lettered row is about: a failed repair is the event it repairs, not a new dead letter. */
export function deadLetteredEvent(row: StoredEvent): StoredEvent {
  return row.type === 'dead_letter.repaired' ? (row.payload as EventPayloads['dead_letter.repaired']).event : row;
}

/** Prefix of the id of a refused event's notice: unlike a dead letter's, its effects dying blocks nothing. */
const REFUSED_NOTICE = 'refused:';

/** The event `effect.failed` reports on is a refused event's notice. */
export const isRefusedNotice = (eventId: string): boolean => eventId.startsWith(REFUSED_NOTICE);

/** What a human reads in the ticket's session of an event the store refused (ORC-316). */
export function heldMessage(p: EventPayloads['dead_letter.added'], refused: string, holder: string, ticketId: string): string {
  return `Event ${p.eventId} (${p.eventType}) refused for the project ${refused}: this ticket is held by the project ${holder}, nothing changes on it. A maintainer can close it: \`factory run repair ${ticketId} skip ${p.eventId}\`.`;
}

/** Whether a dead-lettered event gets the event that blocks its ticket (`deadLetterNotice`). */
export const hasNotice = (event: StoredEvent): event is StoredEvent & { ticketId: string } => event.type !== 'dead_letter.added' && event.ticketId !== undefined;

/**
 * The event that blocks the ticket of a dead-lettered event, written to the inbox in the transaction
 * that sets it aside: `dead-letter:<event id>:<failures>`. None for a `dead_letter.added` itself (its
 * decision threw: blocking again would throw again), nor for an event without a ticket. An event the
 * store refused (`holder`, ORC-316) has no ticket of its own to block: its notice, `refused:<event id>:<failures>`,
 * goes to the holder's, which it only tells. `attempts`: a row out of its attempts, how many it had (ORC-320).
 */
export function deadLetterNotice(dl: Pick<DeadLetter, 'event' | 'error' | 'failures'>, at: number, holder?: string, attempts?: number): FactoryEvent | undefined {
  const { event } = dl;
  if (!hasNotice(event)) return undefined;
  const session = (event.payload as { linearSessionId?: string }).linearSessionId;
  const refused = holder === undefined ? {} : { refused: { projectId: event.projectId, ...(session ? { linearSessionId: session } : {}) } };
  return {
    ...TRUSTED,
    id: `${holder === undefined ? 'dead-letter:' : REFUSED_NOTICE}${event.id}:${dl.failures}`,
    type: 'dead_letter.added',
    at,
    projectId: holder ?? event.projectId,
    ticketId: event.ticketId,
    payload: { eventId: event.id, eventType: event.type, error: dl.error, failures: dl.failures, ...(attempts ? { attempts } : {}), ...refused },
  };
}

/**
 * The repair of a dead letter, written to the inbox by `factory run repair` (`repair:<event id>:<failures>`)
 * and decided like any event, so the repair is journaled. It carries the event as stored, whatever
 * the action: a repair whose decision throws reopens that event's dead letter.
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
    payload: { eventId: event.id, action, by, event },
  };
}

/**
 * The event a `replay` or `force` repair applies, upcast (it may throw, as it did when it was
 * dead-lettered: the repair is then dead-lettered in turn); none for a `skip`.
 */
export function repairedEvent(e: FactoryEvent<'dead_letter.repaired'>): FactoryEvent | undefined {
  return e.payload.action === 'skip' ? undefined : upcast(e.payload.event);
}

/** The event a decision is about: the one a `replay` or `force` repair applies, else the event itself. */
export function effectiveEvent(event: FactoryEvent): FactoryEvent {
  // Never nested: a failed repair is dead-lettered as the event it repairs (`deadLetteredEvent`).
  return (event.type === 'dead_letter.repaired' && repairedEvent(event)) || event;
}
