import { describe, expect, it } from 'vitest';
import { measureTicket } from '../../src/core/measures.js';
import { exportJournal } from '../../src/runtime/replay.js';
import { createHarness } from '../helpers/harness.js';

const WORKTREE = '/tmp/factory-fake/p/REL-1';
const SYNTAX = 'FAIL src/export.test.ts\nError: Transform failed with 1 error';

/** A project whose delegation runs the `tests` step first (ORC-123), its red check in `mode`. */
function harness(mode: 'measure' | 'blocking' = 'measure') {
  const h = createHarness({
    projectYaml: `version: 1
on:
  ticket.delegated:
    - { when: "state in [todo, dev] && !blocked", run: tests }
jobs:
  tests:
    red: { mode: ${mode} }
`,
  });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.workspaces.trunkDiffs.set(WORKTREE, { changed: [{ path: 'src/export.test.ts', deleted: false }] });
  return h;
}

const skills = (h: ReturnType<typeof createHarness>) => h.runner.requests.map((r) => r.prompt.split('\n')[0]);
const traces = async (h: ReturnType<typeof createHarness>) => (await exportJournal(h.store, 'p', 'REL-1')).entries.flatMap((e) => e.decision?.trace ?? []);

describe('the tests step and the red check (ORC-123)', () => {
  it('a red on an assertion is verified, and the build starts', async () => {
    const h = harness();
    h.checks.failNext('AssertionError: expected 1 to be 2');
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.checks.calls.map((c) => c.commands)).toEqual([["npm test -- 'src/export.test.ts'"]]);
    expect(skills(h)).toEqual(['/factory:tests', '/factory:dev']);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
    expect((await measureTicket(h.store, 'p', 'REL-1')).red).toEqual([{ id: expect.any(String), verified: true, cause: 'assertion' }]);
  });

  it('in measure mode, an unverified red is recorded « aurait bloqué » and the build goes on', async () => {
    const h = harness();
    h.checks.failNext(SYNTAX);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(skills(h)).toEqual(['/factory:tests', '/factory:dev']);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
    expect(await traces(h)).toContain('red: aurait bloqué (compile), mode mesure : le run continue');
    expect((await measureTicket(h.store, 'p', 'REL-1')).red).toEqual([{ id: expect.any(String), verified: false, cause: 'compile' }]);
  });

  it('in blocking mode, 2 unverified reds block the ticket', async () => {
    const h = harness('blocking');
    h.checks.failNext(SYNTAX);
    h.checks.failNext(SYNTAX);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(skills(h)).toEqual(['/factory:tests', '/factory:tests']);
    expect(h.runner.requests[1]).toMatchObject({ resume: true });
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Rouge non vérifié après 2 tentatives de tests.' });
  });

  it('a tests step that touched a file outside the tests fails, without running anything', async () => {
    const h = harness();
    h.workspaces.trunkDiffs.set(WORKTREE, { changed: [{ path: 'src/export.test.ts', deleted: false }, { path: 'src/export.ts', deleted: false }] });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.checks.calls).toEqual([]);
    expect(skills(h)).toEqual(['/factory:tests', '/factory:tests']);
    expect(await h.ticket()).toMatchObject({ blocked: true });
  });
});
