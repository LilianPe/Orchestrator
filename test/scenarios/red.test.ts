import { describe, expect, it } from 'vitest';
import type { RepoVariables } from '../../src/config/repo-variables.js';
import { measureTicket } from '../../src/core/measures.js';
import { exportJournal } from '../../src/runtime/replay.js';
import { createHarness } from '../helpers/harness.js';
import { pythonRepoFiles } from '../helpers/python-repo.js';

const WORKTREE = '/tmp/factory-fake/p/REL-1';
const SYNTAX = 'FAIL src/export.test.ts\nError: Transform failed with 1 error';

/** A project whose delegation runs the `tests` step first (ORC-123), its red check in `mode`. */
function harness(mode: 'measure' | 'blocking' = 'measure', sandboxed = false, repoVariables?: () => Promise<RepoVariables>) {
  const h = createHarness({
    sandboxed,
    repoVariables,
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
  h.workspaces.heads.set(WORKTREE, 'base-sha');
  h.workspaces.steps.set(WORKTREE, { changed: [{ path: 'src/export.test.ts', deleted: false }] });
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
    expect(await traces(h)).toContain('red: would have blocked (compile), measure mode: the run goes on');
    expect((await measureTicket(h.store, 'p', 'REL-1')).red).toEqual([{ id: expect.any(String), verified: false, cause: 'compile' }]);
  });

  it('in blocking mode, the 3rd unverified red blocks the ticket (2 returns to the tests step)', async () => {
    const h = harness('blocking');
    for (let i = 0; i < 3; i++) h.checks.failNext(SYNTAX);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(skills(h)).toEqual(['/factory:tests', '/factory:tests', '/factory:tests']);
    expect(h.runner.requests[1]).toMatchObject({ resume: true });
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Red not verified after 3 attempts of tests.' });
  });

  it('in blocking mode, a tests step that touched a file outside the tests fails, without running anything', async () => {
    const h = harness('blocking');
    h.workspaces.steps.set(WORKTREE, { changed: [{ path: 'src/export.test.ts', deleted: false }], uncommitted: ['src/export.ts'] });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.checks.calls).toEqual([]);
    expect(skills(h)).toEqual(['/factory:tests', '/factory:tests', '/factory:tests']);
    expect(await h.ticket()).toMatchObject({ blocked: true });
  });

  it('in measure mode, the same step is recorded « aurait bloqué (scope) » and the build goes on', async () => {
    const h = harness();
    h.workspaces.steps.set(WORKTREE, { changed: [{ path: 'src/export.test.ts', deleted: false }, { path: 'src/export.ts', deleted: false }] });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(skills(h)).toEqual(['/factory:tests', '/factory:dev']);
    expect(await traces(h)).toContain('red: would have blocked (scope), measure mode: the run goes on');
  });

  it('a red check that cannot read the step blocks on the infrastructure, without resuming the agent', async () => {
    const h = harness();
    h.workspaces.steps.clear();
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(skills(h)).toEqual(['/factory:tests']);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: expect.stringContaining('infrastructure failure') });
  });

  it('runs the tests with the variables the repository declares, never its secrets (ORC-211)', async () => {
    const h = harness('measure', true, async () => ({ env: { NODE_ENV: 'test' }, setupSecrets: { REGISTRY_TOKEN: 'registry-secret' }, missing: [] }));
    h.sandboxes.execResult = (argv) => (argv[0] === 'git' ? { stdout: '', stderr: '', code: 0 } : { stdout: 'AssertionError: expected 1 to be 2', stderr: '', code: 1 });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const tests = h.sandboxes.execs.find((e) => e.argv.at(-1) === "npm test -- 'src/export.test.ts'");
    expect(tests!.opts!.env).toEqual({ NODE_ENV: 'test' });
  });

  it('with sandboxes, reads the uncommitted files and runs the tests in a sandbox of its own, without network', async () => {
    const h = harness('measure', true);
    h.sandboxes.execResult = (argv) => (argv[0] === 'git' ? { stdout: '', stderr: '', code: 0 } : { stdout: 'AssertionError: expected 1 to be 2', stderr: '', code: 1 });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.sandboxes.execs.map((e) => e.argv.at(-1))).toContain("npm test -- 'src/export.test.ts'");
    expect(h.checks.calls).toEqual([]);
    expect(skills(h)).toEqual(['/factory:tests', '/factory:dev']);
    expect((await measureTicket(h.store, 'p', 'REL-1')).red).toEqual([{ id: expect.any(String), verified: true, cause: 'assertion' }]);
  });

  it('in a sandbox, tests that exit 124 themselves, well before the cap, are read on their output, not as the cap (ORC-348)', async () => {
    const h = harness('measure', true);
    h.sandboxes.execResult = (argv) => (argv[0] === 'git' ? { stdout: '', stderr: '', code: 0 } : { stdout: 'AssertionError: expected 1 to be 2', stderr: '', code: 124 });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect((await measureTicket(h.store, 'p', 'REL-1')).red).toEqual([{ id: expect.any(String), verified: true, cause: 'assertion' }]);
  });
});

describe('the red check on a Python repository (ORC-172)', () => {
  const AUDIT_TEST = 'from app.audit import summary\n\n\ndef test_summary() -> None:\n    assert summary([]) == {}\n';
  /** pytest's collection error, as it prints it, on a test file that imports `module`. */
  const collectionError = (module: string) => `==================================== ERRORS ====================================
____________________ ERROR collecting tests/test_audit.py ______________________
ImportError while importing test module '/work/tests/test_audit.py'.
E   ModuleNotFoundError: No module named '${module}'
=========================== short test summary info ============================
ERROR tests/test_audit.py
!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!`;

  /** The fixture repository at baseSha, its tests step adding `tests/test_audit.py`, the red command `init` proposes for it. */
  function python() {
    const h = createHarness({
      projectYaml: `version: 1
on:
  ticket.delegated:
    - { when: "state in [todo, dev] && !blocked", run: tests }
jobs:
  tests:
    red: { command: "uv run --frozen pytest", mode: measure }
`,
    });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Audit summary', description: 'Résumer les scores des audits par identifiant dans un module à part.' });
    h.workspaces.heads.set(WORKTREE, 'base-sha');
    const base = pythonRepoFiles();
    h.workspaces.steps.set(WORKTREE, { changed: [{ path: 'tests/test_audit.py', deleted: false }], base, head: { ...base, 'tests/test_audit.py': AUDIT_TEST } });
    return h;
  }

  it('criterion 2: a ModuleNotFoundError on a module absent at baseSha is a verified red, and the build starts', async () => {
    const h = python();
    h.checks.failNext(collectionError('app.audit'));
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.checks.calls[0]!.commands[0]).toContain(`uv run --frozen pytest 'tests/test_audit.py' --junitxml=`);
    expect(skills(h)).toEqual(['/factory:tests', '/factory:dev']);
    expect((await measureTicket(h.store, 'p', 'REL-1')).red).toEqual([{ id: expect.any(String), verified: true, cause: 'missing_module' }]);
  });

  it('a module the repository has at baseSha is no red: the import is broken', async () => {
    const h = python();
    h.checks.failNext(collectionError('app.export'));
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect((await measureTicket(h.store, 'p', 'REL-1')).red).toEqual([{ id: expect.any(String), verified: false, cause: 'module_at_base' }]);
  });
});
