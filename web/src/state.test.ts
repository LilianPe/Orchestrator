import { describe, expect, it } from 'vitest';
import { initialState, reducer } from './state.js';
import type { FlowView, Snapshot } from './types.js';

const snapshot: Snapshot = {
  paused: false, linearConnected: true, queue: [], activeRuns: [{ id: 'r1', ticketId: 'REL-1', job: 'dev', startedAt: 1, turns: 0, costUsd: 0 }],
  costTodayUsd: 1.5, budgetUsd: 20, capacity: { dev: { used: 1, total: 3 }, questions: { used: 0, total: 2 } },
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
});
