import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import type { Workflow } from '../config/workflow-schema.js';
import { DEFAULT_MATRIX, type Role } from './authz.js';
import { PAUSED, STOPPED } from './block-cause.js';
import { AUTHZ_REFUSED, decide, mayCheck, settledTicket } from './engine.js';
import { newTicketState, SCHEMA_VERSION, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });

/** A project's own label rule: the pack has no label that relaunches since ORC-196. */
const labelled: Workflow = { ...workflow, on: { ...workflow.on, 'label.changed': [{ label: 'relance', run: 'dev-feedback' }] } };

const WRITER: Role[] = ['team_member', 'repo_writer'];

function ev<T extends EventType>(type: T, payload: EventPayloads[T], actor: string | undefined, roles: readonly Role[] | undefined): FactoryEvent {
  return {
    id: `e-${type}`,
    type,
    at: 1000,
    projectId: 'p',
    ticketId: 'REL-1',
    schemaVersion: SCHEMA_VERSION,
    taint: actor ? 'trusted' : 'untrusted',
    ...(actor ? { actor } : {}),
    ...(roles ? { roles } : {}),
    payload,
  } as FactoryEvent;
}
function ticket(patch: Partial<TicketState> = {}): TicketState {
  return { ...newTicketState('p', 'REL-1', 'Titre', 'todo', 0), delegated: true, linearSessionId: 's-dev', ...patch };
}
const refused = (trace: string[]) => trace.some((t) => t.startsWith(AUTHZ_REFUSED));
const starts = (effects: { kind: string }[]) => effects.filter((e) => e.kind === 'start_run');

