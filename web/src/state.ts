import type { BusMessage, EventView, FlowView, RunLine, Snapshot } from './types.js';

export interface UiState {
  connected: boolean;
  snapshot?: Snapshot;
  flow?: FlowView;
  /** When `flow` was received: its durations go on from there. */
  flowAt: number;
  /** Bumped by each ticket update: the page reads the Flux again. */
  flowStale: number;
  runLines: Record<string, RunLine[]>;
  events: EventView[];
  logs: { level: string; message: string; at: number }[];
  selectedRun?: string;
}

export type Action =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'flow'; flow: FlowView; at: number }
  | { type: 'bus'; message: BusMessage }
  | { type: 'select'; runId?: string }
  | { type: 'connection'; connected: boolean };

export const initialState: UiState = { connected: false, flowAt: 0, flowStale: 0, runLines: {}, events: [], logs: [] };

export function reducer(s: UiState, a: Action): UiState {
  switch (a.type) {
    case 'snapshot':
      return { ...s, snapshot: a.snapshot, selectedRun: s.selectedRun ?? a.snapshot.activeRuns[0]?.id };
    case 'flow':
      return { ...s, flow: a.flow, flowAt: a.at };
    case 'select':
      return { ...s, selectedRun: a.runId };
    case 'connection':
      return { ...s, connected: a.connected };
    case 'bus': {
      const m = a.message;
      if (m.kind === 'ticket') return { ...s, flowStale: s.flowStale + 1 };
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
