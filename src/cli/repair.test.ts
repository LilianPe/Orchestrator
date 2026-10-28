import { describe, expect, it } from 'vitest';
import { TRUSTED, type FactoryEvent } from '../core/types.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { REPAIR_USAGE, runRepair } from './repair.js';

const ev = (id: string, ticketId?: string): FactoryEvent =>
  ({ ...TRUSTED, id, type: 'label.changed', at: 1, projectId: ticketId ? 'p' : '*', ...(ticketId ? { ticketId } : {}), payload: { label: 'x', change: 'added' } }) as FactoryEvent;

async function withDeadLetters(...events: FactoryEvent[]) {
  const store = new SqliteStore(':memory:');
  for (const e of events) {
    await store.appendInbox(e);
    await store.deadLetter(e, `boom ${e.id}`, 10);
  }
  const lines: string[] = [];
  const repair = (target: string, action?: string, eventId?: string) =>
    runRepair({ store, target, action, eventId, by: 'armand', now: 20, print: (l) => void lines.push(l) });
  return { store, lines, repair };
}

describe('factory run repair (ORC-175)', () => {
  it('lists the dead letters of a ticket without an action', async () => {
    const { lines, repair } = await withDeadLetters(ev('l1', 'REL-1'));
    expect(await repair('REL-1')).toBe(0);
    expect(lines).toEqual(['Événements mis de côté pour REL-1 :', '  l1  label.changed  ouvert  (1 échec) boom l1']);
  });

  it('says when there is nothing to repair, and refuses an unknown action', async () => {
    const { lines, repair } = await withDeadLetters(ev('l1', 'REL-1'));
    expect(await repair('REL-2', 'skip')).toBe(1);
    expect(lines.pop()).toBe('Aucun événement mis de côté pour REL-2.');
    expect(await repair('REL-1', 'drop')).toBe(1);
    expect(lines.pop()).toBe(REPAIR_USAGE);
  });

  it('asks which event when the ticket has several open, and repairs the one named', async () => {
    const { store, lines, repair } = await withDeadLetters(ev('l1', 'REL-1'), ev('l2', 'REL-1'));
    expect(await repair('REL-1', 'skip')).toBe(1);
    expect(lines[0]).toBe('Plusieurs événements ouverts pour REL-1 : précisez lequel.');
    lines.length = 0;
    expect(await repair('REL-1', 'force', 'l2')).toBe(0);
    expect(lines).toEqual(['Événement l2 (label.changed) forcé par armand : réparation journalisée, décidée au prochain passage du démon.', 'Encore 1 événement ouvert pour REL-1.']);
    expect((await store.deadLetters('REL-1')).map((d) => [d.eventId, d.status])).toEqual([
      ['l1', 'open'],
      ['l2', 'forced'],
    ]);
    // Repaired already: nothing more to do with it.
    expect(await repair('REL-1', 'skip', 'l2')).toBe(1);
  });

  it('repairs an event without a ticket by its id', async () => {
    const { store, repair } = await withDeadLetters(ev('g1'));
    expect(await repair('g1', 'skip')).toBe(0);
    expect(await store.deadLetters()).toMatchObject([{ eventId: 'g1', status: 'skipped', resolvedBy: 'armand' }]);
    expect((await store.pendingInbox(10)).map((e) => e.id)).toEqual(['repair:g1:1']);
  });

  it('refuses to skip the result of a run, which would leave the ticket running', async () => {
    const finished = {
      ...TRUSTED, id: 'f1', type: 'run.finished', at: 1, projectId: 'p', ticketId: 'REL-1',
      payload: { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 0, turns: 1, lastText: '' },
    } as FactoryEvent;
    const { store, lines, repair } = await withDeadLetters(finished);
    expect(await repair('REL-1', 'skip')).toBe(1);
    expect(lines.pop()).toMatch(/^f1 \(run\.finished\) termine un run .* Utilisez force/);
    expect(await store.deadLetters('REL-1')).toMatchObject([{ status: 'open' }]);
    expect(await repair('REL-1', 'force')).toBe(0);
  });
});
