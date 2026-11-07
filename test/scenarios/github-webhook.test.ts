import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PrPoller } from '../../src/adapters/forge/pr-poller.js';
import { measureTicket } from '../../src/core/measures.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import { createHarness } from '../helpers/harness.js';
import {
  BRANCH,
  checkRunBody,
  crashAfterGithubAck,
  defaultPushBody,
  githubDelivery,
  githubIngest,
  pullRequestBody,
  pushBody,
  sha,
  workflowRunBody,
} from '../helpers/github-webhook.js';

type Harness = ReturnType<typeof createHarness>;

/** REL-1 delegated; its dev run is held (`hold`) or goes to human review. */
async function delegated(h: Harness, hold = false) {
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.runner.enqueue(hold ? { hold: true } : { events: [{ kind: 'text', text: 'PR ouverte.' }] });
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
}

/** Posts a signed delivery to the daemon's GitHub ingestion, then lets the worker process it. */
async function post(h: Harness, name: string, body: unknown, secret?: string) {
  const { raw, headers } = githubDelivery(name, body, secret);
  const res = await githubIngest(h.store, (e) => h.orch.accept(e), h.forge, () => h.clock.now())(raw, headers);
  await h.orch.drained();
  return res;
}

const events = async (h: Harness, type: string) => (await h.store.recentEvents(100, 'REL-1')).filter((e) => e.type === type);

