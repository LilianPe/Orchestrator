import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import { planDecision } from './decision-plan.js';
import { newTicketState, SCHEMA_VERSION, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });

function ev<T extends EventType>(type: T, payload: EventPayloads[T]): FactoryEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint: 'trusted', payload } as FactoryEvent;
}

const settles = (known: TicketState, event: FactoryEvent) => planDecision({ event, known, workflow, hash: 'h', now: 1 }).effects.some((e) => e.kind === 'settle');

describe('planDecision — a lifted block settles its pending job (ORC-362)', () => {
  const pendingJob = { job: 'dev-feedback', input: 'feedback' as const, resume: true };
  const ticket = (patch: Partial<TicketState>): TicketState => ({ ...newTicketState('p', 'REL-1', 'Titre', 'human_review', 0), delegated: true, prNumber: 7, ...patch });
  const green = ev('pr.checks_passed', { number: 7, url: 'https://forge/pr/7', branch: 'factory/rel-1-titre' });

  it('a green CI that lifts the red-CI bound over a pending job settles the ticket; with no pending job, or no lift, it does not', () => {
    const bound = { blocked: true, blockKind: 'ci_bound' as const, blockReason: 'CI still failing after 2 attempts of fix-ci.', blockedJob: 'fix-ci' };
    expect(settles(ticket({ ...bound, pendingJob }), green)).toBe(true);
    expect(settles(ticket(bound), green)).toBe(false);
    // Another block stays: nothing to start.
    expect(settles(ticket({ blocked: true, blockKind: 'stopped', blockReason: 'Stopped on request.', pendingJob }), green)).toBe(false);
  });

  it('a repair, which lifts its dead letter in reduce with no ticket.unblocked, settles the ticket too', () => {
    const delegation = ev('ticket.delegated', { linearSessionId: 's1' });
    const skip = ev('dead_letter.repaired', { eventId: 'l1', action: 'skip', by: 'ops', event: delegation as never });
    expect(settles(ticket({ blocked: true, blockKind: 'dead_letter', blockedEvent: 'l1', blockReason: 'Event l1 set aside.', pendingJob }), skip)).toBe(true);
  });
});
