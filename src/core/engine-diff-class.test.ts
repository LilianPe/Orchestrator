import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REFREEZE, type FrozenTests } from '../checks/freeze.js';
import { loadWorkflow } from '../config/load-workflow.js';
import type { ClassifiedDiff } from './diff-class.js';
import { decide } from './engine.js';
import { reduce } from './reduce.js';
import { newTicketState, SCHEMA_VERSION, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });

function ev<T extends EventType>(type: T, payload: EventPayloads[T], signed: Partial<FactoryEvent> = {}): FactoryEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint: 'trusted', ...signed, payload } as FactoryEvent;
}

function verifying(patch: Partial<TicketState> = {}): TicketState {
  return { ...newTicketState('p', 'REL-1', 'Titre', 'dev', 0), delegated: true, linearSessionId: 's-dev', branch: 'factory/rel-1-titre', worktreePath: '/w', verifyingRunId: 'r1', ...patch };
}

const CONFIG: ClassifiedDiff = { class: 'verification-config', paths: ['vitest.config.ts'] };
const SENSITIVE: ClassifiedDiff = { class: 'sensitive', paths: ['src/auth/login.ts'] };
const FROZEN: FrozenTests = { sha: 'sha-1', files: { 'vitest.config.ts': 'f2' } };
const passed = (diffClass?: ClassifiedDiff, sha = 'abc') => ev('verify.passed', { runId: 'r1', job: 'dev', sha, ...(diffClass ? { diffClass } : {}) });
const after = (t: TicketState, event: FactoryEvent, decision: ReturnType<typeof decide>) => decision.events.reduce<TicketState | undefined>((s, e) => reduce(s, e), reduce(t, event))!;
const publishes = (out: ReturnType<typeof decide>) => out.effects.some((e) => e.kind === 'publish');

describe('decide — the class of the diff verify read (ORC-198)', () => {
  it('records the class with the commit found green', () => {
    const t = verifying();
    const event = passed(SENSITIVE);
    expect(after(t, event, decide(t, event, workflow))).toMatchObject({ verifiedSha: 'abc', diffClass: SENSITIVE });
  });

  it.each([
    ['a normal diff', { class: 'normal', paths: [] } as ClassifiedDiff],
    ['a sensitive diff', SENSITIVE],
    ['a diff verified before ORC-198, with no class', undefined],
  ])('publishes %s: its approval is the human review, as for any PR', (_case, diffClass) => {
    expect(publishes(decide(verifying(), passed(diffClass), workflow))).toBe(true);
  });

  it("holds a verification-config diff before publication until a maintainer's /refreeze: blocked, naming the paths and the command", () => {
    const t = verifying({ frozenTests: FROZEN });
    const out = decide(t, passed(CONFIG), workflow);
    expect(publishes(out)).toBe(false);
    const state = after(t, passed(CONFIG), out);
    expect(state.blocked).toBe(true);
    expect(state.blockReason).toContain('`vitest.config.ts`');
    expect(state.blockReason).toContain(REFREEZE);
    // The move the job owed comes with the relaunch, as after a refused publication.
    expect(state.owedMove).toBe('ai_review');
    expect(state.verifyingRunId).toBeUndefined();
  });

  it("publishes a verification-config diff once the freeze is a maintainer's /refreeze: the freeze check keeps the harness as approved", () => {
    expect(publishes(decide(verifying({ frozenTests: { ...FROZEN, refrozenBy: 'u-lead' } }), passed(CONFIG), workflow))).toBe(true);
  });

  it('a verdict on a commit already classified, without a class of its own (a commit found green again), keeps the gate', () => {
    expect(publishes(decide(verifying({ verifiedSha: 'abc', diffClass: CONFIG }), passed(undefined, 'abc'), workflow))).toBe(false);
    // Another commit: the class read before says nothing of it.
    expect(publishes(decide(verifying({ verifiedSha: 'old', diffClass: CONFIG }), passed(undefined, 'abc'), workflow))).toBe(true);
  });

  it('/refreeze records the maintainer who made it, which the gate reads', () => {
    const command = ev('command', { name: REFREEZE, body: '', linearSessionId: 's-q', author: 'Lilian', frozen: FROZEN }, { actor: 'u-lead', roles: ['maintainer'] });
    const out = decide(verifying({ verifyingRunId: undefined, frozenTests: FROZEN }), command, workflow);
    expect(out.events).toContainEqual({ type: 'ticket.patched', patch: { frozenTests: { ...FROZEN, refrozenBy: 'u-lead' } } });
  });

  it('an automatic freeze after a refreeze keeps who refroze: it adds tests, never harness', () => {
    const t = verifying({ frozenTests: { ...FROZEN, refrozenBy: 'u-lead' } });
    const event = ev('verify.passed', { runId: 'r1', job: 'tests', red: 'assertion', frozen: { sha: 'sha-2', files: { 'a.test.ts': 'f3' } } });
    expect(after(t, event, decide(t, event, workflow)).frozenTests?.refrozenBy).toBe('u-lead');
  });
});
