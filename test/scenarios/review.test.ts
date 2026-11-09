import { describe, expect, it } from 'vitest';
import type { AgentOutput, Finding } from '../../src/core/agent-output.js';
import { allowConnect } from '../../src/network/levels.js';
import { createHarness } from '../helpers/harness.js';
import { TRAPPED } from '../helpers/trapped-diffs.js';

type Harness = ReturnType<typeof createHarness>;

const WORKTREE = '/tmp/factory-fake/p/REL-1';
/** The commit `verify` finds green in the ticket's worktree, which the factory publishes. */
const SHA = 'c0ffee'.padEnd(40, '0');

const lens = (summary: string, findings: Finding[]): AgentOutput => ({ status: 'done', summary, tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], findings });

/** REL-1 delegated, built and published; then the two lenses answer with these findings, or none. */
async function published(h: Harness, findings: { correctness?: Finding[]; security?: Finding[] } = {}, diff?: string): Promise<void> {
  h.workspaces.heads.set(WORKTREE, SHA);
  if (diff) h.workspaces.diffs.set(SHA, diff);
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Export the audits to CSV from their list.' });
  h.runner.enqueue({ events: [{ kind: 'text', text: 'Built.' }] }, { output: lens('Correctness lens, standard.', findings.correctness ?? []) }, { output: lens('Security lens, standard.', findings.security ?? []) });
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
}

const reviews = (h: Harness) => h.runner.requests.filter((r) => r.prompt.startsWith('/factory:review'));
const check = (h: Harness) => h.forge.checkRuns.find((c) => c.name === 'factory/review');

const blocking: Finding = { file: 'src/export.ts', line: 7, severity: 'blocking', explanation: 'The header row is written twice on an empty list.', suggestion: 'Write it once, before the loop.' };
const minor: Finding = { file: 'src/export.ts', line: 3, severity: 'minor', explanation: 'The name `doIt` says nothing.', suggestion: 'Name it exportCsv.' };
const outOfScope: Finding = { file: 'src/list.ts', line: 40, severity: 'out_of_scope', explanation: 'The list was already unsorted before this PR.', suggestion: '' };

