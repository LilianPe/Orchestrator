import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TrackerIssue } from '../adapters/tracker/types.js';
import type { WorkspaceManager } from '../adapters/workspace/types.js';
import { loadWorkflow } from '../config/load-workflow.js';
import { blockCause } from './block-cause.js';
import { deadLetterReason } from './dead-letter.js';
import { decide } from './engine.js';
import { pickupFailures } from './pickup.js';
import { newTicketState, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });
const blocking = { ...workflow, jobs: { ...workflow.jobs, tests: { ...workflow.jobs['tests']!, red: { ...workflow.jobs['tests']!.red!, mode: 'blocking' as const } } } };

function ev<T extends EventType>(type: T, payload: EventPayloads[T]): FactoryEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: 3, taint: 'trusted', payload } as FactoryEvent;
}
const ticket = (patch: Partial<TicketState> = {}): TicketState => ({ ...newTicketState('p', 'REL-1', 'Titre', 'dev', 0), delegated: true, ...patch });
const finished = (patch: Partial<EventPayloads['run.finished']>) => ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'failure', costUsd: 0, turns: 1, lastText: '', ...patch });
const failure = { command: 'npm test', exitCode: 1, output: 'rouge' };

/** The reason `decide` blocks with: the classification reads what the engine really writes. */
function reasonOf(state: TicketState, event: FactoryEvent, wf = workflow): string {
  const blocked = decide(state, event, wf).events.find((e) => e.type === 'ticket.blocked');
  if (blocked?.type !== 'ticket.blocked') throw new Error(`${event.type} did not block`);
  return blocked.reason;
}

describe('blockCause (ORC-297)', () => {
  it.each([
    ['question', () => reasonOf(ticket({ activeRunId: 'r1' }), finished({ attempt: 'needs_input', output: { question: 'Laquelle ?' } as EventPayloads['run.finished']['output'] }))],
    ['contested', () => reasonOf(ticket({ activeRunId: 'r1' }), finished({ attempt: 'spec_impossible', output: { question: 'Impossible.' } as EventPayloads['run.finished']['output'] }))],
    ['infra', () => reasonOf(ticket({ activeRunId: 'r1' }), finished({ attempt: 'errored' }))],
    ['limit', () => reasonOf(ticket({ activeRunId: 'r1' }), finished({ outcome: 'limit' }))],
    ['failed', () => reasonOf(ticket({ activeRunId: 'r1' }), finished({ outcome: 'failure' }))],
    ['limit', () => reasonOf(ticket({ verifyingRunId: 'r1', verifyAttempts: workflow.limits.verifyAttempts - 1 }), ev('verify.failed', { runId: 'r1', job: 'dev', failures: [failure] }))],
    ['loop', () => reasonOf(ticket({ verifyingRunId: 'r1', repeatedFailure: { signature: 'dev|abc|npm test:1', count: 2 } }), ev('verify.failed', { runId: 'r1', job: 'dev', tree: 'abc', failures: [failure] }))],
    ['limit', () => reasonOf(ticket({ logical: 'human_review', prNumber: 3, ciFixAttempts: 2 }), ev('pr.checks_failed', { number: 3, url: 'u', branch: 'b', failures: ['test'] }))],
    ['red', () => reasonOf(ticket({ verifyingRunId: 'r1', redAttempts: blocking.jobs['tests']!.red!.attempts - 1 }), ev('verify.failed', { runId: 'r1', job: 'tests', red: 'compile', failures: [failure] }), blocking)],
    ['infra', () => reasonOf(ticket({ verifyingRunId: 'r1' }), ev('verify.failed', { runId: 'r1', job: 'tests', red: 'infra', failures: [failure] }))],
    ['stopped', () => reasonOf(ticket({ activeRunId: 'r1' }), ev('control.stop', {}))],
    ['infra', () => reasonOf(ticket(), ev('effect.failed', { effectId: 'x:1:1', kind: 'comment', eventId: 'e1', attempts: 8, error: 'boom' }))],
    ['infra', () => reasonOf(ticket({ activeRunId: 'r1', leaseRelaunches: 1 }), ev('run.lost', { runId: 'r1', job: 'dev', cause: 'lease' }))],
    ['limit', () => reasonOf(ticket({ activeRunId: 'r1', cutRelaunches: [997, 998, 999] }), ev('run.lost', { runId: 'r1', job: 'dev', cause: 'restart' }))],
    ['pr_closed', () => reasonOf(ticket({ activeRunId: 'r1', prNumber: 3, prState: 'OPEN' }), ev('pr.closed', { number: 3, url: 'u', branch: 'b' }))],
    ['pickup', () => reasonOf(ticket({ delegated: false }), ev('ticket.delegated', { linearSessionId: 's1', noRepo: 'ZZZ' }))],
    ['pickup', () => reasonOf(ticket({ delegated: false }), ev('ticket.delegated', { linearSessionId: 's1', repos: ['web', 'api'] }))],
    ['dead_letter', () => reasonOf(ticket(), ev('dead_letter.added', { eventId: 'e9', eventType: 'pr.opened', error: 'boom', failures: 1 }))],
  ] as const)('%s, for a reason decide writes', (cause, reason) => {
    expect(blockCause(reason())).toBe(cause);
  });

  it('classifies what the pickup check writes', async () => {
    const issue = { identifier: 'REL-1', description: '' } as TrackerIssue;
    const workspaces = { remoteBranchExists: async () => true } as unknown as WorkspaceManager;
    const failures = await pickupFailures(['has_description', 'not_started', 'has_acceptance_criteria'], issue, '/repo', workspaces);
    expect(failures).toHaveLength(3);
    expect(failures.map(blockCause)).toEqual(['pickup', 'pickup', 'pickup']);
  });

  it('classifies a dead letter', () => {
    expect(blockCause(deadLetterReason({ eventId: 'e9', eventType: 'pr.opened', error: 'boom', failures: 1 }))).toBe('dead_letter');
  });

  it('reads only the head of a reason: what an error or a job name quotes does not change the cause', () => {
    expect(blockCause("Erreur : Rouge non vérifié après 2 tentatives, En attente d'une réponse")).toBe('infra');
    expect(blockCause('Événement e9 mis de côté (pr.opened) : sa décision a échoué (Boucle : même échec).')).toBe('dead_letter');
  });

  it('never guesses: an unknown or missing reason is `other`', () => {
    expect(blockCause('Une raison que le moteur écrira demain.')).toBe('other');
    expect(blockCause(undefined)).toBe('other');
  });
});