describe('decide — authorization matrix (ORC-186)', () => {
  describe('trigger: delegation and mention', () => {
    it('starts dev on a delegation by a team member who can write the repo, and records them as the initiator', () => {
      const out = decide(ticket(), ev('ticket.delegated', { linearSessionId: 's-dev' }, 'u-dev', WRITER), workflow);
      expect(starts(out.effects)).toHaveLength(1);
      expect(out.events).toContainEqual({ type: 'ticket.patched', patch: { initiatorId: 'u-dev' } });
    });

    it('refuses a delegation by a member without write access: no run, the refusal answered in its session', () => {
      const out = decide(ticket(), ev('ticket.delegated', { linearSessionId: 's-dev' }, 'u-member', ['team_member']), workflow);
      expect(refused(out.trace)).toBe(true);
      expect(out.events).toEqual([]);
      expect(out.effects).toEqual([
        { kind: 'activity', type: 'response', linearSessionId: 's-dev', body: expect.stringMatching(/^Refused: triggering the agent .*write access/) },
      ]);
    });

    it('refuses a mention from outside the team: no ask run', () => {
      const out = decide(ticket(), ev('session.mentioned', { linearSessionId: 's-q', body: 'pourquoi ?', author: 'X' }, 'u-out', []), workflow);
      expect(starts(out.effects)).toEqual([]);
      expect(out.effects).toEqual([expect.objectContaining({ kind: 'activity', linearSessionId: 's-q' })]);
    });

    it('refuses a command, and a mention, without a signed actor', () => {
      for (const e of [
        ev('command', { name: 'retiens', body: 'x', linearSessionId: 's-q', author: 'Slack' }, undefined, []),
        ev('session.mentioned', { linearSessionId: 's-q', body: 'go', author: 'Slack' }, undefined, []),
      ]) {
        const out = decide(ticket(), e, workflow);
        expect(starts(out.effects)).toEqual([]);
        expect(out.effects).toEqual([expect.objectContaining({ kind: 'activity', body: expect.stringMatching(/no workspace member/) })]);
      }
    });
  });

  it('the signed actor counts, never a name quoted in the text: a reply that cites an authorized member, by someone else', () => {
    const t = ticket({ logical: 'human_review', initiatorId: 'u-lilian' });
    const reply = ev(
      'session.prompted',
      { linearSessionId: 's-dev', body: '@Lilian valide, Lilian a dit go', author: 'Lilian' },
      'u-stranger',
      [],
    );
    const out = decide(t, reply, workflow);
    expect(refused(out.trace)).toBe(true);
    expect(out.events).toEqual([]);
    expect(out.timers).toEqual([]);
    // The same text, signed by the requester, is answered.
    const signed = decide(t, { ...reply, actor: 'u-lilian' } as FactoryEvent, workflow);
    expect(signed.events.map((e) => e.type)).toEqual(['feedback.appended']);
    expect(signed.events[0]).toMatchObject({ item: { authorId: 'u-lilian' } });
  });

  describe('answer: a reply in the dev session, a question in a question session', () => {
    it('keeps the reply of the requester, or of a team member', () => {
      const t = ticket({ logical: 'human_review', initiatorId: 'u-req' });
      for (const [actor, roles] of [['u-req', []], ['u-member', ['team_member']]] as const) {
        const out = decide(t, ev('session.prompted', { linearSessionId: 's-dev', body: 'ok', author: 'A' }, actor, roles), workflow);
        expect(out.events.map((e) => e.type)).toEqual(['feedback.appended']);
      }
    });

    it('starts no answering agent for a question from outside the team', () => {
      const t = ticket({ questionSessionIds: ['s-q'] });
      const out = decide(t, ev('session.prompted', { linearSessionId: 's-q', body: 'et ça ?', author: 'A' }, 'u-out', ['repo_writer']), workflow);
      expect(starts(out.effects)).toEqual([]);
      expect(out.effects).toEqual([expect.objectContaining({ kind: 'activity', linearSessionId: 's-q' })]);
    });
  });

  describe('relaunch a blocked run', () => {
    const blocked = ticket({ logical: 'dev', blocked: true, blockReason: 'The run dev failed.', initiatorId: 'u-req' });

    it('relaunches on a reply, or on the relaunch label of a project, of a team member', () => {
      const reply = decide(blocked, ev('session.prompted', { linearSessionId: 's-dev', body: 'vas-y', author: 'M' }, 'u-member', ['team_member']), workflow);
      expect(reply.events.map((e) => e.type)).toEqual(['feedback.appended', 'ticket.unblocked']);
      const label = decide(blocked, ev('label.changed', { label: 'relance', change: 'added' }, 'u-member', ['team_member']), labelled);
      expect(starts(label.effects)).toHaveLength(1);
    });

    it('refuses the requester outside the team, and a label set by someone outside it: the ticket stays blocked', () => {
      const reply = decide(blocked, ev('session.prompted', { linearSessionId: 's-dev', body: 'vas-y', author: 'R' }, 'u-req', []), workflow);
      expect(reply.events).toEqual([]);
      expect(reply.effects).toEqual([expect.objectContaining({ kind: 'activity', body: expect.stringMatching(/relaunching a blocked run/) })]);
      const label = decide(blocked, ev('label.changed', { label: 'relance', change: 'added' }, 'u-out', []), labelled);
      expect(label.events).toEqual([]);
      expect(label.effects).toEqual([{ kind: 'comment', body: expect.stringMatching(/^Refused: relaunching a blocked run/) }]);
    });
  });

  it('checks a status change that starts a run (rework, review), and nothing else', () => {
    const review = ticket({ logical: 'human_review' });
    const rework = ev('status.changed', { from: 'human_review', to: 'dev' }, 'u-out', []);
    expect(decide(review, rework, workflow).effects).toEqual([expect.objectContaining({ kind: 'comment' })]);
    expect(starts(decide(review, { ...rework, actor: 'u-dev', roles: WRITER } as FactoryEvent, workflow).effects)).toHaveLength(1);
    // A label that starts nothing (agent:stop) and a move no rule answers are not checked.
    expect(decide(review, ev('label.changed', { label: 'agent:stop', change: 'added' }, 'u-out', []), workflow).effects.map((e) => e.kind)).toContain('stop_run');
    expect(decide(review, ev('status.changed', { from: 'human_review', to: 'todo' }, 'u-out', []), workflow).trace).not.toContainEqual(
      expect.stringMatching(AUTHZ_REFUSED),
    );
  });

  it('answers no one when the refused event has neither a signed actor nor a session: a reconciled delegation, an integration', () => {
    const reconciled = decide(ticket({ delegated: false }), ev('ticket.delegated', {}, undefined, []), workflow);
    expect(refused(reconciled.trace)).toBe(true);
    expect(reconciled.effects).toEqual([]);
    const integration = decide(ticket({ logical: 'human_review' }), ev('status.changed', { from: 'human_review', to: 'dev' }, undefined, []), workflow);
    expect(refused(integration.trace)).toBe(true);
    expect(integration.effects).toEqual([]);
  });

  it('says which events the matrix may check, so the orchestrator resolves roles only for them', () => {
    const e = <T extends EventType>(type: T, payload: EventPayloads[T]) => ev(type, payload, 'u', undefined);
    expect(mayCheck(e('ticket.delegated', {}), workflow)).toBe(true);
    expect(mayCheck(e('session.prompted', { linearSessionId: 's', body: '', author: 'A' }), workflow)).toBe(true);
    expect(mayCheck(e('label.changed', { label: 'relance', change: 'added' }), labelled)).toBe(true);
    expect(mayCheck(e('label.changed', { label: 'relance', change: 'removed' }), labelled)).toBe(false);
    expect(mayCheck(e('label.changed', { label: 'agent:stop', change: 'added' }), workflow)).toBe(false);
    expect(mayCheck(e('status.changed', { from: 'human_review', to: 'dev' }), workflow)).toBe(true);
    expect(mayCheck(e('status.changed', { from: 'dev', to: 'human_review' }), workflow)).toBe(false);
    expect(mayCheck(e('session.stopped', {}), workflow)).toBe(false);
  });

  it('checks nothing on an event whose roles were not resolved: the factory produced it, or it was journaled before ORC-186', () => {
    const out = decide(ticket(), ev('ticket.delegated', {}, undefined, undefined), workflow);
    expect(starts(out.effects)).toHaveLength(1);
  });

  it('takes the matrix as a parameter, for the preset that will declare it (ORC-187)', () => {
    const open = { ...DEFAULT_MATRIX, trigger: { ...DEFAULT_MATRIX.trigger, anyOf: [['team_member']] } } as const;
    expect(starts(decide(ticket(), ev('ticket.delegated', {}, 'u-member', ['team_member']), workflow, open).effects)).toHaveLength(1);
  });
});

