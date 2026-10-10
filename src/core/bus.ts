import type { RunStreamEvent } from '../adapters/runner/types.js';
import type { Command } from './commands.js';
import type { RelaisEvent, TicketState } from './types.js';

export type BusMessage =
  | { kind: 'event'; event: RelaisEvent }
  | { kind: 'command'; projectId: string; ticketId?: string; command: Command }
  | { kind: 'run'; runId: string; ticketId: string; ev: RunStreamEvent }
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
