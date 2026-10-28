import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newTicketState, SCHEMA_VERSION, type FactoryEvent, type TicketState } from '../../core/types.js';
import { BRANCH, checkRunBody, defaultPushBody, githubDelivery, pullRequestBody, pushBody, sha, workflowRunBody } from '../../../test/helpers/github-webhook.js';
import { createGithubIngest, githubRepoOf } from './github-ingest.js';
import { checksEventId, mapGithubWebhook, verifyGithubSignature, type GithubMapContext } from './github-webhook.js';
import type { PrInfo } from './types.js';

const tracked = (patch: Partial<TicketState> = {}): TicketState => ({ ...newTicketState('p', 'REL-1', 'Export CSV', 'human_review', 0), branch: BRANCH, ...patch });

/** `merges`: the journaled merges of the project, by merge or head commit (ORC-278). */
function ctx(t: TicketState = tracked(), pr?: PrInfo, merges: Record<string, number> = {}): GithubMapContext {
  return {
    ticketForBranch: async (repo, b) => (repo === 'acme/app' && b === t.branch ? t : undefined),
    ticketForPr: async (repo, n) => (repo === 'acme/app' && n === t.prNumber ? t : undefined),
    mergedPrOf: async (repo, s) => (repo === 'acme/app' && merges[s] !== undefined ? { ticket: t, number: merges[s]! } : undefined),
    findPr: async () => pr,
    now: () => 5,
  };
}

const ids = (events: FactoryEvent[]) => events.map((e) => e.id);

describe('verifyGithubSignature', () => {
  const raw = '{"a":1}';
  const sig = (secret: string, body = raw) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  it('accepts the HMAC-SHA256 of the raw body under the sha256= prefix, and nothing else', () => {
    expect(verifyGithubSignature(raw, sig('sec'), 'sec')).toBe(true);
    expect(verifyGithubSignature(raw, sig('sec').toUpperCase().replace('SHA256=', 'sha256='), 'sec')).toBe(true);
    expect(verifyGithubSignature(raw, sig('other'), 'sec')).toBe(false);
    expect(verifyGithubSignature(`${raw} `, sig('sec'), 'sec')).toBe(false);
    expect(verifyGithubSignature(raw, sig('sec').slice('sha256='.length), 'sec')).toBe(false);
    expect(verifyGithubSignature(raw, `sha1=${'0'.repeat(40)}`, 'sec')).toBe(false);
    expect(verifyGithubSignature(raw, 'sha256=zz', 'sec')).toBe(false);
    expect(verifyGithubSignature(raw, undefined, 'sec')).toBe(false);
  });

  it('refuses everything when the secret is empty, even a signature computed with it', () => {
    for (const secret of ['', '  ']) expect(verifyGithubSignature(raw, sig(secret), secret)).toBe(false);
  });
});