describe('the AI review (ORC-183)', () => {
  it('criterion 1: once the PR is published, two fresh sessions on Opus read a fresh clone of the published commit, with no write tool nor Bash', async () => {
    const h = createHarness({ aiReview: true });
    await published(h);
    const [dev] = h.runner.requests;
    const [first, second] = reviews(h);
    expect(reviews(h)).toHaveLength(2);
    for (const [r, angle] of [[first!, 'correctness'], [second!, 'security']] as const) {
      expect(r).toMatchObject({ model: 'opus', effort: 'high', resume: false, readOnly: false, tools: ['Read', 'Grep', 'Glob'], limits: { turns: 25 } });
      // A fresh context: a session of its own, neither the implementer's nor the other lens's.
      expect(r.claudeSessionId).not.toBe(dev!.claudeSessionId);
      // Its clone, never the agent's worktree.
      expect(r.cwd).toBe(`/tmp/factory-fake/p/_trunk/${r.runId}`);
      expect(r.prompt).toContain(`Lens: ${angle}\nCommit: ${SHA}`);
      expect(r.prompt).toContain('## Diff to review\ndiff --git a/src/export.ts b/src/export.ts');
      expect(r.prompt).not.toContain('review rounds');
    }
    expect(first!.claudeSessionId).not.toBe(second!.claudeSessionId);
    expect(h.workspaces.prepared.filter((p) => p.kind === 'published').map((p) => p.sha)).toEqual([SHA, SHA]);
    // The clones go with their runs; the ticket keeps its worktree.
    expect(h.workspaces.released).toEqual([first!.cwd, second!.cwd]);
    const t = await h.ticket();
    expect(t).toMatchObject({ logical: 'human_review', worktreePath: WORKTREE, blocked: false });
    expect(h.tracker.calls.filter((c) => c.method === 'moveTo').map((c) => c.args[1])).toEqual(['In Progress', 'AI Review', 'Human Review']);
  });

  it('criterion 2: a blocking finding is an inline comment of the GitHub review, and factory/review fails on the published commit', async () => {
    const h = createHarness({ aiReview: true });
    await published(h, { correctness: [minor], security: [blocking] });
    expect(h.forge.reviews).toHaveLength(1);
    const [review] = h.forge.reviews;
    expect(review).toMatchObject({ number: (await h.ticket()).prNumber, sha: SHA });
    expect(review!.body).toContain('1 blocking finding, 1 minor, 0 out of scope');
    expect(review!.comments).toEqual([
      { path: 'src/export.ts', line: 3, body: expect.stringContaining('**Minor** · correctness lens') },
      { path: 'src/export.ts', line: 7, body: expect.stringContaining('The header row is written twice on an empty list.') },
    ]);
    expect(review!.comments[1]!.body).toMatch(/^\*\*Blocking\*\* · security lens/);
    expect(check(h)).toMatchObject({ sha: SHA, status: 'completed', conclusion: 'failure', title: '1 blocking finding, 1 minor, 0 out of scope' });
    // Kept for the audit of the reviews (ORC-229), by lens.
    expect((await h.store.findingsOf('p', 'REL-1', SHA)).map((f) => [f.lens, f.severity])).toEqual([['correctness', 'minor'], ['security', 'blocking']]);
    // The fix loop is ORC-184's: nothing is started on the blocking finding.
    expect(h.runner.requests).toHaveLength(3);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
  });

  it('criterion 3: minor and out-of-scope findings alone leave factory/review green', async () => {
    const h = createHarness({ aiReview: true });
    await published(h, { correctness: [outOfScope], security: [minor] });
    expect(check(h)).toMatchObject({ conclusion: 'success', title: '0 blocking findings, 1 minor, 1 out of scope' });
    // The minor one on its line; the out-of-scope one, on code the diff does not change, in the review's text.
    expect(h.forge.reviews[0]!.comments.map((c) => [c.path, c.line])).toEqual([['src/export.ts', 3]]);
    expect(h.forge.reviews[0]!.body).toContain('`src/list.ts:40`');
  });

  it('criterion 4: a review session gets the Claude API alone from the proxy, whatever the repository allows', async () => {
    const h = createHarness({ aiReview: true, sandboxed: true });
    await published(h);
    const levels = h.runner.requests.map((r) => [r.prompt.split('\n')[0], h.sandboxes.created.find((c) => c.runId === r.runId)?.network]);
    expect(levels).toEqual([
      ['/factory:dev', 'limited'],
      ['/factory:review', 'claude-api'],
      ['/factory:review', 'claude-api'],
    ]);
    const proxy = { level: 'claude-api' as const, allow: [] };
    expect(allowConnect(proxy, 'api.anthropic.com').ok).toBe(true);
    for (const host of ['github.com', 'registry.npmjs.org', 'example.com']) expect(allowConnect(proxy, host).ok, host).toBe(false);
  });

  it('criterion 5: a diff that adds a useless abstraction gets the over-engineering flagged in the review', async () => {
    const trap = TRAPPED.find((t) => t.name === 'useless abstraction')!;
    const h = createHarness({ aiReview: true });
    await published(h, trap, trap.diff);
    expect(reviews(h)[0]!.prompt).toContain('+export class ExportWriterFactory {');
    expect(h.forge.reviews[0]!.comments.map((c) => c.body)).toContainEqual(expect.stringMatching(/Over-engineering: a strategy interface and a factory/));
  });

  describe('criterion 6: the trapped diffs, flagged as blocking by both lenses', () => {
    it.each(TRAPPED.map((t) => [t.name, t] as const))('%s', async (_name, trap) => {
      const h = createHarness({ aiReview: true });
      await published(h, trap, trap.diff);
      // Each lens is given the trapped diff itself.
      for (const r of reviews(h)) expect(r.prompt).toContain(trap.diff);
      const kept = await h.store.findingsOf('p', 'REL-1', SHA);
      for (const angle of ['correctness', 'security'] as const) expect(kept.some((f) => f.lens === angle && f.severity === 'blocking'), angle).toBe(true);
      expect(check(h)).toMatchObject({ conclusion: 'failure' });
      expect(h.forge.reviews[0]!.comments).toHaveLength(trap.correctness.length + trap.security.length);
    });
  });

  it('lists the findings in the review text when GitHub cannot place one on its line', async () => {
    const h = createHarness({ aiReview: true });
    h.forge.unplaceable.add('src/export.ts:7');
    await published(h, { correctness: [outOfScope], security: [blocking] });
    const [review] = h.forge.reviews;
    expect(review!.comments).toEqual([]);
    expect(review!.body).toContain('`src/list.ts:40`\n**Out of scope** · correctness lens');
    expect(review!.body).toContain('`src/export.ts:7`\n**Blocking** · security lens');
    expect(check(h)).toMatchObject({ conclusion: 'failure' });
  });

  it('publishes every text through the OutputPolicy: a finding that carries a blob is withheld, its place kept', async () => {
    const h = createHarness({ aiReview: true });
    const blob = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODkrL0FCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFla';
    await published(h, { security: [{ ...blocking, explanation: `Leaks ${blob}` }] });
    const [comment] = h.forge.reviews[0]!.comments;
    expect(comment).toMatchObject({ path: 'src/export.ts', line: 7 });
    expect(comment!.body).toMatch(/withheld this message/);
    expect(JSON.stringify(h.forge.reviews)).not.toContain(blob);
    expect(check(h)).toMatchObject({ conclusion: 'failure' });
  });

  it('blocks a lens that returns no findings list, and publishes nothing', async () => {
    const h = createHarness({ aiReview: true });
    h.workspaces.heads.set(WORKTREE, SHA);
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Export the audits to CSV from their list.' });
    const { findings: _, ...silent } = lens('Nothing to say.', []);
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Built.' }] }, { output: silent });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(reviews(h)).toHaveLength(1);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockedJob: 'review', logical: 'ai_review' });
    expect(h.forge.reviews).toEqual([]);
    expect(check(h)).toBeUndefined();
  });
});
