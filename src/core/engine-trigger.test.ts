import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import { REFREEZE, type FrozenTests } from '../checks/freeze.js';
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

describe('decide — /refreeze answers for itself (ORC-131, ORC-171)', () => {
  const refreeze = (roles: readonly Role[], frozen?: FrozenTests) => ev('command', { name: REFREEZE, body: '', linearSessionId: 's-r', author: 'L', ack: true, ...(frozen ? { frozen } : {}) }, roles);

  it.each([
    ['refused', refreeze(['team_member']), /^Refusé/],
    ['with nothing to refreeze', refreeze(['maintainer']), /^Rien à regeler/],
    ['done', refreeze(['maintainer'], { sha: 'a'.repeat(40), files: { 'a.test.ts': 'x' } }), /^Regelé/],
  ])('%s: its answer is the sign of life, with no ack before it', (_, event, body) => {
    const out = decide(ticket({ delegated: true, logical: 'dev' }), event, workflow);
    expect(out.effects).toEqual([{ kind: 'activity', type: 'response', linearSessionId: 's-r', body: expect.stringMatching(body) }]);
  });
});

describe('decide — one active run per ticket (ORC-171)', () => {
  const active: Partial<TicketState>[] = [{ activeRunId: 'r1', activeJob: 'dev' }, { verifyingRunId: 'r1' }, { activeRunId: 'r1', activeJob: 'dev', pendingJob: { job: 'dev' } }];

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

  it('a delegation the reconciliation finds on a ticket at work is refused by the matrix: unsigned, it starts nothing', () => {
    const out = decide(ticket({ activeRunId: 'r1', logical: 'dev' }), { ...ev('ticket.delegated', {}, []), actor: undefined } as FactoryEvent, workflow);
    expect(out.effects).toEqual([]);
  });

  it('replays a delegation journaled before ORC-171 as it was decided, on a ticket at work too', () => {
    const out = decide(ticket({ delegated: true, linearSessionId: 's-dev', activeRunId: 'r1', logical: 'dev' }), ev('ticket.delegated', { linearSessionId: 's-2' }), workflow);
    expect(kinds(out.effects)).toEqual(['start_run']);
  });

  it('a pending job left without a run (a crash) refuses nothing: the delegation starts', () => {
    const out = decide(ticket({ delegated: true, linearSessionId: 's-dev', logical: 'dev', pendingJob: { job: 'dev' } }), delegation(), workflow);
    expect(kinds(out.effects)).toEqual(['ack', 'start_run']);
  });

  it('the relaunch of a lost run asks for no ack and no plan: nobody triggered it', () => {
    const state = ticket({ delegated: true, linearSessionId: 's-dev', logical: 'dev', activeRunId: 'r1', activeJob: 'dev' });
    const out = decide(state, ev('run.lost', { runId: 'r1', job: 'dev', cause: 'restart' }, undefined, undefined), workflow);
    expect(kinds(out.effects)).toEqual(['start_run']);
  });

  it('a delegation after the run ended starts as before', () => {
    const out = decide(ticket({ delegated: true, linearSessionId: 's-dev', logical: 'dev' }), delegation(), workflow);
    expect(kinds(out.effects)).toEqual(['ack', 'start_run']);
  });
});

describe('decide — a ticket of a team with no repo (ORC-171)', () => {
  const issue = { title: 'T', logical: 'todo' as const, priority: 0 };
  const noRepo = ev('ticket.delegated', { linearSessionId: 's-1', issue, noRepo: 'ZZZ' }, undefined);
  const blocked = decide(undefined, noRepo, workflow).events.reduce<TicketState | undefined>((t, e) => reduce(t, e), reduce(undefined, noRepo))!;
  const NO_REPO_EVENTS = [{ type: 'ticket.blocked', reason: expect.stringContaining('ZZZ') }, { type: 'ticket.patched', patch: { awaitingRepo: [] } }];

  it('blocks the delegation, labels it and says why in the standard comment, and starts nothing', () => {
    const out = decide(undefined, noRepo, workflow);
    expect(out.events).toEqual(NO_REPO_EVENTS);
    expect(out.effects).toEqual([
      { kind: 'block_comment', block: expect.objectContaining({ waits: true, reason: expect.stringContaining('ZZZ') }) },
      { kind: 'labels', add: ['Bloqué'], remove: [] },
    ]);
    expect(blocked).toMatchObject({ blocked: true, delegated: true, awaitingRepo: [] });
  });

  it('whoever delegated: no repo, no role to check', () => {
    expect(mayCheck(noRepo, workflow)).toBe(false);
    expect(decide(undefined, { ...noRepo, roles: [] }, workflow).events).toEqual(NO_REPO_EVENTS);
  });

  it('asks again on a new delegation while the team still has no repo, the block kept', () => {
    const out = decide(blocked, { ...noRepo, payload: { linearSessionId: 's-2', noRepo: 'ZZZ' } } as FactoryEvent, workflow);
    expect(out.events).toEqual([]);
    expect(out.effects).toEqual([{ kind: 'block_comment', block: expect.objectContaining({ waits: true, reason: expect.stringContaining('ZZZ') }) }]);
  });

  it('takes over a block of another reason, or of a row written before the field: the wait is the field', () => {
    const before = { ...blocked, awaitingRepo: undefined, blockReason: "Aucun dépôt connu pour l'équipe Linear ZZZ : ..." };
    expect(decide(before, noRepo, workflow).events).toEqual(NO_REPO_EVENTS);
  });

  it('has no question to repeat to whatever reaches it: fenced, no question and no run (no webhook brings it a mention)', () => {
    const out = decide(blocked, ev('session.mentioned', { linearSessionId: 's-q', body: 'alors ?', author: 'L', ack: true }), workflow);
    expect(out.events).toEqual([]);
    expect(kinds(out.effects)).toEqual(['ack']);
    expect(decide(blocked, ev('status.changed', { from: 'todo', to: 'dev' }), workflow).effects).toEqual([]);
  });

  it('lifts that block, and the label, once the ticket is no longer delegated here', () => {
    const out = decide(blocked, ev('ticket.undelegated', {}, undefined, undefined), workflow);
    expect(out.events).toEqual([{ type: 'ticket.unblocked' }, { type: 'ticket.patched', patch: { awaitingRepo: null } }]);
    expect(out.effects).toEqual([{ kind: 'labels', add: [], remove: ['Bloqué'] }]);
  });

  it('leaves any other block alone when the ticket is undelegated', () => {
    expect(decide(ticket({ delegated: true, blocked: true, blockReason: 'Tests rouges' }), ev('ticket.undelegated', {}, undefined, undefined), workflow).events).toEqual([]);
  });
});

