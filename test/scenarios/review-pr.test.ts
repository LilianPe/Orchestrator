import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PrRefsRequest } from '../../src/adapters/workspace/pr-refs.js';
import { PR_TARGET } from '../../src/core/pr-state.js';
import { createHarness } from '../helpers/harness.js';

type H = ReturnType<typeof createHarness>;

/** The factory's side of the PR refs (ORC-322): what each call asked, and the heads it answers. */
function prRefs(heads: { head: string; base: string }[]) {
  const calls: Omit<PrRefsRequest, 'inWorktree'>[] = [];
  return {
    calls,
    bring: async ({ inWorktree: _w, ...req }: PrRefsRequest) => {
      calls.push(req);
      return heads.length > 1 ? heads.shift()! : heads[0]!;
    },
  };
}

async function toReview(h: H): Promise<void> {
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
  await h.send('status.changed', { from: 'human_review', to: 'ai_review' });
}

const reviewRun = (h: H) => h.runner.requests.find((r) => r.prompt.startsWith('/factory:review\n'))!;

/** ORC-322: the review runs at claude-api; the factory reads its PR and brings its head and base before it starts. */
describe('a review without network', () => {
  it("opens the review's sandbox at claude-api, with the PR refs dir mounted read-only", async () => {
    const refs = prRefs([{ head: 'a'.repeat(40), base: 'b'.repeat(40) }]);
    const h = createHarness({ sandboxed: true, prRefs: refs.bring });
    await toReview(h);
    const review = reviewRun(h);
    const box = h.sandboxes.created.find((c) => c.runId === review.runId)!;
    expect(box.network).toBe('claude-api');
    expect(box.mounts).toContainEqual({ host: join(h.runsDir!, review.runId, 'pr'), target: PR_TARGET, readOnly: true });
    // The dev run has no PR to read: only the review mounts it.
    expect(h.sandboxes.created[0]!.mounts.some((m) => m.target === PR_TARGET)).toBe(false);
  });

  it("brings the PR's head and base into the worktree, from the repository the launch has just fetched", async () => {
    const refs = prRefs([{ head: 'a'.repeat(40), base: 'b'.repeat(40) }]);
    const h = createHarness({ sandboxed: true, prRefs: refs.bring });
    await toReview(h);
    const review = reviewRun(h);
    const branch = (await h.ticket()).branch!;
    expect(refs.calls).toEqual([{ repoPath: '/repo', branch, base: 'main', bundleDir: join(h.runsDir!, review.runId, 'pr'), bundleTarget: PR_TARGET, fetch: false }]);
  });

  it("puts the PR's state in the prompt: number, state, base, mergeable, URL, the heads brought", async () => {
    const refs = prRefs([{ head: 'a'.repeat(40), base: 'b'.repeat(40) }]);
    const h = createHarness({ sandboxed: true, prRefs: refs.bring });
    await toReview(h);
    const { prompt } = reviewRun(h);
    const pr = await h.forge.findPr('/repo', (await h.ticket()).branch!);
    expect(prompt).toContain('## Pull request');
    expect(prompt).toContain(`#${pr!.number} — OPEN — base \`main\` — mergeable: MERGEABLE (CLEAN)`);
    expect(prompt).toContain(pr!.url);
    expect(prompt).toContain(`at ${'a'.repeat(12)}`);
    expect(prompt).toContain(`\`origin/main\` at ${'b'.repeat(12)}`);
    expect(prompt).toContain('factory-agent pr');
  });

  it('still starts the review when the forge cannot say whether the PR is mergeable, and says so', async () => {
    const refs = prRefs([{ head: 'a'.repeat(40), base: 'b'.repeat(40) }]);
    const h = createHarness({ sandboxed: true, prRefs: refs.bring });
    h.forge.mergeState = async () => Promise.reject(new Error('forge unreachable'));
    await toReview(h);
    const { prompt } = reviewRun(h);
    expect(prompt).toContain('## Pull request');
    expect(prompt).toMatch(/not read by the factory: its base and mergeability[\s\S]*factory-agent pr/);
  });

  it('tells a forge that does not answer from a ticket without a PR', async () => {
    const h = createHarness({ sandboxed: true, prRefs: prRefs([{ head: 'a'.repeat(40), base: 'b'.repeat(40) }]).bring });
    h.runner.enqueue({}, { hold: true });
    await toReview(h);
    h.forge.findPr = async () => Promise.reject(new Error('forge unreachable'));
    const run = (await h.store.getRun(reviewRun(h).runId))!;
    expect(await h.orch.agentPrState(run)).toEqual({ unreadable: true });
  });

  it('says in the prompt that the PR could not be read, rather than nothing', async () => {
    const h = createHarness({ sandboxed: true, prRefs: prRefs([{ head: 'a'.repeat(40), base: 'b'.repeat(40) }]).bring });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const findPr = h.forge.findPr.bind(h.forge);
    h.forge.findPr = async () => Promise.reject(new Error('forge unreachable'));
    await h.send('status.changed', { from: 'human_review', to: 'ai_review' });
    h.forge.findPr = findPr;
    expect(reviewRun(h).prompt).toMatch(/## Pull request\nThe factory could not read the PR[\s\S]*factory-agent pr/);
  });

  it('brings the PR once for two factory-agent pr asked at the same time', async () => {
    const refs = prRefs([{ head: 'a'.repeat(40), base: 'b'.repeat(40) }]);
    const h = createHarness({ sandboxed: true, prRefs: refs.bring });
    h.runner.enqueue({}, { hold: true });
    await toReview(h);
    const run = (await h.store.getRun(reviewRun(h).runId))!;
    const before = refs.calls.length;
    const [a, b] = await Promise.all([h.orch.agentPrState(run), h.orch.agentPrState(run)]);
    expect(a).toEqual(b);
    expect(refs.calls.length - before).toBe(1);
  });

  it('gives a dev run no PR section', async () => {
    const h = createHarness({ sandboxed: true, prRefs: prRefs([{ head: 'a'.repeat(40), base: 'b'.repeat(40) }]).bring });
    await toReview(h);
    expect(h.runner.requests[0]!.prompt).not.toContain('## Pull request');
  });

  it('answers factory-agent pr with the new head after a human push, by a fetch of the factory alone', async () => {
    const refs = prRefs([
      { head: 'a'.repeat(40), base: 'b'.repeat(40) },
      { head: 'c'.repeat(40), base: 'b'.repeat(40) },
    ]);
    const h = createHarness({ sandboxed: true, prRefs: refs.bring });
    // The review still running: its sandbox is alive when its agent asks.
    h.runner.enqueue({}, { hold: true });
    await toReview(h);
    const run = (await h.store.getRun(reviewRun(h).runId))!;
    expect(run.status).toBe('running');
    const state = await h.orch.agentPrState(run);
    expect(state).toMatchObject({ state: 'OPEN', base: 'main', head: 'c'.repeat(40) });
    expect(refs.calls.at(-1)).toMatchObject({ fetch: true, bundleTarget: PR_TARGET });
  });
});