/** ORC-134: GitHub webhooks are written to the inbox before the answer, and the engine decides what follows. */
describe('GitHub webhooks', () => {
  it('criterion 1: a webhook answered 200 by a daemon killed with SIGKILL is processed once at the next start', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'factory-gh-inbox-')), 'factory.db');
    const h = createHarness({ store: new SqliteStore(file) });
    await delegated(h);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', branch: BRANCH });

    const { response, exited } = crashAfterGithubAck(file, 'pull_request', pullRequestBody('closed', { merged: true }));
    expect(response).toEqual({ status: 200 });
    expect(exited.status === 0 && exited.signal === null).toBe(false);
    expect((await h.store.pendingInbox(10)).map((e) => e.id)).toEqual(['pr:REL-1:3:opened', 'pr:REL-1:3:merged']);

    await h.restart();
    expect(await h.ticket()).toMatchObject({ logical: 'done', prState: 'MERGED', prNumber: 3 });
    expect(await h.store.pendingInbox(10)).toEqual([]);
    // GitHub redelivering it changes nothing.
    expect(await post(h, 'pull_request', pullRequestBody('closed', { merged: true }))).toEqual({ status: 200 });
    expect(await events(h, 'pr.merged')).toHaveLength(1);
  });

  it('criterion 2: a push on the agent branch by another identity than the App is a push.human in the inbox', async () => {
    const h = createHarness();
    await delegated(h);
    expect(await post(h, 'push', pushBody({ login: 'lilian', type: 'User' }))).toEqual({ status: 200 });
    // The factory's App (a bot) pushing is no human commit.
    expect(await post(h, 'push', pushBody({ login: 'factory-app[bot]', type: 'Bot' }, 'beef'))).toEqual({ status: 200 });
    const pushes = await events(h, 'push.human');
    expect(pushes).toMatchObject([{ id: 'push:REL-1:c0ffee', taint: 'untrusted', payload: { branch: BRANCH, sha: 'c0ffee', author: 'lilian' } }]);
    expect(h.runner.requests).toHaveLength(1);
  });

  it('criterion 3: pull_request.closed with merged=true marks the PR merged and delivers the ticket', async () => {
    const h = createHarness();
    await delegated(h);
    expect(await post(h, 'pull_request', pullRequestBody('closed', { merged: true }))).toEqual({ status: 200 });
    expect(await h.ticket()).toMatchObject({ logical: 'done', prState: 'MERGED', prNumber: 3, blocked: false });
  });

  it('criterion 4: a factory PR closed by a human without merge cancels the run', async () => {
    const h = createHarness();
    await delegated(h, true);
    expect((await h.ticket()).activeRunId).toBeDefined();
    expect(await post(h, 'pull_request', pullRequestBody('closed'))).toEqual({ status: 200 });
    const t = await h.ticket();
    expect(t).toMatchObject({ prState: 'CLOSED', blocked: true, blockReason: 'PR #3 closed without merge' });
    expect(t.activeRunId).toBeUndefined();
    expect((await events(h, 'run.finished'))[0]).toMatchObject({ payload: { outcome: 'stopped' } });
    expect(h.tracker.activities('ls-1').at(-1)).toMatchObject({ type: 'response', body: expect.stringContaining('closed without merge') });
  });

  it('criterion 5: red CI enters the inbox, and no running agent handles it on its own', async () => {
    const h = createHarness();
    await delegated(h, true);
    expect(await post(h, 'check_run', checkRunBody('failure'))).toEqual({ status: 200 });
    expect(await events(h, 'pr.checks_failed')).toMatchObject([{ id: 'pr:REL-1:3:checks:fail:head1', payload: { failures: ['test'] } }]);
    // In dev, the workflow has no rule for red CI: the running dev run gets nothing, no other run starts.
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.ticket()).toMatchObject({ ciFixAttempts: 0 });
  });

  it('criterion 5: in review, the engine answers red CI with fix-ci, within the red-CI bound', async () => {
    const h = createHarness();
    await delegated(h);
    for (const head of ['h1', 'h2', 'h3']) await post(h, 'check_run', checkRunBody('failure', { head }));
    // Two fix-ci (limits.ci_fix_attempts: 2), then the ticket is blocked.
    expect(h.runner.requests.map((r) => r.prompt.split('\n')[0])).toEqual(['/factory:dev', '/factory:fix-ci', '/factory:fix-ci']);
    expect(await h.ticket()).toMatchObject({ blocked: true, ciFixAttempts: 2 });
  });

  it('criterion 6: a webhook without a valid signature is refused and nothing is written', async () => {
    const h = createHarness();
    await delegated(h);
    const before = (await h.store.recentEvents(100)).length;
    const { raw, headers } = githubDelivery('pull_request', pullRequestBody('closed', { merged: true }));
    const ingest = githubIngest(h.store, (e) => h.orch.accept(e));
    expect(await ingest(raw, { ...headers, 'x-hub-signature-256': undefined })).toEqual({ status: 401 });
    expect(await post(h, 'pull_request', pullRequestBody('closed', { merged: true }), 'wrong-secret')).toEqual({ status: 401 });
    expect(await ingest(`${raw} `, headers)).toEqual({ status: 401 });
    expect(await h.store.pendingInbox(10)).toEqual([]);
    expect(await h.store.recentEvents(100)).toHaveLength(before);
    expect((await h.ticket()).prState).toBeUndefined();
  });

  it('reports a verdict once whether the webhook or the poll sees it first', async () => {
    const h = createHarness();
    await delegated(h);
    await post(h, 'check_run', checkRunBody('failure'));
    h.forge.setPr(BRANCH, { number: 3, url: 'https://github.com/acme/app/pull/3', state: 'OPEN', headSha: 'head1', checks: 'fail', failedChecks: ['test', 'lint'] });
    const poller = new PrPoller({ store: h.store, forge: h.forge, projects: [h.project], submit: (e) => h.orch.accept(e), clock: h.clock, log: () => {} });
    await poller.pollOnce();
    await h.orch.drained();
    expect(await events(h, 'pr.checks_failed')).toHaveLength(1);
    expect(h.runner.requests).toHaveLength(2);

    // Green: one green suite is not enough while the forge reads the PR as pending.
    h.forge.setPr(BRANCH, { number: 3, url: 'https://github.com/acme/app/pull/3', state: 'OPEN', headSha: 'head2', checks: 'pending', failedChecks: [] });
    await post(h, 'check_run', checkRunBody('success', { head: 'head2' }));
    expect(await events(h, 'pr.checks_passed')).toEqual([]);
    h.forge.setPr(BRANCH, { number: 3, url: 'https://github.com/acme/app/pull/3', state: 'OPEN', headSha: 'head2', checks: 'pass', failedChecks: [] });
    await post(h, 'check_run', checkRunBody('success', { head: 'head2', name: 'lint' }));
    await poller.pollOnce();
    await h.orch.drained();
    expect((await events(h, 'pr.checks_passed')).map((e) => e.id)).toEqual(['pr:REL-1:3:checks:pass:head2']);
  });

  it('writes reviews and conflicts to the inbox without reacting to them yet (ORC-190, ORC-146)', async () => {
    const h = createHarness();
    await delegated(h);
    const review = {
      ...pullRequestBody('submitted'),
      action: 'submitted',
      review: { id: 11, state: 'changes_requested', body: 'Renomme la fonction', user: { login: 'lilian', type: 'User' } },
    };
    await post(h, 'pull_request_review', review);
    await post(h, 'pull_request', pullRequestBody('synchronize', { mergeable_state: 'dirty' }));
    expect(await events(h, 'pr.reviewed')).toMatchObject([
      { id: 'pr:REL-1:3:review:11', taint: 'untrusted', payload: { kind: 'review', author: 'lilian', body: 'Renomme la fonction', state: 'changes_requested' } },
    ]);
    expect(await events(h, 'pr.conflicted')).toMatchObject([{ id: 'pr:REL-1:3:conflicted:head1:base1', payload: { headSha: 'head1', baseRef: 'main' } }]);
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false, humanInbox: [] });
  });

  it('cancels again a PR reopened, relaunched and closed again', async () => {
    const h = createHarness();
    await delegated(h);
    const at = (s: string) => ({ ...pullRequestBody('closed'), pull_request: { ...pullRequestBody('closed').pull_request, closed_at: s } });
    await post(h, 'pull_request', at('2026-10-28T10:00:00Z'));
    expect(await h.ticket()).toMatchObject({ prState: 'CLOSED', blocked: true });
    const reopened = pullRequestBody('reopened');
    reopened.pull_request.updated_at = '2026-10-28T11:00:00Z';
    await post(h, 'pull_request', reopened);
    expect(await h.ticket()).toMatchObject({ prState: 'OPEN', blocked: true });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.commented', { body: 'reprends', author: 'L', kind: 'instruction' });
    expect((await h.ticket()).activeRunId).toBeDefined();
    await post(h, 'pull_request', at('2026-10-28T12:00:00Z'));
    const t = await h.ticket();
    expect(t).toMatchObject({ prState: 'CLOSED', blocked: true });
    expect(t.activeRunId).toBeUndefined();
  });

  it('ignores branches the factory does not track', async () => {
    const h = createHarness();
    await delegated(h);
    const other = pullRequestBody('closed', { merged: true });
    other.pull_request.head.ref = 'feature/other';
    expect(await post(h, 'pull_request', other)).toEqual({ status: 200 });
    expect(await post(h, 'push', pushBody({ login: 'lilian', type: 'User' }, 'abc', 'main'))).toEqual({ status: 200 });
    expect(await h.store.pendingInbox(10)).toEqual([]);
    expect(await events(h, 'pr.merged')).toEqual([]);
  });
});

