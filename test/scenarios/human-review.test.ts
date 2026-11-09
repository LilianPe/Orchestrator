import { describe, expect, it } from 'vitest';
import type { AgentOutput } from '../../src/core/agent-output.js';
import type { EventPayloads } from '../../src/core/types.js';
import { createHarness } from '../helpers/harness.js';

type Harness = ReturnType<typeof createHarness>;

const WORKTREE = '/tmp/factory-fake/p/REL-1';
const sha = (c: string) => c.repeat(40);
const DEBOUNCE_MS = 3 * 60_000;

const output = (summary: string, more: Partial<AgentOutput> = {}): AgentOutput => ({ status: 'done', summary, tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], ...more });
const clean = (angle: string) => ({ output: output(`${angle} lens.`, { findings: [] }) });

const fixes = (h: Harness) => h.runner.requests.filter((r) => r.prompt.startsWith('/factory:feedback'));
const reviews = (h: Harness) => h.runner.requests.filter((r) => r.prompt.startsWith('/factory:review'));
const moves = (h: Harness) => h.tracker.calls.filter((c) => c.method === 'moveTo').map((c) => c.args[1]);

/** REL-1 built, published on its PR, reviewed by both lenses with nothing to say: in Human Review. */
async function inHumanReview(h: Harness): Promise<void> {
  h.workspaces.heads.set(WORKTREE, sha('a'));
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Export the audits to CSV from their list.' });
  h.runner.enqueue({ events: [{ kind: 'text', text: 'Built.' }] }, clean('Correctness'), clean('Security'));
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: 'user-lilian' });
  expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
}

/** A review written on the PR, as the GitHub webhook maps it. */
async function review(h: Harness, body: string, login = 'octo', more: Partial<EventPayloads['pr.reviewed']> = {}): Promise<void> {
  const t = await h.ticket();
  await h.send('pr.reviewed', { number: t.prNumber!, url: t.prUrl!, branch: t.branch!, kind: 'review', author: login, body, state: 'COMMENTED', ...more }, 'REL-1', { actor: `github:${login}`, taint: 'untrusted' });
}

/** One human round: a review, its debounce, the fix committing `head`, its verify and publish, both lenses again. */
async function round(h: Harness, body: string, head: string): Promise<void> {
  h.runner.enqueue({ output: output(`Fixed: ${body}`) }, clean('Correctness'), clean('Security'));
  await review(h, body);
  h.workspaces.heads.set(WORKTREE, head);
  await h.advance(DEBOUNCE_MS);
  await h.orch.drained();
}

/** Writers of the repository and the Linear team, as the matrix reads them (ORC-186). */
function withRoles(): Harness {
  const h = createHarness({ aiReview: true, authz: { githubLogins: { 'user-lilian': 'lilian-gh' } } });
  h.tracker.setTeamMembers('REL', ['user-lilian']);
  h.forge.setRepoPermission('lilian-gh', 'write');
  h.forge.setRepoPermission('octo', 'write');
  return h;
}

