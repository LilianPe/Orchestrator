import { describe, expect, it, vi } from 'vitest';
import { fingerprint, FREEZE_CHECK, REFREEZE } from '../../src/checks/freeze.js';
import type { EventPayloads } from '../../src/core/types.js';
import { exportJournal } from '../../src/runtime/replay.js';
import { createHarness } from '../helpers/harness.js';

/**
 * ORC-131: after `red`, the tests and their harness are frozen; `factory/tests-gelés` blocks any change to them, the
 * agent's or a human's, from the first ticket, until a designated maintainer's `/refreeze`.
 */
const WORKTREE = '/tmp/factory-fake/p/REL-1';
const TEST = "it('exports', () => expect(toCsv([])).toBe(''));\n";
const CHANGED_TEST = TEST.replace('[]', '[1]');
const CONFIG = 'export default {};\n';
const AT_FREEZE = { 'src/export.test.ts': TEST, 'vitest.config.ts': CONFIG };
const LEAD = 'user-lilian';
const MEMBER = 'user-armand';

type Harness = ReturnType<typeof createHarness>;

/** A ticket, a designated maintainer and a member, the branch at `sha-freeze`. */
function ticketWithBranch(projectYaml?: string): Harness {
  const h = createHarness({
    authz: { maintainers: [LEAD], githubLogins: { [LEAD]: 'lilian-gh', [MEMBER]: 'armand-gh' } },
    ...(projectYaml ? { projectYaml } : {}),
  });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.tracker.setTeamMembers('REL', [LEAD, MEMBER]);
  h.forge.setRepoPermission('lilian-gh', 'write');
  h.forge.setRepoPermission('armand-gh', 'write');
  h.workspaces.heads.set(WORKTREE, 'sha-freeze');
  h.workspaces.steps.set(WORKTREE, { changed: [{ path: 'src/export.test.ts', deleted: false }], head: AT_FREEZE });
  return h;
}

/** The tests step (red measured) then dev, held so that a test can change the branch before its verification. */
async function frozenThenDev(): Promise<Harness> {
  const h = ticketWithBranch(`version: 1
on:
  ticket.delegated:
    - { when: "state in [todo, dev] && !blocked", run: tests }
  command:
    - { say: retester, run: tests }
`);
  h.checks.failNext('AssertionError: expected 1 to be 2');
  h.runner.enqueue({}, { hold: true });
  await h.send('ticket.delegated', { linearSessionId: 'as-1' }, 'REL-1', { actor: LEAD });
  // Sorted: a projection read from jsonb has its keys by length, not as written, and nothing reads the freeze in order.
  expect(Object.keys((await h.ticket()).frozenTests!.files).sort()).toEqual(['src/export.test.ts', 'vitest.config.ts']);
  return h;
}

/** The branch moves to `sha` with `files` changed since the freeze, then the held dev run ends. */
async function commitThenFinish(h: Harness, files: Record<string, string>): Promise<void> {
  h.workspaces.heads.set(WORKTREE, 'sha-dev');
  const head = { ...AT_FREEZE, ...files };
  h.workspaces.steps.set(`${WORKTREE}@sha-freeze`, { changed: Object.keys(files).map((path) => ({ path, deleted: false })), head });
  h.workspaces.steps.set(`${WORKTREE}@sha-dev`, { changed: [], head });
  h.runner.release(h.runner.requests[1]!.runId);
  await h.orch.drained();
}

const failures = async (h: Harness) =>
  (await exportJournal(h.store, 'p', 'REL-1')).entries.flatMap((e) => (e.event.type === 'verify.failed' ? (e.event.payload as EventPayloads['verify.failed']).failures.map((f) => f.command) : []));
const refreeze = (h: Harness, actor: string) =>
  h.send('command', { name: REFREEZE, body: 'le test était faux', linearSessionId: 'as-r', author: 'X' }, 'REL-1', { actor });