const DAY = 24 * 60 * 60 * 1000;

/** ORC-278: pushes on the default branch and workflow runs reach the journal, and the measures read them. */
describe('reverts within 14 days and CI cost, from GitHub webhooks', () => {
  /** REL-1 in review, its CI run three times (a run re-run once, delivered twice), merged, its merge pushed on main. */
  async function mergedWithCi(h: Harness) {
    await delegated(h);
    await post(h, 'workflow_run', workflowRunBody({ id: 101, attempt: 1, minutes: 3, number: 3 }));
    await post(h, 'workflow_run', workflowRunBody({ id: 101, attempt: 2, minutes: 2, number: 3 }));
    // GitHub redelivers the same attempt: the inbox already holds its id.
    await post(h, 'workflow_run', workflowRunBody({ id: 101, attempt: 2, minutes: 2, number: 3 }));
    await post(h, 'workflow_run', workflowRunBody({ id: 102, attempt: 1, minutes: 5, number: 3 }));
    const mergedAt = new Date(h.clock.now()).toISOString();
    expect(await post(h, 'pull_request', pullRequestBody('closed', { merged: true, mergeSha: sha('a'), mergedAt }))).toEqual({ status: 200 });
    expect(await h.ticket()).toMatchObject({ logical: 'done', prState: 'MERGED' });
    const pushedAt = Math.floor(h.clock.now() / 1000);
    await post(h, 'push', defaultPushBody(sha('a'), [{ id: sha('a'), message: 'Export CSV (#3)', byGithub: true }], pushedAt));
  }

  const revert = (at: number) =>
    defaultPushBody(sha('b'), [{ id: sha('b'), message: `Revert "Export CSV (#3)"\n\nThis reverts commit ${sha('a')}.` }], Math.floor(at / 1000));

  it('a revert of the merge commit pushed within 14 days counts; the CI cost sums every run attempt once', async () => {
    const h = createHarness();
    await mergedWithCi(h);
    const before = await measureTicket(h.store, 'p', 'REL-1');
    expect(before.revertedWithin14Days).toBe(false);
    expect(before.ciCost).toEqual({ durationMs: 10 * 60_000, runs: 3, byPr: [{ number: 3, durationMs: 10 * 60_000, runs: 3 }] });
    expect(await events(h, 'ci.run_completed')).toHaveLength(3);

    await h.advance(9 * DAY);
    const runs = h.runner.requests.length;
    expect(await post(h, 'push', revert(h.clock.now()))).toEqual({ status: 200 });
    expect((await events(h, 'default_branch.pushed')).reverse()).toMatchObject([
      { payload: { commits: [{ merges: 3 }] } },
      { taint: 'untrusted', payload: { commits: [{ sha: sha('b'), reverts: 3 }] } },
    ]);
    expect((await measureTicket(h.store, 'p', 'REL-1')).revertedWithin14Days).toBe(true);
    // Recorded, nothing decided: no run starts on a delivered ticket.
    expect(h.runner.requests).toHaveLength(runs);
  });

  it('a revert pushed after 14 days, or of a commit the factory did not merge, does not count', async () => {
    const h = createHarness();
    await mergedWithCi(h);
    await h.advance(15 * DAY);
    await post(h, 'push', revert(h.clock.now()));
    const unrelated = defaultPushBody(sha('c'), [{ id: sha('c'), message: `Revert "fix"\n\nThis reverts commit ${sha('e')}.` }]);
    await post(h, 'push', unrelated);
    expect((await events(h, 'default_branch.pushed')).reverse().map((e) => e.id)).toEqual([`default-branch:REL-1:${sha('a')}`, `default-branch:REL-1:${sha('b')}`]);
    expect((await measureTicket(h.store, 'p', 'REL-1')).revertedWithin14Days).toBe(false);
  });
});