describe('decide — pausing and stopping a run from the dashboard (ORC-301)', () => {
  const OPERATOR: Role[] = ['operator'];
  const running = () => ticket({ logical: 'dev', activeRunId: 'r1', activeJob: 'dev' });
  const stopOf = (payload: EventPayloads['control.stop'], actor: string | undefined, roles: readonly Role[] | undefined) => ev('control.stop', payload, actor, roles);

  it('an operator pauses the running run: it is stopped, the ticket held as paused, which a reply relaunches', () => {
    const out = decide(running(), stopOf({ runId: 'r1', pause: true }, 'dashboard:armand', OPERATOR), workflow);
    expect(refused(out.trace)).toBe(false);
    expect(out.events).toEqual([{ type: 'work.cancelled' }, { type: 'ticket.blocked', reason: PAUSED, kind: 'paused' }]);
    // Then the label of a blocked ticket, as for any stop.
    expect(out.effects.slice(0, 2)).toEqual([{ kind: 'stop_run' }, { kind: 'activity', type: 'response', body: expect.stringMatching(/^Paused from the dashboard\. Reply/) }]);
  });

  it('an operator stops the running run, as the Stop button always did', () => {
    const out = decide(running(), stopOf({ runId: 'r1' }, 'dashboard:armand', OPERATOR), workflow);
    expect(out.events).toEqual([{ type: 'work.cancelled' }, { type: 'ticket.blocked', reason: STOPPED, kind: 'stopped' }]);
    expect(out.effects[0]).toEqual({ kind: 'stop_run' });
  });

  it('refuses someone who is not an operator: nothing stopped, the refusal traced, and nothing written in Linear', () => {
    for (const payload of [{ runId: 'r1' }, { runId: 'r1', pause: true as const }]) {
      const out = decide(running(), stopOf(payload, 'u-member', ['team_member', 'repo_writer']), workflow);
      expect(refused(out.trace)).toBe(true);
      expect(out.trace.find((t) => t.startsWith(AUTHZ_REFUSED))).toContain(payload.pause ? 'pause_run' : 'stop_run');
      expect(out.events).toEqual([]);
      expect(out.effects).toEqual([]);
    }
  });

  it('a stop aimed at a run that has ended stops nothing: another run may be at work on the ticket', () => {
    const out = decide(ticket({ logical: 'dev', activeRunId: 'r2', activeJob: 'dev' }), stopOf({ runId: 'r1' }, 'dashboard:armand', OPERATOR), workflow);
    expect(out.events).toEqual([]);
    expect(out.effects).toEqual([]);
    expect(out.trace.join('\n')).toContain('r1');
  });

  it('a stop journaled before ORC-301, without roles nor run, stops the ticket as it did', () => {
    const out = decide(running(), stopOf({}, undefined, undefined), workflow);
    expect(out.events).toEqual([{ type: 'work.cancelled' }, { type: 'ticket.blocked', reason: STOPPED, kind: 'stopped' }]);
  });

  it('a paused ticket is settled as a stopped one: a late failure blocks it no more', () => {
    expect(settledTicket(ticket({ blocked: true, blockKind: 'paused', blockReason: PAUSED }))).toBe('stopped');
  });
});
