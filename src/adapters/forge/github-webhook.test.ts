import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newTicketState, type FactoryEvent, type TicketState } from '../../core/types.js';
import { BRANCH, checkRunBody, githubDelivery, pullRequestBody, pushBody } from '../../../test/helpers/github-webhook.js';
import { createGithubIngest } from './github-ingest.js';
import { checksEventId, mapGithubWebhook, verifyGithubSignature, type GithubMapContext } from './github-webhook.js';
import type { PrInfo } from './types.js';

const tracked = (patch: Partial<TicketState> = {}): TicketState => ({ ...newTicketState('p', 'REL-1', 'Export CSV', 'human_review', 0), branch: BRANCH, ...patch });

function ctx(t: TicketState = tracked(), pr?: PrInfo): GithubMapContext {
  return { ticketForBranch: async (b) => (b === t.branch ? t : undefined), findPr: async () => pr, now: () => 5 };
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
      { id: 'pr:REL-1:3:opened', type: 'pr.opened', at: 5, projectId: 'p', ticketId: 'REL-1', schemaVersion: 2, taint: 'trusted', payload: { number: 3, url: 'https://github.com/acme/app/pull/3', branch: BRANCH } },
      { id: 'pr:REL-1:3:merged', type: 'pr.merged', at: 5, projectId: 'p', ticketId: 'REL-1', schemaVersion: 2, taint: 'trusted', payload: { number: 3, url: 'https://github.com/acme/app/pull/3', branch: BRANCH } },
    ]);
    expect(ids(await mapGithubWebhook('pull_request', pullRequestBody('closed'), ctx(tracked({ prNumber: 3 }))))).toEqual(['pr:REL-1:3:closed']);
    expect(ids(await mapGithubWebhook('pull_request', pullRequestBody('opened'), ctx(tracked({ prNumber: 3 }))))).toEqual([]);
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

  it('maps nothing for a branch no ticket tracks, nor for other events', async () => {
    expect(await mapGithubWebhook('pull_request', pullRequestBody('closed', { merged: true }), ctx(tracked({ branch: 'factory/rel-2-x' })))).toEqual([]);
    expect(await mapGithubWebhook('ping', { zen: 'Keep it simple' }, ctx())).toEqual([]);
    expect(await mapGithubWebhook('issues', { action: 'opened' }, ctx())).toEqual([]);
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
