import type { RunStreamEvent } from '../adapters/runner/types.js';
import type { ActivityInput } from '../adapters/tracker/types.js';
import type { Effect } from './decision.js';
import type { FactoryEvent, TicketState } from './types.js';

export type BusMessage =
  | { kind: 'event'; event: FactoryEvent }
  | { kind: 'command'; projectId: string; ticketId?: string; command: Effect }
  | { kind: 'run'; runId: string; ticketId: string; ev: RunStreamEvent }
  /** What a run does, in the factory's words (`composedActivity`, ORC-214): the dashboard's live feed of a run (ORC-301). */
  | { kind: 'activity'; runId: string; ticketId: string; activity: ActivityInput; at: number }
  | { kind: 'ticket'; ticket: TicketState }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string; at: number };

export class EventBus {
  private subs = new Set<(m: BusMessage) => void>();

  subscribe(fn: (m: BusMessage) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  publish(m: BusMessage): void {
    for (const fn of this.subs) {
      try {
        fn(m);
      } catch {
        // a broken subscriber must never break the orchestrator
      }
    }
  }
}
