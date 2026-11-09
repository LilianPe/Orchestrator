import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FakeShooter, fakePng } from '../../src/adapters/browser/fake.js';
import type { AgentOutput } from '../../src/core/agent-output.js';
import type { CleanVerifyResult } from '../../src/core/clean-verify.js';
import { createHarness } from '../helpers/harness.js';

/**
 * ORC-197: the `after_merge` step, once the PR is merged. The requester hears it in the ticket's session, with the PR's
 * link; the changelog gets an entry, appended once and never changed, with the captures the factory took in `verify`.
 */
type Harness = ReturnType<typeof createHarness>;
const SHA = 'c0ffee'.padEnd(40, '0');
const BASE = 'ba5e'.padEnd(40, '0');
const WORKTREE = '/tmp/factory-fake/p/REL-1';
const PROFILE = 'https://linear.app/test/profiles/lilian';
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const dev = (summary: string, url?: string) => ({
  output: { status: 'done', summary, tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], ...(url ? { visual_scenario: { url, steps: ['open'] } } : {}) } satisfies AgentOutput,
});

/** Six captures as `runCleanVerify` returns them: before on the base, after on the commit. */
function taken(): NonNullable<CleanVerifyResult['visual']> {
  const files = (['before', 'after'] as const).flatMap((side) =>
    [1280, 768, 375].map((width) => {
      const png = fakePng(`${side}@${width}`);
      return { capture: { side, sha: side === 'before' ? BASE : SHA, width, sha256: sha256(png) }, png };
    }),
  );
  return { proof: { decision: 'required', triggers: ['app/settings.tsx'], captures: files.map((f) => f.capture) }, files };
}

function delivered(visual: CleanVerifyResult['visual'] | undefined, run = dev('Settings button restyled.', '/settings')) {
  const h = createHarness({
    sandboxed: true,
    visualShooter: new FakeShooter(),
    cleanVerify: async () => ({ ok: true, failures: [], sha: SHA, tree: 't', commands: [], ...(visual ? { visual } : {}) }),
  });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Restyle the button', creator: { id: 'u-1', name: 'Lilian', url: PROFILE } });
  h.workspaces.heads.set(WORKTREE, SHA);
  h.runner.enqueue(run);
  return h;
}

async function merge(h: Harness, mergeSha = 'f00d'.padEnd(40, '0')) {
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
  const { prNumber, prUrl } = await h.ticket();
  expect(prNumber).toBeDefined();
  await h.send('pr.merged', { number: prNumber!, url: prUrl!, branch: 'factory/rel-1-restyle-the-button', headSha: SHA, mergeSha, mergedAt: 1_700_000_000_000 });
  return { prNumber: prNumber!, prUrl: prUrl! };
}

const entries = (h: Harness) => h.store.changelog(0, Number.MAX_SAFE_INTEGER);

describe('the after_merge step (ORC-197)', () => {
  it('criterion 1: the requester is mentioned in the session with the link of the merged PR', async () => {
    const h = delivered(taken());
    const { prNumber, prUrl } = await merge(h);
    expect(h.tracker.activities('ls-1').at(-1)).toEqual({ type: 'response', body: `Delivered, ${PROFILE}: [PR #${prNumber}](${prUrl}) is merged.` });
  });

  it('criterion 2: an entry with what changed, where, the captures before and after and the links', async () => {
    const h = delivered(taken());
    const { prNumber, prUrl } = await merge(h);
    const artifacts = await h.store.artifacts('REL-1');
    const [entry, ...more] = await entries(h);
    expect(more).toEqual([]);
    expect(entry).toMatchObject({
      projectId: 'p', ticketId: 'REL-1', title: 'Restyle the button', summary: 'Settings button restyled.', prNumber, prUrl,
      mergeSha: 'f00d'.padEnd(40, '0'), page: '/settings', paths: ['app/settings.tsx'], at: 1_700_000_000_000,
    });
    const proof = entry!.visualProof;
    expect(proof.status).toBe('taken');
    const captures = proof.status === 'taken' ? proof.captures : [];
    expect(captures.map((c) => [c.side, c.sha, c.width])).toEqual([
      ['before', BASE, 1280], ['before', BASE, 768], ['before', BASE, 375],
      ['after', SHA, 1280], ['after', SHA, 768], ['after', SHA, 375],
    ]);
    // Each capture by the artifact the factory kept of it, the image itself never in the entry.
    for (const c of captures) expect(artifacts.find((a) => a.id === c.artifactId)).toMatchObject({ sha256: c.sha256, kind: 'visual-proof' });
  });

  it('without a visual proof, the entry says there is none applicable', async () => {
    const h = delivered({ proof: { decision: 'not_applicable', triggers: [] }, files: [] }, dev('CSV export.'));
    await merge(h);
    const [entry] = await entries(h);
    expect(entry).toMatchObject({ summary: 'CSV export.', paths: [], visualProof: { status: 'not_applicable' } });
    expect(entry).not.toHaveProperty('page');
  });

  it('a proof the factory could not take: the entry says why', async () => {
    const h = delivered({ proof: { decision: 'required', triggers: ['app/settings.tsx'], unavailable: 'this instance has no sandbox with a browser' }, files: [] });
    await merge(h);
    expect((await entries(h))[0]!.visualProof).toEqual({ status: 'unavailable', reason: 'this instance has no sandbox with a browser' });
  });

  it('criterion 3: an entry already there is not changed when a new one is added', async () => {
    const h = delivered(taken());
    await merge(h);
    const [first] = await entries(h);
    // Another PR of the same ticket, merged later: a new entry, the first one as it was.
    await h.send('pr.opened', { number: 9, url: 'https://gh/pr/9', branch: 'factory/rel-1-again' });
    await h.send('pr.merged', { number: 9, url: 'https://gh/pr/9', branch: 'factory/rel-1-again', mergedAt: 1_700_000_100_000 });
    const all = await entries(h);
    expect(all.map((e) => e.prNumber)).toEqual([9, first!.prNumber]);
    expect(all[1]).toEqual(first);
  });

  it('the entry is named by its effect, never by the installation salt of the keys written to Linear', async () => {
    const h = delivered(taken());
    await merge(h);
    const [entry] = await entries(h);
    expect(entry!.id).toMatch(/^REL-1:\d+:\d+$/);
  });

  it('a mention Linear refuses holds back neither the entry, nor the cleanup and learn behind it: logged, the step done', async () => {
    const h = delivered(taken());
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const { prNumber, prUrl } = await h.ticket();
    const activity = h.tracker.activity.bind(h.tracker);
    vi.spyOn(h.tracker, 'activity').mockImplementation((s, a, key) => ('body' in a && a.body.startsWith('Delivered') ? Promise.reject(new Error('Linear refused it')) : activity(s, a, key)));
    await h.send('pr.merged', { number: prNumber!, url: prUrl!, branch: 'factory/rel-1-restyle-the-button' });
    expect(await entries(h)).toHaveLength(1);
    expect(h.workspaces.cleaned).toEqual(['REL-1']);
    expect(h.runner.requests.at(-1)!.prompt.startsWith('/factory:learn\n')).toBe(true);
    expect(await h.ticket()).toMatchObject({ blocked: false, logical: 'done' });
  });

  it('a ticket whose creator Linear does not give is told without a mention', async () => {
    const h = delivered(taken());
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Restyle the button' });
    const { prNumber, prUrl } = await merge(h);
    expect(h.tracker.activities('ls-1').at(-1)).toEqual({ type: 'response', body: `Delivered: [PR #${prNumber}](${prUrl}) is merged.` });
  });
});