describe('mapGithubWebhook', () => {
  it('maps a merge, preceded by pr.opened for a PR the ticket does not know, with the ids of PrPoller', async () => {
    const out = await mapGithubWebhook('pull_request', pullRequestBody('closed', { merged: true }), ctx());
    expect(out).toEqual([
      { id: 'pr:REL-1:3:opened', type: 'pr.opened', at: 5, projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint: 'trusted', payload: { number: 3, url: 'https://github.com/acme/app/pull/3', branch: BRANCH } },
      { id: 'pr:REL-1:3:merged', type: 'pr.merged', at: 5, projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint: 'trusted', payload: { number: 3, url: 'https://github.com/acme/app/pull/3', branch: BRANCH, headSha: 'head1' } },
    ]);
    expect(ids(await mapGithubWebhook('pull_request', pullRequestBody('closed'), ctx(tracked({ prNumber: 3 }))))).toEqual(['pr:REL-1:3:closed:2026-10-28T10:00:00Z']);
    expect(ids(await mapGithubWebhook('pull_request', pullRequestBody('opened'), ctx(tracked({ prNumber: 3 }))))).toEqual([]);
  });

  it("maps a reopening of the ticket's PR per reopening, and nothing for an old closed PR of the branch", async () => {
    const t = tracked({ prNumber: 3, prState: 'CLOSED' });
    expect(ids(await mapGithubWebhook('pull_request', pullRequestBody('reopened'), ctx(t)))).toEqual(['pr:REL-1:3:reopened:2026-10-28T10:00:00Z']);
    const onNew = tracked({ prNumber: 4 });
    expect(await mapGithubWebhook('pull_request', pullRequestBody('closed'), ctx(onNew))).toEqual([]);
    expect(await mapGithubWebhook('pull_request', pullRequestBody('labeled', { state: 'closed' }), ctx(onNew))).toEqual([]);
    // A new open PR on the branch is taken, as PrPoller takes the branch's latest PR.
    expect(ids(await mapGithubWebhook('pull_request', pullRequestBody('opened'), ctx(onNew)))).toEqual(['pr:REL-1:3:opened']);
  });

  it('maps nothing for another repository, nor for a body of another shape', async () => {
    const other = { ...pullRequestBody('closed', { merged: true }), repository: { full_name: 'evil/app', html_url: 'https://github.com/evil/app' } };
    expect(await mapGithubWebhook('pull_request', other, ctx())).toEqual([]);
    for (const [name, body] of [
      ['pull_request', { action: 'closed', repository: { full_name: 'acme/app' } }],
      ['pull_request', { action: 'closed', repository: { full_name: 'acme/app' }, pull_request: { number: 3 } }],
      ['check_run', { action: 'completed', repository: { full_name: 'acme/app' } }],
      ['check_suite', { action: 'completed', repository: { full_name: 'acme/app' }, check_suite: { head_sha: 'h', pull_requests: [{}] } }],
      ['push', { repository: { full_name: 'acme/app' } }],
      ['pull_request_review', { ...pullRequestBody('submitted'), review: null }],
      ['pull_request', null],
    ] as const) {
      expect(await mapGithubWebhook(name, body, ctx()), name).toEqual([]);
    }
  });

  it('maps a conflict with the base branch per head and base, only on an open PR', async () => {
    const dirty = pullRequestBody('synchronize', { mergeable_state: 'dirty' });
    expect(await mapGithubWebhook('pull_request', dirty, ctx(tracked({ prNumber: 3 })))).toMatchObject([
      { id: 'pr:REL-1:3:conflicted:head1:base1', type: 'pr.conflicted', payload: { number: 3, headSha: 'head1', baseRef: 'main' } },
    ]);
    expect(await mapGithubWebhook('pull_request', pullRequestBody('synchronize', { mergeable_state: 'unknown' }), ctx(tracked({ prNumber: 3 })))).toEqual([]);
  });

  it('maps a failed check on the PR head to red CI at once, named per head as PrPoller names it', async () => {
    for (const conclusion of ['failure', 'timed_out', 'cancelled', 'action_required']) {
      const out = await mapGithubWebhook('check_run', checkRunBody(conclusion), ctx(tracked({ prNumber: 3 })));
      expect(out).toMatchObject([{ id: checksEventId('REL-1', 3, 'fail', 'head1'), type: 'pr.checks_failed', payload: { number: 3, failures: ['test'] } }]);
    }
    const suite = { ...checkRunBody('failure'), check_suite: { ...checkRunBody('failure').check_run, app: { name: 'GitHub Actions' } } };
    expect(await mapGithubWebhook('check_suite', suite, ctx(tracked({ prNumber: 3 })))).toMatchObject([{ payload: { failures: ['GitHub Actions'] } }]);
  });

  it('takes the verdict and the failed checks the forge reads on that head, and no red it reads otherwise', async () => {
    const t = tracked({ prNumber: 3 });
    const pr = (checks: PrInfo['checks'], failedChecks: string[] = []): PrInfo => ({ number: 3, url: 'https://pr/3', state: 'OPEN', branch: BRANCH, headSha: 'head1', checks, failedChecks });
    expect(await mapGithubWebhook('check_run', checkRunBody('failure'), ctx(t, pr('fail', ['test', 'lint'])))).toMatchObject([{ payload: { failures: ['test', 'lint'], url: 'https://pr/3' } }]);
    // A cancelled run superseded by a newer attempt: the forge reads the head pending, or green.
    expect(await mapGithubWebhook('check_run', checkRunBody('cancelled'), ctx(t, pr('pending')))).toEqual([]);
    expect(await mapGithubWebhook('check_run', checkRunBody('cancelled'), ctx(t, pr('pass')))).toEqual([]);
    // Red does not wait on GitHub: the forge down, the failed check is reported alone.
    const down: GithubMapContext = { ...ctx(t), findPr: async () => { throw new Error('GitHub down'); } };
    expect(await mapGithubWebhook('check_run', checkRunBody('failure'), down)).toMatchObject([{ payload: { failures: ['test'] } }]);
    await expect(mapGithubWebhook('check_run', checkRunBody('success'), down)).rejects.toThrow('GitHub down');
  });

  it('finds the tracked PR among the PRs of the checked commit', async () => {
    const body = checkRunBody('failure');
    body.check_run.pull_requests.unshift({ number: 9, head: { ref: 'feature/stacked', sha: 'head1' } });
    expect(await mapGithubWebhook('check_run', body, ctx(tracked({ prNumber: 3 })))).toMatchObject([{ id: checksEventId('REL-1', 3, 'fail', 'head1') }]);
  });

  it('ignores a check on a head the PR has left, one not completed, and one on no PR', async () => {
    const t = tracked({ prNumber: 3 });
    expect(await mapGithubWebhook('check_run', checkRunBody('failure', { prHead: 'head2' }), ctx(t))).toEqual([]);
    expect(await mapGithubWebhook('check_run', { ...checkRunBody('failure'), action: 'created' }, ctx(t))).toEqual([]);
    const orphan = checkRunBody('failure');
    orphan.check_run.pull_requests = [];
    expect(await mapGithubWebhook('check_run', orphan, ctx(t))).toEqual([]);
  });

  it('maps a green check to green CI only once the forge reads every check of that head green', async () => {
    const t = tracked({ prNumber: 3 });
    const pr = (checks: PrInfo['checks'], headSha = 'head1'): PrInfo => ({ number: 3, url: 'https://pr/3', state: 'OPEN', branch: BRANCH, headSha, checks, failedChecks: [] });
    expect(await mapGithubWebhook('check_run', checkRunBody('success'), ctx(t, pr('pending')))).toEqual([]);
    expect(await mapGithubWebhook('check_run', checkRunBody('success'), ctx(t, pr('pass', 'head2')))).toEqual([]);
    expect(await mapGithubWebhook('check_run', checkRunBody('success'), ctx(t, pr('pass')))).toMatchObject([
      { id: checksEventId('REL-1', 3, 'pass', 'head1'), type: 'pr.checks_passed', payload: { number: 3, url: 'https://pr/3' } },
    ]);
  });

  it('maps a human push as untrusted push.human, and no push by a bot, of a deleted branch or of another branch', async () => {
    expect(await mapGithubWebhook('push', pushBody({ login: 'lilian', type: 'User' }), ctx())).toMatchObject([
      { id: 'push:REL-1:c0ffee', type: 'push.human', taint: 'untrusted', payload: { branch: BRANCH, sha: 'c0ffee', author: 'lilian' } },
    ]);
    expect(await mapGithubWebhook('push', pushBody({ login: 'factory[bot]', type: 'Bot' }), ctx())).toEqual([]);
    expect(await mapGithubWebhook('push', { ...pushBody({ login: 'lilian', type: 'User' }), deleted: true }, ctx())).toEqual([]);
    expect(await mapGithubWebhook('push', { ...pushBody({ login: 'lilian', type: 'User' }), ref: 'refs/tags/v1' }, ctx())).toEqual([]);
  });

  it('maps a human review and a diff comment as untrusted pr.reviewed, and none by a bot', async () => {
    const t = tracked({ prNumber: 3 });
    const review = { ...pullRequestBody('submitted'), review: { id: 9, state: 'commented', body: 'ok ?', user: { login: 'lilian', type: 'User' } } };
    expect(await mapGithubWebhook('pull_request_review', review, ctx(t))).toMatchObject([
      { id: 'pr:REL-1:3:review:9', taint: 'untrusted', payload: { kind: 'review', author: 'lilian', body: 'ok ?', state: 'commented' } },
    ]);
    const comment = { ...pullRequestBody('created'), comment: { id: 12, body: 'renomme', path: 'src/a.ts', line: 4, user: { login: 'lilian', type: 'User' } } };
    expect(await mapGithubWebhook('pull_request_review_comment', comment, ctx(t))).toMatchObject([
      { id: 'pr:REL-1:3:comment:12', taint: 'untrusted', payload: { kind: 'comment', body: 'src/a.ts:4 — renomme' } },
    ]);
    const bot = { ...review, review: { ...review.review, user: { login: 'coderabbit[bot]', type: 'Bot' } } };
    expect(await mapGithubWebhook('pull_request_review', bot, ctx(t))).toEqual([]);
    expect(await mapGithubWebhook('pull_request_review', { ...review, action: 'dismissed' }, ctx(t))).toEqual([]);
  });

  it('records the merge commit and the head of a merged PR, which a revert names (ORC-278)', async () => {
    const body = pullRequestBody('closed', { merged: true, mergeSha: sha('a'), mergedAt: '2026-10-28T09:59:00Z' });
    const [, merged] = await mapGithubWebhook('pull_request', body, ctx());
    expect(merged).toMatchObject({ type: 'pr.merged', payload: { number: 3, mergeSha: sha('a'), headSha: 'head1', mergedAt: Date.parse('2026-10-28T09:59:00Z') } });
  });

  describe('push on the default branch (ORC-278)', () => {
    const t = tracked({ prNumber: 3, prState: 'MERGED' });
    const merges = { [sha('a')]: 3, head1: 3 };

    it("maps the commit that lands the ticket's PR, by the subject GitHub wrote or its journaled merge commit", async () => {
      const squash = await mapGithubWebhook('push', defaultPushBody(sha('a'), [{ id: sha('a'), message: 'Export CSV (#3)\n\n* commit', byGithub: true }]), ctx(t));
      expect(squash).toEqual([
        {
          id: `default-branch:REL-1:${sha('a')}`, type: 'default_branch.pushed', at: 5, projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint: 'untrusted',
          payload: { branch: 'main', before: 'b0', after: sha('a'), pushedAt: 1_800_000_000_000, commits: [{ sha: sha('a'), message: 'Export CSV (#3)\n\n* commit', author: 'armand', merges: 3 }] },
        },
      ]);
      const merge = await mapGithubWebhook('push', defaultPushBody(sha('a'), [{ id: sha('a'), message: `Merge pull request #3 from acme/${BRANCH}`, byGithub: true }]), ctx(t));
      expect(merge[0]?.payload).toMatchObject({ commits: [{ merges: 3 }] });
      // The same subject typed by someone else than GitHub lands nothing.
      expect(await mapGithubWebhook('push', defaultPushBody(sha('a'), [{ id: sha('a'), message: 'Export CSV (#3)' }]), ctx(t))).toEqual([]);
      // A rebase merge: no PR in the subject, the journaled merge commit names it.
      const rebased = await mapGithubWebhook('push', defaultPushBody(sha('a'), [{ id: sha('a'), message: 'feat: export' }]), ctx(t, undefined, merges));
      expect(rebased[0]?.payload).toMatchObject({ commits: [{ sha: sha('a'), merges: 3 }] });
    });

    it('maps a revert of the merge commit or of the PR, and none of an unrelated commit or PR', async () => {
      const gitRevert = defaultPushBody(sha('b'), [{ id: sha('b'), message: `Revert "Export CSV (#3)"\n\nThis reverts commit ${sha('a')}.` }]);
      expect(await mapGithubWebhook('push', gitRevert, ctx(t, undefined, merges))).toMatchObject([
        { id: `default-branch:REL-1:${sha('b')}`, type: 'default_branch.pushed', taint: 'untrusted', payload: { commits: [{ sha: sha('b'), reverts: 3 }] } },
      ]);
      const button = defaultPushBody(sha('c'), [{ id: sha('c'), message: 'Revert "Export CSV" (#9)\n\nReverts acme/app#3', byGithub: true }]);
      expect(await mapGithubWebhook('push', button, ctx(t))).toMatchObject([{ payload: { commits: [{ reverts: 3 }] } }]);
      // Both forms in one message: the commit is listed once.
      const both = defaultPushBody(sha('c'), [{ id: sha('c'), message: `Revert "Export CSV" (#9)\n\nReverts acme/app#3\nThis reverts commit ${sha('a')}.`, byGithub: true }]);
      expect((await mapGithubWebhook('push', both, ctx(t, undefined, merges)))[0]?.payload).toMatchObject({ commits: [{ sha: sha('c'), reverts: 3 }] });
      expect(((await mapGithubWebhook('push', both, ctx(t, undefined, merges)))[0]?.payload as { commits: unknown[] }).commits).toHaveLength(1);
      const unrelated = defaultPushBody(sha('d'), [
        { id: sha('d'), message: `Revert "fix"\n\nThis reverts commit ${sha('e')}.` },
        { id: sha('f'), message: 'Revert "x" (#9)\n\nReverts evil/app#3' },
        { id: sha('1'), message: 'docs: typo (#12)' },
      ]);
      expect(await mapGithubWebhook('push', unrelated, ctx(t, undefined, merges))).toEqual([]);
    });

    const other = tracked({ ticketId: 'REL-2', prNumber: 4, branch: 'factory/rel-2-x' });
    const two: GithubMapContext = { ...ctx(t, undefined, merges), ticketForPr: async (_r, n) => (n === 4 ? other : n === 3 ? t : undefined) };

    it("reads no revert in a push that merges a factory PR with a merge commit: that PR's commits are the agent's", async () => {
      const landing = defaultPushBody(sha('2'), [
        { id: sha('3'), message: `chore: undo\n\nThis reverts commit ${sha('a')}.`, author: 'factory' },
        { id: sha('2'), message: 'Merge pull request #4 from acme/factory/rel-2-x', byGithub: true },
      ]);
      expect(await mapGithubWebhook('push', landing, two)).toMatchObject([{ ticketId: 'REL-2', payload: { commits: [{ sha: sha('2'), merges: 4 }] } }]);
    });

    it("reads no revert in the squash of a factory PR, which keeps the agent's messages, but still in the other commits of the push", async () => {
      const squash = { id: sha('2'), message: `Export (#4)\n\n* chore: undo\n\nThis reverts commit ${sha('a')}.`, byGithub: true };
      expect(await mapGithubWebhook('push', defaultPushBody(sha('2'), [squash]), two)).toMatchObject([{ ticketId: 'REL-2', payload: { commits: [{ merges: 4 }] } }]);
      // A human pushing a revert with a cherry-pick whose subject names another PR: the cherry-pick lands nothing, the revert counts.
      const direct = defaultPushBody(sha('4'), [
        { id: sha('4'), message: `Revert "Export CSV (#3)"\n\nThis reverts commit ${sha('a')}.` },
        { id: sha('5'), message: 'Fix parser (#4)' },
      ]);
      expect(await mapGithubWebhook('push', direct, two)).toMatchObject([{ ticketId: 'REL-1', payload: { commits: [{ sha: sha('4'), reverts: 3 }] } }]);
    });

    it('maps nothing for a deleted default branch, a push of another repository, or another branch than the default', async () => {
      const body = defaultPushBody(sha('b'), [{ id: sha('b'), message: `This reverts commit ${sha('a')}.` }]);
      expect(await mapGithubWebhook('push', { ...body, deleted: true }, ctx(t, undefined, merges))).toEqual([]);
      expect(await mapGithubWebhook('push', { ...body, repository: { ...body.repository, full_name: 'evil/app' } }, ctx(t, undefined, merges))).toEqual([]);
      // `release` is not the default branch, and no ticket tracks it.
      expect(await mapGithubWebhook('push', { ...body, ref: 'refs/heads/release' }, ctx(t, undefined, merges))).toEqual([]);
    });
  });

  describe('workflow_run (ORC-278)', () => {
    it("maps a completed run attempt on the ticket's branch with its duration, one id per run and attempt", async () => {
      expect(await mapGithubWebhook('workflow_run', workflowRunBody({ id: 7, attempt: 2, minutes: 4, number: 3 }), ctx())).toEqual([
        {
          id: 'ci:REL-1:7:2', type: 'ci.run_completed', at: 5, projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint: 'untrusted',
          payload: {
            number: 3, branch: BRANCH, headSha: 'head1', runId: 7, attempt: 2, workflow: 'ci', conclusion: 'success',
            startedAt: Date.parse('2026-10-28T10:00:00Z'), completedAt: Date.parse('2026-10-28T10:04:00Z'), durationMs: 240_000,
          },
        },
      ]);
      // GitHub lists no PR on the run: the ticket's PR, when it has one.
      expect((await mapGithubWebhook('workflow_run', workflowRunBody(), ctx(tracked({ prNumber: 3, prState: 'OPEN' }))))[0]?.payload).toMatchObject({ number: 3 });
      // Not a closed one, nor none.
      expect((await mapGithubWebhook('workflow_run', workflowRunBody(), ctx(tracked({ prNumber: 3, prState: 'CLOSED' }))))[0]?.payload).not.toHaveProperty('number');
      expect((await mapGithubWebhook('workflow_run', workflowRunBody(), ctx()))[0]?.payload).not.toHaveProperty('number');
    });

    it('maps nothing for a run not completed, of a fork, on an untracked branch, or without its times', async () => {
      expect(await mapGithubWebhook('workflow_run', workflowRunBody({ action: 'in_progress' }), ctx())).toEqual([]);
      expect(await mapGithubWebhook('workflow_run', workflowRunBody({ fork: true }), ctx())).toEqual([]);
      const run = workflowRunBody();
      expect(await mapGithubWebhook('workflow_run', { ...run, workflow_run: { ...run.workflow_run, head_repository: null } }, ctx())).toEqual([]);
      expect(await mapGithubWebhook('workflow_run', workflowRunBody({ branch: 'main' }), ctx())).toEqual([]);
      const body = workflowRunBody();
      expect(await mapGithubWebhook('workflow_run', { ...body, workflow_run: { ...body.workflow_run, run_started_at: null } }, ctx())).toEqual([]);
    });
  });

  it('maps nothing for a branch no ticket tracks, nor for other events', async () => {
    expect(await mapGithubWebhook('pull_request', pullRequestBody('closed', { merged: true }), ctx(tracked({ branch: 'factory/rel-2-x' })))).toEqual([]);
    expect(await mapGithubWebhook('ping', { zen: 'Keep it simple' }, ctx())).toEqual([]);
    expect(await mapGithubWebhook('issues', { action: 'opened' }, ctx())).toEqual([]);
  });
});

