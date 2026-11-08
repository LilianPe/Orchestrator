import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { causeOf } from './block-cause.js';
import { deadLetterReason, liftDeadLetterBlock } from './dead-letter.js';
import { decide, settledTicket } from './engine.js';
import { newTicketState, SCHEMA_VERSION, type FactoryEvent, type TicketState } from './types.js';
import { MERGE_PUSHED, normalizeTicket, upcast, upcastMergeRefusal, upcastTicket, upcastTimer, type StoredEvent } from './upcast.js';

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
    expect(effects).toEqual([['start_run'], ['stop_run', 'activity', 'labels'], []]);
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

describe('a ticket written before ORC-180', () => {
  const body = { author: 'L', body: 'ok', at: 1, source: 'session' as const };
  const { humanInbox: _unused, ...current } = newTicketState('p', 'REL-1', 'T', 'human_review', 0);

  it('reads its pending feedback as its human inbox, the same items', () => {
    expect(upcastTicket({ ...current, pendingFeedback: [body] })).toEqual({ ...current, humanInbox: [body] });
    expect(normalizeTicket({ ...current, pendingFeedback: [body] } as unknown as TicketState)).toEqual({ ...current, humanInbox: [body] });
  });

  it('leaves a ticket of today as it is, and a corrupt inbox corrupt: it is not repaired in passing', () => {
    const today = { ...current, humanInbox: [body] };
    expect(upcastTicket(today)).toBe(today);
    expect(upcastTicket({ ...current, pendingFeedback: null })).toEqual({ ...current, humanInbox: null });
  });
});

describe('a ticket blocked before ORC-345 (criterion 2)', () => {
  /** As a projection or a recorded decision holds it: its reason alone, no kind. */
  const old = (blockReason: string | undefined) => ({ ...newTicketState('p', 'REL-1', 'T', 'dev', 0), delegated: true, blocked: true, ...(blockReason === undefined ? {} : { blockReason }) });

  it.each([
    ['Stopped on request', 'stopped'],
    ['Arrêté à la demande', 'stopped'],
    ['Question asked by the agent', 'asked'],
    ["Question posée par l'agent", 'asked'],
    ["Waiting for an answer to the agent's question.", 'question'],
    ['Question asked by the agent: which format?', 'question'],
    ['CI still failing after 2 attempts of fix-ci.', 'ci_bound'],
    ['CI toujours en échec après 2 tentatives de fix-ci.', 'ci_bound'],
    ['Checks still failing after 2 attempts.', 'limit'],
    ['Error: the pending dev-feedback could not be started: connection reset', 'stuck'],
    ['Error: boom', 'infra'],
    ['Repository configuration to fix: .factory/config.yml refused', 'repo_config'],
    ['Configuration du dépôt à corriger : .factory/config.yml refusé', 'repo_config'],
    ['The description is shorter than 30 characters. The description has no acceptance criteria.', 'pickup'],
    ['PR #3 fermée sans merge', 'pr_closed'],
    ['Publication refused: no green verification', 'other'],
    ['A reason the engine will write tomorrow.', 'other'],
  ] as const)('gets its kind back from its reason: %s', (reason, kind) => {
    expect(upcastTicket(old(reason)).blockKind).toBe(kind);
  });

  it('reads only the head of a reason: what an error or a job name quotes does not change the kind', () => {
    expect(upcastTicket(old('Error: Red not verified after 2 attempts, Waiting for an answer')).blockKind).toBe('infra');
    expect(upcastTicket(old('Event e9 set aside (pr.opened): its decision failed (Loop: same failure, set aside (x)).'))).toMatchObject({ blockKind: 'dead_letter', blockedEvent: 'e9' });
  });

  it('gets the event of a dead letter back, in English and in French', () => {
    expect(upcastTicket(old(deadLetterReason({ eventId: 'linear:d1', eventType: 'pr.opened', error: 'boom', failures: 1 })))).toMatchObject({ blockKind: 'dead_letter', blockedEvent: 'linear:d1' });
    expect(upcastTicket(old('Événement e9 mis de côté (pr.opened) : sa décision a échoué (boom).'))).toMatchObject({ blockKind: 'dead_letter', blockedEvent: 'e9' });
    expect(upcastTicket(old('Événement e9 mis de côté (pr.opened) : sa décision a échoué (Événement e8 mis de côté (x)).'))).toMatchObject({ blockedEvent: 'e9' });
  });

  it('is never guessed: a block without a reason is `other`, shown under `other`', () => {
    const t = upcastTicket(old(undefined));
    expect(t.blockKind).toBe('other');
    expect(causeOf(t.blockKind)).toBe('other');
  });

  it('decides as before once read, through the store as through a recorded decision', () => {
    expect(settledTicket(normalizeTicket(old('Arrêté à la demande') as TicketState))).toBe('stopped');
    expect(liftDeadLetterBlock(upcastTicket(old('Event e9 set aside (pr.opened): its decision failed (boom).')), 'e9').blocked).toBe(false);
    const green = { id: 'g1', type: 'pr.checks_passed', at: 1, projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint: 'trusted', payload: { number: 3, url: 'u', branch: 'b' } } as FactoryEvent;
    expect(decide({ ...upcastTicket(old('CI still failing after 2 attempts of fix-ci.')), prNumber: 3 }, green, workflow).events).toContainEqual({ type: 'ticket.unblocked' });
  });

  it('leaves a typed or unblocked ticket as it is', () => {
    const typed = { ...old('Stopped on request'), blockKind: 'infra' as const };
    expect(upcastTicket(typed)).toBe(typed);
    const free = newTicketState('p', 'REL-1', 'T', 'dev', 0);
    expect(upcastTicket(free)).toBe(free);
  });
});

describe('a merge refusal saved before ORC-345', () => {
  it('reads whether the head moved from the sentence alone, in English and in French', () => {
    expect(upcastMergeRefusal(MERGE_PUSHED)).toEqual({ reason: MERGE_PUSHED, headMoved: true });
    expect(upcastMergeRefusal('la branche a reçu un push depuis la review')).toEqual({ reason: 'la branche a reçu un push depuis la review', headMoved: true });
    expect(upcastMergeRefusal('the PR is no longer open')).toEqual({ reason: 'the PR is no longer open', headMoved: false });
  });

  it('reads a refusal saved since as saved: the flag, not the sentence', () => {
    expect(upcastMergeRefusal(JSON.stringify({ reason: 'GitHub says: head moved', headMoved: true }))).toEqual({ reason: 'GitHub says: head moved', headMoved: true });
    expect(upcastMergeRefusal(JSON.stringify({ reason: MERGE_PUSHED, headMoved: false }))).toEqual({ reason: MERGE_PUSHED, headMoved: false });
    // A sentence that happens to be JSON but no refusal stays a sentence, and so does a refusal without its flag.
    expect(upcastMergeRefusal('42')).toEqual({ reason: '42', headMoved: false });
    expect(upcastMergeRefusal(JSON.stringify({ reason: 'x' }))).toEqual({ reason: JSON.stringify({ reason: 'x' }), headMoved: false });
  });
});
