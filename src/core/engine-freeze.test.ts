import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REFREEZE, type FrozenTests } from '../checks/freeze.js';
import { loadWorkflow } from '../config/load-workflow.js';
import type { Role } from './authz.js';
import { AUTHZ_REFUSED, decide } from './engine.js';
import { newTicketState, SCHEMA_VERSION, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });
const blocking = { ...workflow, jobs: { ...workflow.jobs, tests: { ...workflow.jobs['tests']!, red: { ...workflow.jobs['tests']!.red!, mode: 'blocking' as const } } } };

const FROZEN: FrozenTests = { sha: 'sha-1', files: { 'src/export.test.ts': 'f1', 'vitest.config.ts': 'f2' } };
const LATER: FrozenTests = { sha: 'sha-2', files: { 'src/export.test.ts': 'f9', 'src/other.test.ts': 'f3' } };

function ev<T extends EventType>(type: T, payload: EventPayloads[T], signed: { actor?: string; roles?: readonly Role[] } = {}): FactoryEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint: 'trusted', ...signed, payload } as FactoryEvent;
}
function ticket(patch: Partial<TicketState> = {}): TicketState {
  return { ...newTicketState('p', 'REL-1', 'Titre', 'dev', 0), delegated: true, linearSessionId: 's-dev', ...patch };
}
const frozenPatch = (out: ReturnType<typeof decide>) =>
  out.events.flatMap((e) => (e.type === 'ticket.patched' && 'frozenTests' in e.patch ? [e.patch.frozenTests] : []));
const refreeze = (frozen: FrozenTests | undefined, signed: { actor?: string; roles?: readonly Role[] }) =>
  ev('command', { name: REFREEZE, body: '', linearSessionId: 's-q', author: 'Lilian', ...(frozen ? { frozen } : {}) }, signed);

describe('decide — the freeze of the tests (ORC-131)', () => {
  it('a verified red freezes the tests, and the build starts', () => {
    const out = decide(ticket({ verifyingRunId: 'r1' }), ev('verify.passed', { runId: 'r1', job: 'tests', red: 'assertion', frozen: FROZEN }), workflow);
    expect(frozenPatch(out)).toEqual([FROZEN]);
    expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'dev' }));
  });

  it('in measure mode, an unverified red freezes too: the freeze blocks from the first ticket', () => {
    const failed = ev('verify.failed', { runId: 'r1', job: 'tests', failures: [], red: 'compile', frozen: FROZEN });
    expect(frozenPatch(decide(ticket({ verifyingRunId: 'r1' }), failed, workflow))).toEqual([FROZEN]);
    // In blocking mode the step goes back to the tests: nothing is frozen yet.
    expect(frozenPatch(decide(ticket({ verifyingRunId: 'r1' }), failed, blocking))).toEqual([]);
  });

  it('a second freeze adds new files, and never changes a frozen one: only a human unfreezes (I3)', () => {
    const out = decide(ticket({ verifyingRunId: 'r1', frozenTests: FROZEN }), ev('verify.passed', { runId: 'r1', job: 'tests', red: 'assertion', frozen: LATER }), workflow);
    expect(frozenPatch(out)).toEqual([{ sha: 'sha-1', files: { 'src/other.test.ts': 'f3', 'src/export.test.ts': 'f1', 'vitest.config.ts': 'f2' } }]);
  });

  it('once frozen, the end of a dev run goes through the check even without verify commands', () => {
    const finished = ev('run.finished', { runId: 'r2', job: 'dev', outcome: 'success', costUsd: 0, turns: 1, lastText: '' });
    expect(decide(ticket({ activeRunId: 'r2', frozenTests: FROZEN }), finished, workflow).effects).toEqual([{ kind: 'run_verify', runId: 'r2', job: 'dev' }]);
    // Not frozen: as before.
    expect(decide(ticket({ activeRunId: 'r2' }), finished, workflow).effects).toContainEqual({ kind: 'move', to: 'human_review' });
  });

  it('/refreeze by a designated maintainer freezes the branch head, journaled', () => {
    const out = decide(ticket({ frozenTests: FROZEN }), refreeze(LATER, { actor: 'u-lead', roles: ['team_member', 'maintainer'] }), workflow);
    expect(frozenPatch(out)).toEqual([LATER]);
    expect(out.trace).toContain('refreeze by u-lead: 2 fichiers gelés à sha-2');
    expect(out.effects).toEqual([{ kind: 'activity', type: 'response', linearSessionId: 's-q', body: expect.stringMatching(/^Regelé : 2 fichiers/) }]);
    expect(out.effects).not.toContainEqual(expect.objectContaining({ kind: 'start_run' }));
  });

  it('/refreeze by anyone else is refused, journaled and answered in the ticket; the freeze stays', () => {
    for (const signed of [{ actor: 'u-dev', roles: ['team_member', 'repo_writer', 'repo_merger'] as Role[] }, { actor: 'u-dev' }, {}]) {
      const out = decide(ticket({ frozenTests: FROZEN }), refreeze(LATER, signed), workflow);
      expect(frozenPatch(out)).toEqual([]);
      expect(out.trace.some((t) => t.startsWith(`${AUTHZ_REFUSED}refreeze`))).toBe(true);
      expect(out.effects).toEqual([{ kind: 'activity', type: 'response', linearSessionId: 's-q', body: expect.stringMatching(/^Refusé : regeler les tests/) }]);
    }
  });

  it('/refreeze with no freeze or no branch to read answers so, and changes nothing', () => {
    const out = decide(ticket(), refreeze(undefined, { actor: 'u-lead', roles: ['maintainer'] }), workflow);
    expect(out.events).toEqual([]);
    expect(out.effects).toEqual([{ kind: 'activity', type: 'response', linearSessionId: 's-q', body: expect.stringMatching(/^Rien à regeler/) }]);
  });
});
