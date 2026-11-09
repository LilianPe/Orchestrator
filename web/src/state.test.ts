import { describe, expect, it } from 'vitest';
import { feedKey, initialState, reducer } from './state.js';
import type { FlowView, Snapshot } from './types.js';

const snapshot: Snapshot = {
  paused: false, linearConnected: true, queue: [], activeRuns: [{ id: 'r1', ticketId: 'REL-1', job: 'dev', startedAt: 1, turns: 0, costUsd: 0 }],
  costTodayUsd: 1.5, capacity: { dev: { used: 1, total: 3 }, questions: { used: 0, total: 2 } },
};

describe('reducer', () => {
  it('loads a snapshot and selects the active run', () => {
    const s = reducer(initialState, { type: 'snapshot', snapshot });
    expect(s.snapshot).toBe(snapshot);
    expect(s.selectedRun).toBe('r1');
  });

  it('keeps the Flow with the time it was received, its durations go on from there (ORC-297)', () => {
    const flow: FlowView = { needsYou: { blocked: [], humanReview: [], gates: [] }, working: [], queued: [], done: [], others: [] };
    const s = reducer(initialState, { type: 'flow', flow, at: 42 });
    expect(s.flow).toBe(flow);
    expect(s.flowAt).toBe(42);
  });

  it('says when the Flow could not be read, keeps the last one, and forgets it at the next read (ORC-297)', () => {
    const flow: FlowView = { needsYou: { blocked: [], humanReview: [], gates: [] }, working: [], queued: [], done: [], others: [] };
    let s = reducer(initialState, { type: 'flow', flow, at: 42 });
    s = reducer(s, { type: 'flowFailed' });
    expect(s.flowFailed).toBe(true);
    expect(s.flow).toBe(flow);
    s = reducer(s, { type: 'flow', flow, at: 43 });
    expect(s.flowFailed).toBe(false);
  });

  it('marks the Flow stale on a ticket update: the page reads it again (ORC-297)', () => {
    let s = reducer(initialState, { type: 'snapshot', snapshot });
    const stale = s.flowStale;
    s = reducer(s, { type: 'bus', message: { kind: 'event', event: { id: 'e1', type: 'status.changed', at: 5, projectId: 'p', ticketId: 'REL-1', payload: {} } } });
    expect(s.flowStale).toBe(stale);
    s = reducer(s, { type: 'bus', message: { kind: 'ticket' } });
    expect(s.flowStale).toBe(stale + 1);
  });

  it('applies run lines and events', () => {
    let s = reducer(initialState, { type: 'snapshot', snapshot });
    s = reducer(s, { type: 'bus', message: { kind: 'run', runId: 'r1', ticketId: 'REL-1', ev: { kind: 'text', text: 'Bonjour' } } });
    expect(s.runLines['r1']).toEqual([{ kind: 'text', text: 'Bonjour' }]);
    s = reducer(s, { type: 'bus', message: { kind: 'event', event: { id: 'e1', type: 'status.changed', at: 5, projectId: 'p', ticketId: 'REL-1', payload: {} } } });
    expect(s.events[0]!.id).toBe('e1');
    s = reducer(s, { type: 'bus', message: { kind: 'log', level: 'info', message: 'ping', at: 1 } });
    expect(s.logs).toEqual([]);
  });

  it('caps run lines at 400', () => {
    let s = reducer(initialState, { type: 'snapshot', snapshot });
    for (let i = 0; i < 450; i++) s = reducer(s, { type: 'bus', message: { kind: 'run', runId: 'r1', ticketId: 'REL-1', ev: { kind: 'text', text: String(i) } } });
    expect(s.runLines['r1']).toHaveLength(400);
    expect(s.runLines['r1']![0]).toEqual({ kind: 'text', text: '50' });
  });

  describe("a run's live feed (ORC-301)", () => {
    const activity = (runId: string, ticketId: string, action: string, at: number, projectId = 'p') =>
      ({ kind: 'activity', projectId, runId, ticketId, activity: { type: 'action', action, parameter: 'step build', ephemeral: true }, at }) as const;

    it("keeps, by ticket, the factory's composed activities and the ticket's journal events, in their order", () => {
      let s = reducer(initialState, { type: 'bus', message: activity('r1', 'REL-1', 'Reading the code', 1) });
      s = reducer(s, { type: 'bus', message: { kind: 'event', event: { id: 'e1', type: 'control.stop', at: 2, projectId: 'p', ticketId: 'REL-1', payload: {} } } });
      s = reducer(s, { type: 'bus', message: activity('r2', 'REL-2', 'Editing files', 3) });
      s = reducer(s, { type: 'bus', message: { kind: 'event', event: { id: 'e2', type: 'control.pause', at: 4, projectId: '*', payload: {} } } });
      expect(s.feeds[feedKey('p', 'REL-1')]).toEqual([
        { kind: 'activity', runId: 'r1', action: 'Reading the code', parameter: 'step build', at: 1 },
        { kind: 'event', id: 'e1', type: 'control.stop', at: 2 },
      ]);
      expect(s.feeds[feedKey('p', 'REL-2')]).toEqual([{ kind: 'activity', runId: 'r2', action: 'Editing files', parameter: 'step build', at: 3 }]);
      expect(Object.keys(s.feeds).sort()).toEqual([feedKey('p', 'REL-1'), feedKey('p', 'REL-2')]);
    });

    it('keeps apart the same ticket identifier in two projects (ORC-316)', () => {
      let s = reducer(initialState, { type: 'bus', message: activity('r1', 'REL-1', 'Reading the code', 1, 'p1') });
      s = reducer(s, { type: 'bus', message: { kind: 'event', event: { id: 'e1', type: 'run.finished', at: 2, projectId: 'p2', ticketId: 'REL-1', payload: {} } } });
      expect(s.feeds[feedKey('p1', 'REL-1')]).toHaveLength(1);
      expect(s.feeds[feedKey('p2', 'REL-1')]).toEqual([{ kind: 'event', id: 'e1', type: 'run.finished', at: 2 }]);
    });

    it('keeps the feeds of the 50 tickets heard of last', () => {
      let s = initialState;
      for (let i = 0; i < 60; i++) s = reducer(s, { type: 'bus', message: activity('r', `REL-${i}`, 'Reading the code', i) });
      expect(Object.keys(s.feeds)).toHaveLength(50);
      expect(s.feeds[feedKey('p', 'REL-9')]).toBeUndefined();
      // Heard of again, the oldest kept goes last: the next new ticket drops the one after it.
      s = reducer(s, { type: 'bus', message: activity('r', 'REL-10', 'Reading the code', 99) });
      s = reducer(s, { type: 'bus', message: activity('r', 'REL-60', 'Reading the code', 100) });
      expect(Object.keys(s.feeds)).toHaveLength(50);
      expect(s.feeds[feedKey('p', 'REL-11')]).toBeUndefined();
      expect(s.feeds[feedKey('p', 'REL-10')]).toHaveLength(2);
    });

    it('caps a feed at its last 200 lines', () => {
      let s = initialState;
      for (let i = 0; i < 250; i++) s = reducer(s, { type: 'bus', message: activity('r1', 'REL-1', 'Reading the code', i) });
      expect(s.feeds[feedKey('p', 'REL-1')]).toHaveLength(200);
      expect(s.feeds[feedKey('p', 'REL-1')]![0]!.at).toBe(50);
    });
  });
});
