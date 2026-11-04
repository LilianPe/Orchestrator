import type { Workflow } from '../config/workflow-schema.js';
import type { DecisionPlan, TimerRecord } from '../store/types.js';
import { effectiveEvent } from './dead-letter.js';
import type { OutboxEffect } from './decision.js';
import { AUTHZ_REFUSED, decide, isFenced, isReconcileTicket } from './engine.js';
import type { Decision } from './decision.js';
import { reduce } from './reduce.js';
import { CREATES_TICKET, type EventType, type FactoryEvent, type TicketState } from './types.js';

/** Events after which `handle` settles the ticket: the pending job starts once nothing is in flight. */
export const SETTLES_RUN: ReadonlySet<EventType> = new Set<EventType>(['run.finished', 'run.lost', 'verify.passed', 'verify.failed']);

/** The log line of an action the authorization matrix refused (ORC-186); the refusal itself is in the trace. */
function refusedNote(event: FactoryEvent, trace: readonly string[]): string | undefined {
  const refused = trace.find((t) => t.startsWith(AUTHZ_REFUSED));
  return refused && `${event.type} ${event.id} on ${event.ticketId ?? '*'}: ${refused}`;
}

/** A decision that writes nothing (an event of an unknown project). */
export const NO_PLAN: DecisionPlan = { effects: [], timers: [], clearTimers: false };

export interface PlanInput {
  event: FactoryEvent;
  /** The projection read under the ticket's lock. */
  known: TicketState | undefined;
  /** The workflow the ticket is frozen on, and its hash (`workflowHash` of the new projection). */
  workflow: Workflow;
  hash: string;
  /** The decider's clock: `updatedAt` of the projection, base of the timers. */
  now: number;
}

/**
 * Pure: what the decision transaction of an event writes (ORC-149), from the projection, the event,
 * the frozen workflow and the clock alone. `decide`, then `reduce` of the event and of the decided
 * events. The worker runs it under the ticket's lock; the replay oracle (ORC-174) runs it again on
 * what the decision recorded, and must find the same plan.
 */
export function planDecision({ event, known, workflow, hash, now }: PlanInput): DecisionPlan {
  if (event.projectId === '*') return { ...NO_PLAN, effects: decide(undefined, event, workflow).effects, at: now };
  // A repair that replays or forces an event (ORC-175) is planned as that event would be.
  const decided = effectiveEvent(event);
  // The project's reconciliation (ORC-185): no ticket to manage, but its effect runs and its next timer is armed.
  if (event.ticketId && isReconcileTicket(event.ticketId)) {
    const d = decide(undefined, event, workflow);
    return { ...NO_PLAN, effects: d.effects, timers: timerRecords(d, event, event.ticketId, now), at: now, trace: d.trace };
  }
  if (!known && event.ticketId && !CREATES_TICKET.has(decided.type)) {
    return { ...NO_PLAN, at: now, note: `ignored ${event.type} for unmanaged ticket ${event.ticketId}` };
  }
  const decision = decide(known, event, workflow);
  let next = reduce(known, event);
  for (const e of decision.events) next = reduce(next, e);
  const ticket = next && { ...next, updatedAt: now, workflowHash: hash };
  const effects: OutboxEffect[] = [...decision.effects];
  // After the effects, as before: start the ticket's pending job, then drain the queues.
  if (ticket && SETTLES_RUN.has(decided.type)) effects.push({ kind: 'settle' });
  return {
    ticket,
    effects,
    timers: ticket ? timerRecords(decision, event, ticket.ticketId, now) : [],
    // A stop deletes the ticket's timers before this decision arms its own, as `stop_run` did.
    clearTimers: decision.effects.some((c) => c.kind === 'stop_run' && !c.linearSessionId),
    at: now,
    trace: decision.trace,
    note: isFenced(decision) ? `ignored stale ${event.type} for ${event.ticketId ?? '*'}: ${decision.trace[0]}` : refusedNote(event, decision.trace),
  };
}

/** The timers a decision arms, as the store keeps them: keyed `<ticket>:<slot>`, due `ms` from now, armed by the event. */
function timerRecords(decision: Decision, event: FactoryEvent, ticketId: string, now: number): TimerRecord[] {
  return decision.timers.map(({ slot, ms, ...fired }) => ({ key: `${ticketId}:${slot}`, projectId: event.projectId, ticketId, ...fired, fireAt: now + ms, armedBy: event.id }) as TimerRecord);
}