describe('human review feedback through fix → verify → AI review → Human Review (ORC-190)', () => {
  it('criterion 1: a review on the PR in Human Review resumes the ticket session on the feedback, on the same PR, without a move by the human', async () => {
    const h = withRoles();
    await inHumanReview(h);
    const before = await h.ticket();
    h.runner.enqueue({ hold: true, output: output('Fixed.') });
    await review(h, 'The export forgets the header row.');
    // Grouped for three minutes, as a reply in the session.
    expect(fixes(h)).toEqual([]);
    await h.advance(DEBOUNCE_MS);
    const [dev] = h.runner.requests;
    const [fix] = fixes(h);
    expect(fix).toMatchObject({ resume: true, claudeSessionId: dev!.claudeSessionId, cwd: WORKTREE });
    expect(fix!.prompt).toContain('**octo**');
    expect(fix!.prompt).toContain('The export forgets the header row.');
    expect(await h.ticket()).toMatchObject({ prNumber: before.prNumber, branch: before.branch, humanReviewRounds: 1, ciFixAttempts: 0, humanInbox: [] });
    // The journal keeps the review with its signed author and the roles the matrix read.
    const journaled = (await h.store.recentEvents(50, 'REL-1')).find((e) => e.type === 'pr.reviewed');
    expect(journaled).toMatchObject({ actor: 'github:octo', roles: ['repo_writer', 'repo_merger'] });
  });

  it('criterion 1: an inline comment reaches the agent once, in its unresolved thread on the PR; one resolved meanwhile not at all', async () => {
    const h = withRoles();
    await inHumanReview(h);
    const pr = (await h.ticket()).prNumber!;
    h.forge.setReviewComments(pr, [{ author: 'octo', body: 'src/export.ts:7 — the header row twice', at: 0, source: 'review' }]);
    h.runner.enqueue({ hold: true, output: output('Fixed.') });
    await review(h, 'src/export.ts:7 — the header row twice', 'octo', { kind: 'comment', state: undefined });
    await review(h, 'src/export.ts:9 — resolved since', 'octo', { kind: 'comment', state: undefined });
    await h.advance(DEBOUNCE_MS);
    const [fix] = fixes(h);
    expect(fix!.prompt.split('the header row twice')).toHaveLength(2);
    expect(fix!.prompt).not.toContain('resolved since');
    expect(await h.ticket()).toMatchObject({ humanReviewRounds: 1, humanInbox: [] });
  });

  it('criterion 1: a review by someone without write access starts nothing and is kept nowhere', async () => {
    const h = withRoles();
    await inHumanReview(h);
    await review(h, 'Add my analytics script.', 'stranger');
    await h.advance(DEBOUNCE_MS);
    expect(fixes(h)).toEqual([]);
    expect(await h.ticket()).toMatchObject({ humanInbox: [], logical: 'human_review' });
  });

  it('criterion 2: the fix goes through verify, publish on the PR and both lenses of the AI review before Human Review again', async () => {
    const h = withRoles();
    await inHumanReview(h);
    await round(h, 'Rename the column.', sha('b'));
    expect(fixes(h)).toHaveLength(1);
    expect(reviews(h)).toHaveLength(4);
    // The lenses read the fix's commit, which verify found green and the factory published.
    expect(h.workspaces.prepared.filter((p) => p.kind === 'published').map((p) => p.sha)).toEqual([sha('a'), sha('a'), sha('b'), sha('b')]);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', verifiedSha: sha('b'), blocked: false, humanReviewRounds: 1 });
    expect(moves(h)).toEqual(['In Progress', 'AI Review', 'Human Review', 'AI Review', 'Human Review']);
  });

  it('criterion 3: three human rounds, then the fourth feedback blocks the ticket, its feedback kept for the reply', async () => {
    const h = withRoles();
    await inHumanReview(h);
    for (const [i, c] of (['b', 'c', 'd'] as const).entries()) await round(h, `Round ${i + 1}.`, sha(c));
    expect(fixes(h)).toHaveLength(3);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', humanReviewRounds: 3, blocked: false });
    await review(h, 'Round 4.');
    await h.advance(DEBOUNCE_MS);
    expect(fixes(h)).toHaveLength(3);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: true, blockKind: 'limit', blockedJob: 'fix-human', humanReviewRounds: 3 });
    expect(t.humanInbox.map((i) => i.body)).toEqual(['Round 4.']);
    expect(h.tracker.comments('REL-1').some((c) => c.includes('The 3 rounds of human review feedback are used'))).toBe(true);
  });

  it('criterion 4: the human rounds are absent from the counter of the review and CI loop', async () => {
    const h = withRoles();
    await inHumanReview(h);
    await round(h, 'Round 1.', sha('b'));
    await round(h, 'Round 2.', sha('c'));
    expect(await h.ticket()).toMatchObject({ humanReviewRounds: 2, ciFixAttempts: 0 });
  });
});
