import { describe, expect, it } from 'vitest';
import type { AgentOutput } from '../../src/core/agent-output.js';
import { createHarness } from '../helpers/harness.js';
import { githubDelivery, githubIngest, pullRequestBody } from '../helpers/github-webhook.js';

/**
 * ORC-146: a conflict of the factory's PR with the default branch arrives in the inbox (ORC-134), and the engine starts a
 * rebase step: the agent rebases in its sandbox, `verify` checks the result, and only then does the factory publish it, over
 * the head it published itself. A conflict it must not resolve blocks the ticket with the standard comment.
 */
type Harness = ReturnType<typeof createHarness>;
const WORKTREE = '/tmp/factory-fake/p/REL-1';
const DONE: AgentOutput = { status: 'done', summary: 'Rebased on main: two hunks in src/export.ts.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [] };

/** REL-1 delegated, built, published by the factory on `published`, in Human Review. */
async function inReview(h: Harness, published = 'built1'): Promise<void> {
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.workspaces.heads.set(WORKTREE, published);
  h.runner.enqueue({ events: [{ kind: 'text', text: 'Built.' }] });
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
}

/** GitHub says the PR conflicts with its base: a signed `pull_request` delivery, through the daemon's ingestion. */
async function conflict(h: Harness, head = 'head1'): Promise<void> {
  const { raw, headers } = githubDelivery('pull_request', pullRequestBody('synchronize', { number: 1, mergeable_state: 'dirty', head }));
  expect(await githubIngest(h.store, (e) => h.orch.accept(e), h.forge, () => h.clock.now())(raw, headers)).toEqual({ status: 200 });
  await h.orch.drained();
}

const prompts = (h: Harness) => h.runner.requests.map((r) => r.prompt.split('\n')[0]);
const journal = async (h: Harness) => (await h.store.recentEvents(200, 'REL-1')).map((e) => ({ type: e.type, job: (e.payload as { job?: string }).job })).reverse();

describe('a conflict with the default branch: the rebase step (ORC-146)', () => {
  it('criteria 1 and 2: the conflict starts the rebase step, whose commit goes through verify, then out over the head the factory published', async () => {
    const h = createHarness();
    await inReview(h);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', prNumber: 1, verifiedSha: 'built1' });

    h.runner.enqueue({ output: DONE, events: [{ kind: 'text', text: 'Rebased.' }] });
    h.workspaces.heads.set(WORKTREE, 'rebased1');
    await conflict(h);

    expect(prompts(h)).toEqual(['/factory:dev', '/factory:rebase']);
    // In the ticket's sandbox and worktree, as every dev-queue step.
    expect(h.runner.requests[1]).toMatchObject({ cwd: WORKTREE });
    const types = await journal(h);
    const verified = types.findIndex((e) => e.type === 'verify.passed' && e.job === 'rebase');
    const published = types.findIndex((e) => e.type === 'publish.done' && e.job === 'rebase');
    expect(verified).toBeGreaterThan(-1);
    expect(published).toBeGreaterThan(verified);
    expect(h.publisher.published.at(-1)).toMatchObject({ sha: 'rebased1', rewrites: 'built1' });
    const t = await h.ticket();
    expect(t).toMatchObject({ logical: 'human_review', blocked: false, verifiedSha: 'rebased1', ciFixAttempts: 1 });
  });

  it('criterion 2: a rebase whose checks fail is not published: the step goes back to the agent with the failures', async () => {
    const failing = { ok: false, failures: [{ command: 'npm test', exitCode: 1, output: 'red' }] };
    let calls = 0;
    const h = createHarness({ sandboxed: true, cleanVerify: async () => (++calls === 2 ? { ...failing, sha: 'rebased1', tree: 't' } : { ok: true, failures: [], sha: calls === 1 ? 'built1' : 'rebased2', tree: 't' }) });
    await inReview(h);
    h.runner.enqueue({ output: DONE }, { output: DONE });
    await conflict(h);
    expect(prompts(h)).toEqual(['/factory:dev', '/factory:rebase', '/factory:rebase']);
    expect(h.runner.requests[2]!.prompt).toContain('## Failed checks');
    expect(h.publisher.published.map((p) => p.sha)).toEqual(['built1', 'rebased2']);
  });

  it.each(['logic', 'migrations', 'scope'] as const)('criterion 3: a %s conflict blocks the ticket with the standard comment, nothing published', async (kind) => {
    const h = createHarness();
    await inReview(h);
    h.runner.enqueue({ output: { ...DONE, status: 'blocked', reason: 'conflict', conflict: kind, question: 'Which side of src/export.ts wins?' } });
    await conflict(h);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: true, blockKind: 'conflict', blockedJob: 'rebase' });
    expect(h.publisher.published).toHaveLength(1);
    const comment = h.tracker.comments('REL-1').at(-1)!;
    expect(comment).toMatch(/^🔴 Blocked at step rebase/);
    expect(comment).toContain('Question: Which side of src/export.ts wins?');
    expect((await h.tracker.getIssue('REL-1')).labels).toContain('Bloqué');
  });

  it('criterion 4: a conflict during another step leaves its run alone; the rebase starts once that work is out', async () => {
    const h = createHarness();
    await inReview(h);
    h.runner.enqueue({ hold: true }, { output: DONE });
    // Human feedback in Human Review: its fix after the debounce (ORC-190).
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'Rename the column.', author: 'L', kind: 'instruction' });
    await h.advance(180_000);
    const feedback = (await h.ticket()).activeRunId!;
    expect(prompts(h)).toEqual(['/factory:dev', '/factory:feedback']);

    await conflict(h);
    // The running agent gets nothing of the conflict, and nothing starts beside it.
    expect(prompts(h)).toEqual(['/factory:dev', '/factory:feedback']);
    expect(await h.ticket()).toMatchObject({ activeRunId: feedback, pendingJob: { job: 'rebase' } });

    h.runner.release(feedback);
    await h.orch.drained();
    expect(prompts(h)).toEqual(['/factory:dev', '/factory:feedback', '/factory:rebase']);
  });

  it('the rebases share the bound of the review and CI loop: past it, a conflict blocks the ticket and starts nothing', async () => {
    const h = createHarness();
    await inReview(h);
    h.runner.enqueue({ output: DONE }, { output: DONE });
    for (const head of ['h1', 'h2', 'h3']) await conflict(h, head);
    expect(prompts(h)).toEqual(['/factory:dev', '/factory:rebase', '/factory:rebase']);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockKind: 'conflict', ciFixAttempts: 2 });
  });
});
