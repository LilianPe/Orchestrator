import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import type { Role } from './authz.js';
import { ACK_BODY, decide, mayCheck } from './engine.js';
import { reduce } from './reduce.js';
import { newTicketState, SCHEMA_VERSION, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });
const WRITER: Role[] = ['team_member', 'repo_writer'];

function ev<T extends EventType>(type: T, payload: EventPayloads[T], roles: readonly Role[] | undefined = WRITER, actor: string | undefined = 'u-dev'): FactoryEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint: 'trusted', ...(actor ? { actor } : {}), ...(roles ? { roles } : {}), payload } as FactoryEvent;
}
const ticket = (patch: Partial<TicketState> = {}): TicketState => ({ ...newTicketState('p', 'REL-1', 'Titre', 'todo', 0), ...patch });
const kinds = (effects: { kind: string }[]) => effects.map((e) => e.kind);
const delegation = (linearSessionId = 's-dev') => ev('ticket.delegated', { linearSessionId, ack: true });

describe('decide — the acknowledgement of a trigger (ORC-171)', () => {
  it('acknowledges a delegation first, with the comment and the plan, before the run it starts', () => {
    const out = decide(ticket(), delegation(), workflow);
    expect(kinds(out.effects)).toEqual(['ack', 'start_run']);
    expect(out.effects[0]).toEqual({ kind: 'ack', body: ACK_BODY, linearSessionId: 's-dev', comment: true, plan: true });
    expect(ACK_BODY).toBe('Bien reçu.');
  });

  it('acknowledges a mention in its own session, without a comment or a plan: the ask run still starts', () => {
    const out = decide(ticket(), ev('session.mentioned', { linearSessionId: 's-q', body: 'pourquoi ?', author: 'L', ack: true }), workflow);
    expect(out.effects[0]).toEqual({ kind: 'ack', body: ACK_BODY, linearSessionId: 's-q' });
    expect(kinds(out.effects)).toEqual(['ack', 'start_run']);
  });

  it('gives no plan to a delegation that starts no run: a blocked ticket waits for a human', () => {
    const out = decide(ticket({ blocked: true, blockReason: 'x', delegated: true }), delegation(), workflow);
    expect(out.effects).toEqual([{ kind: 'ack', body: ACK_BODY, linearSessionId: 's-dev', comment: true }]);
  });

  it('answers a refused delegation with the refusal alone: nothing says it was taken', () => {
    const out = decide(ticket(), ev('ticket.delegated', { linearSessionId: 's-dev', ack: true }, ['team_member']), workflow);
    expect(kinds(out.effects)).toEqual(['activity']);
    expect(out.effects[0]).toMatchObject({ body: expect.stringMatching(/^Refusé/) });
  });

  it('asks nothing of a row journaled before ORC-171, or of what no webhook brought: it replays as it was decided', () => {
    expect(kinds(decide(ticket(), ev('ticket.delegated', { linearSessionId: 's-dev' }), workflow).effects)).toEqual(['start_run']);
  });
});

describe('decide — one active run per ticket (ORC-171)', () => {
  const active: Partial<TicketState>[] = [{ activeRunId: 'r1', activeJob: 'dev' }, { verifyingRunId: 'r1' }, { pendingJob: { job: 'dev' } }];

  it.each(active)('a second delegation starts nothing, keeps the initiator and answers in its session: %o', (patch) => {
    const state = ticket({ delegated: true, linearSessionId: 's-dev', initiatorId: 'u-first', logical: 'dev', ...patch });
    const out = decide(state, delegation('s-2'), workflow);
    expect(out.events).toEqual([]);
    expect(out.effects).toEqual([{ kind: 'activity', type: 'response', linearSessionId: 's-2', body: expect.stringContaining('déjà') }]);
    expect(out.trace).toContain('ticket.delegated: a run is active, none started');
  });

  it('still refuses a second delegation by someone without the right', () => {
    const state = ticket({ delegated: true, linearSessionId: 's-dev', activeRunId: 'r1', logical: 'dev' });
    const out = decide(state, ev('ticket.delegated', { linearSessionId: 's-2', ack: true }, []), workflow);
    expect(out.effects).toEqual([expect.objectContaining({ body: expect.stringMatching(/^Refusé/) })]);
  });

  it('a delegation the reconciliation finds on a ticket at work starts nothing, and has no session to answer', () => {
    const out = decide(ticket({ activeRunId: 'r1', logical: 'dev' }), ev('ticket.delegated', {}, undefined, undefined), workflow);
    expect(out.effects).toEqual([]);
  });

  it('a delegation after the run ended starts as before', () => {
    const out = decide(ticket({ delegated: true, linearSessionId: 's-dev', logical: 'dev' }), delegation(), workflow);
    expect(kinds(out.effects)).toEqual(['ack', 'start_run']);
  });
});

describe('decide — a ticket of a team with no repo (ORC-171)', () => {
  const issue = { title: 'T', logical: 'todo' as const, priority: 0 };
  const noRepo = ev('ticket.delegated', { linearSessionId: 's-1', issue, noRepo: 'ZZZ' }, undefined);
  const blocked = reduce(reduce(undefined, noRepo), decide(undefined, noRepo, workflow).events[0]!)!;

  it('blocks the delegation, labels it and says why in its session, and starts nothing', () => {
    const out = decide(undefined, noRepo, workflow);
    expect(out.events).toEqual([{ type: 'ticket.blocked', reason: expect.stringContaining('ZZZ') }]);
    expect(out.effects).toEqual([
      { kind: 'activity', type: 'elicitation', linearSessionId: 's-1', body: expect.stringContaining('ZZZ') },
      { kind: 'labels', add: ['Bloqué'], remove: [] },
    ]);
    expect(blocked).toMatchObject({ blocked: true, delegated: true });
  });

  it('whoever delegated: no repo, no role to check', () => {
    expect(mayCheck(noRepo, workflow)).toBe(false);
    expect(decide(undefined, { ...noRepo, roles: [] }, workflow).events).toEqual([{ type: 'ticket.blocked', reason: expect.stringContaining('ZZZ') }]);
  });

  it('asks again on a new delegation while the team still has no repo, the block kept', () => {
    const out = decide(blocked, { ...noRepo, payload: { linearSessionId: 's-2', noRepo: 'ZZZ' } } as FactoryEvent, workflow);
    expect(out.events).toEqual([]);
    expect(out.effects).toEqual([{ kind: 'activity', type: 'elicitation', linearSessionId: 's-2', body: expect.stringContaining('ZZZ') }]);
  });

  it('lifts that block, and the label, once the ticket is no longer delegated here', () => {
    const out = decide(blocked, ev('ticket.undelegated', {}, undefined, undefined), workflow);
    expect(out.events).toEqual([{ type: 'ticket.unblocked' }]);
    expect(out.effects).toEqual([{ kind: 'labels', add: [], remove: ['Bloqué'] }]);
  });

  it('leaves any other block alone when the ticket is undelegated', () => {
    expect(decide(ticket({ delegated: true, blocked: true, blockReason: 'Tests rouges' }), ev('ticket.undelegated', {}, undefined, undefined), workflow).events).toEqual([]);
  });
});