describe('the freeze of the tests (ORC-131)', () => {
  it('a test config changed after the freeze fails verify: nothing goes to review', async () => {
    const h = await frozenThenDev();
    await commitThenFinish(h, { 'vitest.config.ts': 'export default { test: { exclude: ["**/export*"] } };\n' });
    expect(await failures(h)).toContain(FREEZE_CHECK);
    expect(await h.ticket()).toMatchObject({ blocked: true, logical: 'dev' });
  });

  it('a human commit on a frozen test fails verify too, without /refreeze', async () => {
    const h = await frozenThenDev();
    await commitThenFinish(h, { 'src/export.test.ts': TEST.replace("it('", "it.skip('") });
    expect(await failures(h)).toContain(FREEZE_CHECK);
    expect((await h.ticket()).logical).not.toBe('human_review');
  });

  it('/refreeze by a non-maintainer is refused, journaled and answered; the freeze stays', async () => {
    const h = await frozenThenDev();
    await commitThenFinish(h, { 'src/export.test.ts': CHANGED_TEST });
    const before = (await h.ticket()).frozenTests;
    await refreeze(h, MEMBER);
    expect(h.tracker.activities('as-r')).toEqual([{ type: 'response', body: expect.stringMatching(/^Refusé : regeler les tests/) }]);
    expect((await h.ticket()).frozenTests).toEqual(before);
  });

  it('/refreeze by the maintainer regels the branch head, journaled, and the change no longer blocks', async () => {
    const h = await frozenThenDev();
    await commitThenFinish(h, { 'src/export.test.ts': CHANGED_TEST });
    expect(await h.ticket()).toMatchObject({ blocked: true });
    await refreeze(h, LEAD);
    expect(h.tracker.activities('as-r')).toEqual([{ type: 'response', body: expect.stringMatching(/^Regelé : 2 fichiers/) }]);
    const regeled = (await h.ticket()).frozenTests!;
    expect(regeled.sha).toBe('sha-dev');
    expect(regeled.files['src/export.test.ts']).toBe(fingerprint('src/export.test.ts', CHANGED_TEST));
    const journaled = (await h.store.recentEvents(50, 'REL-1')).find((e) => e.type === 'command');
    expect(journaled).toMatchObject({ actor: LEAD, roles: expect.arrayContaining(['maintainer']), payload: { frozen: { sha: 'sha-dev' } } });
    // Relaunched, the run's verification reads from the new freeze: unchanged since.
    await h.send('session.prompted', { linearSessionId: 'as-1', body: 'reprends', author: 'Lilian' }, 'REL-1', { actor: LEAD });
    const passed = (await exportJournal(h.store, 'p', 'REL-1')).entries.filter((e) => e.event.type === 'verify.passed').map((e) => e.event.payload);
    expect(passed.at(-1)).toMatchObject({ job: 'dev' });
    expect((await h.ticket()).blocked).toBe(false);
  });

  it('/refreeze still works once the frozen commit is gone from the repository: it reads the head alone', async () => {
    const h = await frozenThenDev();
    await commitThenFinish(h, { 'src/export.test.ts': CHANGED_TEST });
    const diff = h.workspaces.stepDiff.bind(h.workspaces);
    vi.spyOn(h.workspaces, 'stepDiff').mockImplementation(async (repo, path, base) => {
      if (base === 'sha-freeze') throw new Error('fatal: bad object sha-freeze');
      return diff(repo, path, base);
    });
    await refreeze(h, LEAD);
    expect(h.tracker.activities('as-r')).toEqual([{ type: 'response', body: expect.stringMatching(/^Regelé : 2 fichiers/) }]);
    expect((await h.ticket()).frozenTests?.sha).toBe('sha-dev');
  });

  it('a later tests step adds its new tests to the freeze, not a harness file added since: the check keeps failing on it', async () => {
    const h = await frozenThenDev();
    const added = { 'src/new.test.ts': TEST, 'jest.config.js': 'module.exports = { testPathIgnorePatterns: ["export"] };\n' };
    await commitThenFinish(h, added);
    expect(await h.ticket()).toMatchObject({ blocked: true });
    h.workspaces.steps.set(`${WORKTREE}@sha-dev`, { changed: Object.keys(added).map((path) => ({ path, deleted: false })), head: { ...AT_FREEZE, ...added } });
    h.checks.failNext('AssertionError: expected 1 to be 2');
    h.runner.enqueue({});
    h.runner.enqueue({}, { hold: true });
    await h.send('command', { name: 'retester', body: '', linearSessionId: 'as-t', author: 'X' }, 'REL-1', { actor: LEAD });
    const frozen = (await h.ticket()).frozenTests!;
    expect(frozen.sha).toBe('sha-freeze');
    expect(Object.keys(frozen.files).sort()).toEqual(['src/export.test.ts', 'src/new.test.ts', 'vitest.config.ts']);
  });

  it('/refreeze on a ticket never frozen opens no freeze: it is a way out, not a way in', async () => {
    const h = ticketWithBranch();
    h.runner.enqueue({});
    await h.send('ticket.delegated', { linearSessionId: 'as-1' }, 'REL-1', { actor: LEAD });
    expect((await h.ticket()).worktreePath).toBe(WORKTREE);
    await refreeze(h, LEAD);
    expect(h.tracker.activities('as-r')).toEqual([{ type: 'response', body: expect.stringMatching(/^Rien à regeler/) }]);
    expect((await h.ticket()).frozenTests).toBeUndefined();
  });
});
