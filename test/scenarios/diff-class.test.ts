import { describe, expect, it } from 'vitest';
import { FREEZE_CHECK, REFREEZE } from '../../src/checks/freeze.js';
import { REVIEW_LABELS, sampled } from '../../src/core/diff-class.js';
import type { EventPayloads } from '../../src/core/types.js';
import { exportJournal } from '../../src/runtime/replay.js';
import { createHarness } from '../helpers/harness.js';

/**
 * ORC-198: the factory classifies the diff it verified (normal, sensitive, verification configuration), holds a diff of the
 * verification configuration before publication until a designated maintainer's `/refreeze`, and labels each PR it sends to
 * Human Review `revue: requise | échantillon | auto`, one label of the group at a time. Every PR still goes through Human Review.
 */
type Harness = ReturnType<typeof createHarness>;
const WORKTREE = '/tmp/factory-fake/p/REL-1';
const SHA = 'abc123';
const LEAD = 'user-lilian';
const CONFIG = 'export default { test: { exclude: ["**/export*"] } };\n';

/** A ticket whose dev run commits `SHA`, changing `paths` from the fork point, under `sensitive_paths: ["src/auth/**"]`. */
function changing(paths: string[]): Harness {
  const h = createHarness({ authz: { maintainers: [LEAD], githubLogins: { [LEAD]: 'lilian-gh' } } });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.tracker.setTeamMembers('REL', [LEAD]);
  h.forge.setRepoPermission('lilian-gh', 'write');
  h.workspaces.heads.set(WORKTREE, SHA);
  h.workspaces.branches.set(WORKTREE, { changed: paths.map((path) => ({ path, deleted: false })), baseConfig: 'sensitive_paths: ["src/auth/**"]\n' });
  h.runner.enqueue({});
  return h;
}

const delegate = (h: Harness) => h.send('ticket.delegated', { linearSessionId: 'as-1' }, 'REL-1', { actor: LEAD });
const reviewLabels = (h: Harness) => h.forge.labelsOf(1).filter((l) => (REVIEW_LABELS as readonly string[]).includes(l));

describe('the class of the diff and the review label (ORC-198)', () => {
  it('a normal diff: Human Review with the drawn label, one of the group, and no merge', async () => {
    const h = changing(['src/export.ts']);
    await delegate(h);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', prNumber: 1, diffClass: { class: 'normal', paths: [] } });
    expect(reviewLabels(h)).toEqual([sampled('REL-1') ? 'revue: échantillon' : 'revue: auto']);
    expect(h.forge.merges).toEqual([]);
  });

  it('a diff on sensitive_paths: revue: requise, and Human Review as any PR', async () => {
    const h = changing(['src/export.ts', 'src/auth/login.ts']);
    await delegate(h);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', diffClass: { class: 'sensitive', paths: ['src/auth/login.ts'] } });
    expect(reviewLabels(h)).toEqual(['revue: requise']);
    expect(h.forge.merges).toEqual([]);
  });

  it('blocking findings of the AI review on the commit shown: revue: requise', async () => {
    const h = changing(['src/export.ts']);
    await h.store.putFindings({ projectId: 'p', ticketId: 'REL-1', sha: SHA, lens: 'correctness', runId: 'rv', at: 0, findings: [{ file: 'src/export.ts', line: 1, severity: 'blocking', explanation: 'wrong', suggestion: '' }] });
    await delegate(h);
    expect(reviewLabels(h)).toEqual(['revue: requise']);
  });

  it("a diff of the verification configuration waits for a maintainer's /refreeze before publication, then goes out labelled revue: requise", async () => {
    const h = changing(['src/export.ts', 'vitest.config.ts']);
    h.workspaces.steps.set(WORKTREE, { changed: [], head: { 'vitest.config.ts': CONFIG } });
    await delegate(h);
    expect(h.publisher.published).toEqual([]);
    const held = await h.ticket();
    expect(held).toMatchObject({ blocked: true, diffClass: { class: 'verification-config', paths: ['vitest.config.ts'] } });
    expect(held.blockReason).toContain(REFREEZE);

    // The maintainer's /refreeze freezes the harness as it is at the head, which the freeze check holds from then on.
    await h.send('command', { name: REFREEZE, body: 'config relue', linearSessionId: 'as-r', author: 'Lilian' }, 'REL-1', { actor: LEAD });
    expect(h.tracker.activities('as-r')).toEqual([{ type: 'response', body: expect.stringMatching(/^Refrozen: 1 files/) }]);
    expect((await h.ticket()).frozenTests).toMatchObject({ sha: SHA, refrozenBy: LEAD, files: { 'vitest.config.ts': expect.any(String) } });

    h.runner.enqueue({});
    await h.send('session.prompted', { linearSessionId: 'as-1', body: 'reprends', author: 'Lilian' }, 'REL-1', { actor: LEAD });
    expect(h.publisher.published).toHaveLength(1);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
    expect(reviewLabels(h)).toEqual(['revue: requise']);
    expect(h.forge.merges).toEqual([]);
  });

  it('after the /refreeze, a harness changed again fails the freeze check: the loop cannot loosen what was approved', async () => {
    const h = changing(['vitest.config.ts']);
    h.workspaces.steps.set(WORKTREE, { changed: [], head: { 'vitest.config.ts': 'export default {};\n' } });
    await delegate(h);
    await h.send('command', { name: REFREEZE, body: '', linearSessionId: 'as-r', author: 'Lilian' }, 'REL-1', { actor: LEAD });
    h.workspaces.heads.set(WORKTREE, 'sha-2');
    h.workspaces.steps.set(WORKTREE, { changed: [{ path: 'vitest.config.ts', deleted: false }], head: { 'vitest.config.ts': CONFIG } });
    h.runner.enqueue({});
    await h.send('session.prompted', { linearSessionId: 'as-1', body: 'reprends', author: 'Lilian' }, 'REL-1', { actor: LEAD });
    expect(h.publisher.published).toEqual([]);
    const failed = (await exportJournal(h.store, 'p', 'REL-1')).entries.flatMap((e) => (e.event.type === 'verify.failed' ? (e.event.payload as EventPayloads['verify.failed']).failures.map((f) => f.command) : []));
    expect(failed).toContain(FREEZE_CHECK);
  });
});