describe('decide — the ack of a ticket waiting for its repo (ORC-171, ORC-291)', () => {
  const repos = ['p', 'api'];
  const asked = { kind: 'block_comment', block: expect.objectContaining({ waits: true, reason: expect.stringContaining('Dépôt à préciser') }) };
  /** The session the delegation opened needs a sign of life: the question is a comment on the ticket (ORC-196). No plan: no run. */
  const held = (linearSessionId: string) => ({ kind: 'ack', body: ACK_BODY, linearSessionId, comment: true });
  const waiting = ticket({ delegated: true, blocked: true, blockReason: 'Dépôt à préciser : ...', awaitingRepo: repos, linearSessionId: 's-1' });
  const ack = (linearSessionId: string) => ({ kind: 'ack', body: ACK_BODY, linearSessionId, comment: true, plan: true });

  it('a delegation that must choose gets the question, and the ack its session is owed: no plan, no run', () => {
    const out = decide(undefined, ev('ticket.delegated', { linearSessionId: 's-1', ack: true, repos, issue: { title: 'T', logical: 'todo', priority: 0 } }), workflow);
    expect(out.effects).toEqual([held('s-1'), asked, { kind: 'labels', add: ['Bloqué'], remove: [] }]);
    // Delegated again, still with no label: the question again, in its own session's ack.
    expect(decide(waiting, ev('ticket.delegated', { linearSessionId: 's-2', ack: true, repos }), workflow).effects).toEqual([held('s-2'), asked]);
  });

  it.each([
    ['a mention', ev('session.mentioned', { linearSessionId: 's-q', body: 'alors ?', author: 'L', ack: true })],
    ['a command', ev('command', { name: '/x', body: '', linearSessionId: 's-q', author: 'L', ack: true })],
  ])('%s on a waiting ticket is answered with the question, no ack', (_name, event) => {
    expect(decide(waiting, event, workflow).effects).toEqual([{ kind: 'activity', type: 'response', linearSessionId: 's-q', body: expect.stringContaining('Dépôt à préciser') }]);
  });

  it('its end in the repo it waited in: one ack in the new session, the plan there, one run', () => {
    const out = decide(waiting, ev('ticket.delegated', { linearSessionId: 's-2', ack: true }), workflow);
    expect(out.events.slice(0, 3)).toEqual([{ type: 'ticket.unblocked' }, { type: 'ticket.patched', patch: { awaitingRepo: null } }, { type: 'session.linked', linearSessionId: 's-2' }]);
    expect(out.effects.filter((e) => e.kind === 'ack')).toEqual([ack('s-2')]);
    expect(out.effects[0]).toEqual(ack('s-2'));
    expect(out.effects.filter((e) => e.kind === 'start_run')).toHaveLength(1);
    expect(out.effects.filter((e) => e.kind === 'labels')).toEqual([{ kind: 'labels', add: [], remove: ['Bloqué'] }]);
  });

  it('its end in another repo: the same, on a ticket with nothing before it', () => {
    const delegated = ev('ticket.delegated', { linearSessionId: 's-2', ack: true, waitedIn: 'p', issue: { title: 'T', logical: 'todo', priority: 0 } });
    const out = decide(undefined, { ...delegated, projectId: 'api' }, workflow);
    expect(out.effects[0]).toEqual(ack('s-2'));
    expect(out.effects.filter((e) => e.kind === 'ack')).toHaveLength(1);
    expect(out.effects.filter((e) => e.kind === 'start_run')).toHaveLength(1);
    expect(out.effects.filter((e) => e.kind === 'labels')).toEqual([{ kind: 'labels', add: [], remove: ['Bloqué'] }]);
  });

  it('an undelegation that keeps the label decides no ack and no label', () => {
    const out = decide(waiting, ev('ticket.undelegated', { keepLabel: true }, undefined, undefined), workflow);
    expect(out.effects).toEqual([]);
    expect(out.events).toEqual([{ type: 'ticket.unblocked' }, { type: 'ticket.patched', patch: { awaitingRepo: null } }]);
  });
});
