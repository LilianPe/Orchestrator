import type { BusMessage, EventView, RunLine, Snapshot, TicketView } from './types.js';

export interface UiState {
  connected: boolean;
  snapshot?: Snapshot;
  tickets: Record<string, TicketView>;
  runLines: Record<string, RunLine[]>;
  events: EventView[];
  logs: { level: string; message: string; at: number }[];
  selectedRun?: string;
}

export type Action =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'bus'; message: BusMessage }
  | { type: 'select'; runId?: string }
  | { type: 'connection'; connected: boolean };

export const initialState: UiState = { connected: false, tickets: {}, runLines: {}, events: [], logs: [] };

const key = (t: TicketView) => `${t.projectId}/${t.ticketId}`;

export function reducer(s: UiState, a: Action): UiState {
  switch (a.type) {
    case 'snapshot':
      return {
        ...s,
        snapshot: a.snapshot,
        tickets: Object.fromEntries(a.snapshot.tickets.map((t) => [key(t), t])),
        selectedRun: s.selectedRun ?? a.snapshot.activeRuns[0]?.id,
      };
    case 'select':
      return { ...s, selectedRun: a.runId };
    case 'connection':
      return { ...s, connected: a.connected };
    case 'bus': {
      const m = a.message;
      if (m.kind === 'ticket') return { ...s, tickets: { ...s.tickets, [key(m.ticket)]: m.ticket } };
      if (m.kind === 'run') {
        const lines = [...(s.runLines[m.runId] ?? []), m.ev].slice(-400);
        return { ...s, runLines: { ...s.runLines, [m.runId]: lines }, selectedRun: s.selectedRun ?? m.runId };
      }
      if (m.kind === 'event') return { ...s, events: [m.event, ...s.events].slice(0, 100) };
      if (m.kind === 'log' && m.message !== 'ping') return { ...s, logs: [{ level: m.level, message: m.message, at: m.at }, ...s.logs].slice(0, 50) };
      return s;
    }
  }
}
