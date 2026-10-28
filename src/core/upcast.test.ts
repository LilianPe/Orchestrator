import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { decide } from './engine.js';
import { newTicketState, SCHEMA_VERSION, type FactoryEvent } from './types.js';
import { upcast, upcastTimer, type StoredEvent } from './upcast.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });
const ticket = { ...newTicketState('p', 'REL-1', 'T', 'human_review', 0), delegated: true };

/** Journal rows as the factory wrote them before ORC-133: no version, no taint, former names. */
const v1 = {
  moved: { id: 'linear:d1', type: 'ticket.moved', at: 5, projectId: 'p', ticketId: 'REL-1', payload: { from: 'human_review', to: 'ai_review' } },
  label: { id: 'linear:d2', type: 'label.added', at: 6, projectId: 'p', ticketId: 'REL-1', payload: { label: 'agent:stop' } },
  prompted: { id: 'linear:d3', type: 'session.prompted', at: 7, projectId: 'p', ticketId: 'REL-1', payload: { linearSessionId: 's1', body: 'ok', author: 'L' } },
} satisfies Record<string, StoredEvent>;

describe('upcast', () => {
  it('reads a version 1 event as the current version: renamed type, version and taint set', () => {
    expect(upcast(v1.moved)).toEqual({ ...v1.moved, type: 'status.changed', schemaVersion: SCHEMA_VERSION, taint: 'trusted' });
    expect(upcast(v1.label)).toEqual({
      ...v1.label,
      type: 'label.changed',
      payload: { label: 'agent:stop', change: 'added' },
      schemaVersion: SCHEMA_VERSION,
      taint: 'trusted',
    });
    expect(upcast(v1.prompted)).toEqual({ ...v1.prompted, schemaVersion: SCHEMA_VERSION, taint: 'trusted' });
  });

  it('keeps the taint of a row that has one without a version', () => {
    expect(upcast({ ...v1.prompted, taint: 'untrusted' }).taint).toBe('untrusted');
  });

  it('leaves a current event as it is', () => {
    const current = upcast(v1.moved);
    expect(upcast(current)).toBe(current);
  });

  it('refuses an event written by a newer factory', () => {
    expect(() => upcast({ ...v1.moved, schemaVersion: SCHEMA_VERSION + 1 })).toThrow(/newer/);
  });

  it('makes a version 1 journal readable by decide, with the same decisions as the current events', async () => {
    const store = new SqliteStore(':memory:');
    for (const e of Object.values(v1)) await store.recordEvent(e as unknown as FactoryEvent);
    const replayed = (await store.recentEvents(10)).reverse().map((e) => upcast(e as StoredEvent));
    expect(replayed.map((e) => e.type)).toEqual(['status.changed', 'label.changed', 'session.prompted']);
    const effects = replayed.map((e) => decide(ticket, e, workflow).effects.map((c) => c.kind));
    expect(effects).toEqual([['start_run'], ['stop_run', 'activity'], []]);
  });

  it('reads the debounce of a job (versions 1 and 2) as a timer.fired of kind debounce, with the same decision (ORC-161)', () => {
    const v2 = { id: 'timer:REL-1:dev-feedback:180000', type: 'debounce.fired', at: 180_000, projectId: 'p', ticketId: 'REL-1', schemaVersion: 2, taint: 'trusted' as const, payload: { job: 'dev-feedback' } };
    const timer = { type: 'timer.fired', schemaVersion: SCHEMA_VERSION, payload: { kind: 'debounce', payload: { job: 'dev-feedback' } } };
    expect(upcast(v2)).toEqual({ ...v2, ...timer });
    const { schemaVersion: _v, taint: _t, ...unversioned } = v2;
    expect(upcast(unversioned)).toEqual({ ...v2, ...timer });
    expect(decide(ticket, upcast(v2), workflow).effects).toEqual([{ kind: 'start_run', job: 'dev-feedback', input: 'feedback' }]);
  });

  it('reads a job-bound timer as a debounce of that job, key unchanged, and a generic one as it is (ORC-161)', () => {
    const old = { key: 'REL-1:dev-feedback', projectId: 'p', ticketId: 'REL-1', job: 'dev-feedback', fireAt: 900, armedBy: 'e1' };
    const { job: _j, ...rest } = old;
    const generic = { ...rest, kind: 'debounce' as const, payload: { job: 'dev-feedback' } };
    expect(upcastTimer(old)).toEqual(generic);
    expect(upcastTimer(generic)).toBe(generic);
  });
});