describe('githubRepoOf', () => {
  it('reads owner/name of origin once per checkout, and again after a failed read', async () => {
    const calls: string[] = [];
    let fail = true;
    const repoOf = githubRepoOf(async (_cmd, _args, opts) => {
      calls.push(opts?.cwd ?? '');
      if (fail) return { code: 1, stdout: '', stderr: 'no remote' };
      return { code: 0, stdout: 'git@github.com:Acme/app.git\n', stderr: '' };
    });
    await expect(repoOf('/repo')).rejects.toThrow();
    fail = false;
    expect(await repoOf('/repo')).toBe('Acme/app');
    expect(await repoOf('/repo')).toBe('Acme/app');
    expect(calls).toEqual(['/repo', '/repo']);
  });
});

describe('createGithubIngest', () => {
  const ingest = (accept: (e: FactoryEvent) => Promise<boolean>, logs: string[] = []) =>
    createGithubIngest({ secret: () => 'github-test-secret', accept, log: (m) => void logs.push(m), ctx: ctx() });

  it('answers 401 for an unsigned body and 400 for a signed one without event name or JSON, writing nothing', async () => {
    const accepted: FactoryEvent[] = [];
    const accept = async (e: FactoryEvent) => (accepted.push(e), true);
    const { raw, headers } = githubDelivery('pull_request', pullRequestBody('closed', { merged: true }));
    expect(await ingest(accept)(raw, { ...headers, 'x-hub-signature-256': undefined })).toEqual({ status: 401 });
    expect(await ingest(accept)(raw, { ...headers, 'x-github-event': undefined })).toEqual({ status: 400 });
    const bad = githubDelivery('pull_request', 0);
    expect(await ingest(accept)('{', { ...bad.headers, 'x-hub-signature-256': `sha256=${createHmac('sha256', 'github-test-secret').update('{').digest('hex')}` })).toEqual({ status: 400 });
    expect(accepted).toEqual([]);
    expect(await ingest(accept)(raw, headers)).toEqual({ status: 200 });
    expect(ids(accepted)).toEqual(['pr:REL-1:3:opened', 'pr:REL-1:3:merged']);
  });

  it('answers 500 when the inbox write fails, so that the delivery can be sent again', async () => {
    const logs: string[] = [];
    const { raw, headers } = githubDelivery('pull_request', pullRequestBody('closed', { merged: true }));
    expect(await ingest(async () => { throw new Error('database down'); }, logs)(raw, headers)).toEqual({ status: 500 });
    expect(logs).toEqual(['github webhook d-pull_request (pull_request) not written to the inbox: database down']);
  });
});
