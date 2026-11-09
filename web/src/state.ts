import type { BusMessage, EventView, FeedLine, FlowView, RunLine, Snapshot } from './types.js';

/** The lines a ticket's live feed keeps, the last ones, and the feeds kept, of the tickets most recently heard of. */
const FEED_MAX = 200;
const FEEDS_MAX = 50;

/** A ticket's key among the feeds: the same identifier can be a ticket in two projects (ORC-316). */
export const feedKey = (projectId: string, ticketId: string) => `${projectId}/${ticketId}`;

export interface UiState {
  connected: boolean;
  snapshot?: Snapshot;
  flow?: FlowView;
  /** When `flow` was received: its durations go on from there. */
  flowAt: number;
  /** The last read of the Flow failed: `flow`, if any, is out of date. */
  flowFailed: boolean;
  /** Bumped by each ticket update: the page reads the Flow again. */
  flowStale: number;
  runLines: Record<string, RunLine[]>;
  /** The live feed of each ticket since the page was opened (ORC-301), by `feedKey`: its runs' composed activities and its journal's events. */
  feeds: Record<string, FeedLine[]>;
  events: EventView[];
  logs: { level: string; message: string; at: number }[];
  selectedRun?: string;
}

export type Action =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'flow'; flow: FlowView; at: number }
  | { type: 'flowFailed' }
  | { type: 'bus'; message: BusMessage }
  | { type: 'select'; runId?: string }
  | { type: 'connection'; connected: boolean };

export const initialState: UiState = { connected: false, flowAt: 0, flowFailed: false, flowStale: 0, runLines: {}, feeds: {}, events: [], logs: [] };

function fed(s: UiState, key: string, line: FeedLine): UiState {
  const { [key]: lines = [], ...others } = s.feeds;
  // The ticket heard of last goes last: the first ones are dropped past the bound.
  const kept = Object.entries(others).slice(-(FEEDS_MAX - 1));
  return { ...s, feeds: { ...Object.fromEntries(kept), [key]: [...lines, line].slice(-FEED_MAX) } };
}

export function reducer(s: UiState, a: Action): UiState {
  switch (a.type) {
    case 'snapshot':
      return { ...s, snapshot: a.snapshot, selectedRun: s.selectedRun ?? a.snapshot.activeRuns[0]?.id };
    case 'flow':
      return { ...s, flow: a.flow, flowAt: a.at, flowFailed: false };
    case 'flowFailed':
      return { ...s, flowFailed: true };
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
      if (m.kind === 'activity') return fed(s, feedKey(m.projectId, m.ticketId), { kind: 'activity', runId: m.runId, action: m.activity.action, parameter: m.activity.parameter, at: m.at });
      if (m.kind === 'event') {
        const next = { ...s, events: [m.event, ...s.events].slice(0, 100) };
        return m.event.ticketId ? fed(next, feedKey(m.event.projectId, m.event.ticketId), { kind: 'event', id: m.event.id, type: m.event.type, at: m.event.at }) : next;
      }
      if (m.kind === 'log' && m.message !== 'ping') return { ...s, logs: [{ level: m.level, message: m.message, at: m.at }, ...s.logs].slice(0, 50) };
      return s;
    }
  }
}
