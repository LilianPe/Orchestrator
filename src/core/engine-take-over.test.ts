import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import type { Role } from './authz.js';
import { causeOf, TAKEN_OVER } from './block-cause.js';
import { AUTHZ_REFUSED, decide, settledTicket } from './engine.js';
import { newTicketState, SCHEMA_VERSION, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });
const OPERATOR: Role[] = ['operator'];

function ev<T extends EventType>(type: T, payload: EventPayloads[T], actor: string | undefined, roles: readonly Role[] | undefined, taint: 'trusted' | 'untrusted' = 'trusted'): FactoryEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint, ...(actor ? { actor } : {}), ...(roles ? { roles } : {}), payload } as FactoryEvent;
}
const ticket = (patch: Partial<TicketState> = {}): TicketState => ({ ...newTicketState('p', 'REL-1', 'Titre', 'dev', 0), delegated: true, linearSessionId: 's-dev', branch: 'factory/rel-1', worktreePath: '/ws/REL-1', ...patch });
const running = () => ticket({ activeRunId: 'r1', activeJob: 'dev' });
const takenOver = () => ticket({ blocked: true, blockKind: 'taken_over', blockReason: TAKEN_OVER });
const refused = (trace: string[]) => trace.find((t) => t.startsWith(AUTHZ_REFUSED));

describe('decide — a human takes over a run (ORC-234)', () => {
  describe('opening: the run is stopped first, then a container of its own is opened for the human', () => {
    it('an operator takes over the running run: it is stopped, the ticket held as taken over, the take-over opened after the stop', () => {
      const out = decide(running(), ev('control.stop', { runId: 'r1', takeOver: true }, 'dashboard:armand', OPERATOR), workflow);
      expect(refused(out.trace)).toBeUndefined();
      expect(out.events).toEqual([{ type: 'work.cancelled' }, { type: 'ticket.blocked', reason: TAKEN_OVER, kind: 'taken_over' }]);
      // The stop comes first: the human's container opens on a worktree the agent no longer writes.
      expect(out.effects.map((e) => e.kind).slice(0, 3)).toEqual(['stop_run', 'take_over', 'activity']);
      expect(out.effects[1]).toEqual({ kind: 'take_over', runId: 'r1' });
    });

    it('refuses someone who is not an operator, on the matrix row of the take-over: nothing stopped nor opened', () => {
      const out = decide(running(), ev('control.stop', { runId: 'r1', takeOver: true }, 'u-member', ['team_member', 'repo_writer', 'maintainer']), workflow);
      expect(refused(out.trace)).toContain('take_over');
      expect(out.events).toEqual([]);
      expect(out.effects).toEqual([]);
    });

    it('opens nothing for a run that has ended: another may be at work on the ticket', () => {
      const out = decide(ticket({ activeRunId: 'r2', activeJob: 'dev' }), ev('control.stop', { runId: 'r1', takeOver: true }, 'dashboard:armand', OPERATOR), workflow);
      expect(out.events).toEqual([]);
      expect(out.effects).toEqual([]);
    });

    it('a taken-over ticket is held as a stopped one: under the stop cause, a late failure blocks it no more', () => {
      expect(causeOf('taken_over')).toBe('stopped');
      expect(settledTicket(takenOver())).toBe('stopped');
    });
  });

  describe('handing back a bundle', () => {
    it('an operator hands back a bundle of a taken-over ticket: the factory checks it and pushes it, never the human', () => {
      const out = decide(takenOver(), ev('control.bundle', { file: '/runs/take-over-p-REL-1/b.bundle' }, 'dashboard:armand', OPERATOR), workflow);
      expect(refused(out.trace)).toBeUndefined();
      expect(out.events).toEqual([]);
      expect(out.effects).toEqual([{ kind: 'publish_bundle', file: '/runs/take-over-p-REL-1/b.bundle', by: 'dashboard:armand' }]);
    });

    it('refuses a bundle from someone who is not an operator', () => {
      const out = decide(takenOver(), ev('control.bundle', { file: '/x.bundle' }, 'u-member', ['team_member']), workflow);
      expect(refused(out.trace)).toContain('take_over');
      expect(out.effects).toEqual([]);
    });

    it('takes no bundle for a ticket nobody took over', () => {
      for (const t of [running(), ticket({ blocked: true, blockKind: 'stopped' })]) {
        const out = decide(t, ev('control.bundle', { file: '/x.bundle' }, 'dashboard:armand', OPERATOR), workflow);
        expect(out.effects).toEqual([]);
        expect(out.trace.join('\n')).toContain('not taken over');
      }
    });

    it('a bundle the check refuses is told, nothing pushed, and the ticket stays taken over', () => {
      const out = decide(takenOver(), ev('bundle.refused', { file: '/x.bundle', reason: 'factory/chemins-interdits: .github/workflows/x.yml' }, undefined, undefined), workflow);
      expect(out.events).toEqual([]);
      expect(out.effects).toEqual([{ kind: 'activity', type: 'response', body: expect.stringMatching(/^The bundle handed back is refused, nothing was pushed: factory\/chemins-interdits/) }]);
    });

    it("the bundle the factory pushed is the human's push: verify checks it as ORC-159 does, and the ticket waits on its verdict", () => {
      const out = decide(takenOver(), ev('push.human', { branch: 'factory/rel-1', sha: 'a'.repeat(40), author: 'dashboard:armand', before: 'b'.repeat(40) }, undefined, undefined, 'untrusted'), workflow);
      expect(out.events).toContainEqual(expect.objectContaining({ type: 'ticket.blocked', kind: 'human_push' }));
      expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'run_verify', head: 'a'.repeat(40) }));
    });
  });
});
