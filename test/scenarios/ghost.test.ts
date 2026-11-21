import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeShooter } from '../../src/adapters/browser/fake.js';
import { runGhost, type GhostOptions } from '../../src/cli/ghost.js';
import type { CleanVerifyRequest } from '../../src/core/clean-verify.js';
import { KnowledgeBase } from '../../src/knowledge/kb.js';
import { formatRecipeNote, PreviewRecipes, type RecipeNote } from '../../src/knowledge/preview-recipe.js';
import type { AgentOutput } from '../../src/core/agent-output.js';
import type { Spec } from '../../src/core/spec.js';
import { NO_CHANGE } from '../../src/core/review.js';
import { KEPT_PR } from '../../src/store/types.js';
import { createHarness, withTestCommand } from '../helpers/harness.js';

/**
 * ORC-231: a project without effects (the replay of closed tickets, a prompt tried out) runs its ticket as any other, and nothing of it
 * reaches Linear or GitHub: the outbox keeps each such effect as an artifact of the run, the PR the factory would have opened included.
 */
const WORKTREE = '/tmp/factory-fake/p/REL-1';
const SHA = 'abc123';
const DIFF = 'diff --git a/src/export.ts b/src/export.ts\n+export const csv = 1;';
/** What Linear and GitHub would have been asked to write: the fakes record each call. */
const TRACKER_WRITES = ['moveTo', 'setLabels', 'comment', 'activity', 'addExternalUrl', 'setSessionPlan', 'ensureSession'];

function verified(opts: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness({ noEffect: true, ...opts });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.workspaces.heads.set(WORKTREE, SHA);
  h.workspaces.ticketDiffs.set(WORKTREE, DIFF);
  h.runner.enqueue({ output: { status: 'done', summary: 'Audits export to CSV from their list.', tests_added: [], why: '', assumptions: ['the list holds at most 10,000 audits'], risks: [], untested: [], review_hints: [] } });
  return h;
}

describe('a project without effects (ORC-231)', () => {
  it('runs a ticket to its PR with no write call to the tracker or the forge, the PR kept as an artifact of the run', async () => {
    const h = verified();
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.tracker.calls.filter((c) => TRACKER_WRITES.includes(c.method))).toEqual([]);
    expect(h.publisher.asked).toEqual([]);
    expect(h.forge.opened).toEqual([]);
    expect(h.forge.checkRuns).toEqual([]);
    const artifacts = await h.store.artifacts('REL-1');
    const pr = artifacts.find((a) => a.kind === KEPT_PR);
    expect(pr).toMatchObject({ ticketId: 'REL-1', attemptId: expect.any(String) });
    const kept = JSON.parse(readFileSync(pr!.path, 'utf8')) as { pr: { title: string; body: string; sha: string } };
    expect(kept.pr).toMatchObject({ title: 'REL-1 Export CSV', sha: SHA, diff: DIFF, body: expect.stringContaining('the list holds at most 10,000 audits') });
    // The rest of what it would have written is kept too: the move and the summary, at least.
    expect(artifacts.map((a) => a.kind)).toEqual(expect.arrayContaining(['kept:move', 'kept:post_output']));
    // The run ended as after a publication: nothing left verifying, nothing blocked.
    expect(await h.ticket()).toMatchObject({ blocked: false, verifiedSha: SHA });
    expect((await h.ticket()).verifyingRunId).toBeUndefined();
  });

  it('a delegation without a Linear session opens none: the run gets a local one, and its PR is kept', async () => {
    const h = verified();
    await h.send('ticket.delegated', {});
    expect(h.tracker.calls.filter((c) => TRACKER_WRITES.includes(c.method))).toEqual([]);
    expect((await h.ticket()).linearSessionId).toBe('kept:REL-1');
    expect((await h.store.artifacts('REL-1')).some((a) => a.kind === KEPT_PR)).toBe(true);
  });

  it('a run that committed nothing keeps no PR, as a publication would open none', async () => {
    const h = verified();
    h.workspaces.ticketDiffs.delete(WORKTREE);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect((await h.store.artifacts('REL-1')).some((a) => a.kind === KEPT_PR)).toBe(false);
    expect(await h.ticket()).toMatchObject({ blocked: false });
    expect((await h.ticket()).verifyingRunId).toBeUndefined();
  });

  it('with the AI review, a diff read empty is a run that committed nothing: blocked on a question; an unreadable diff is not (ORC-170)', async () => {
    const empty = verified({ aiReview: true });
    empty.workspaces.ticketDiffs.set(WORKTREE, '');
    await empty.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(await empty.ticket()).toMatchObject({ blocked: true, blockKind: 'question' });
    // The diff as the git adapter reads it when nothing changed (capDiff's text), not only an empty one.
    const unchanged = verified({ aiReview: true });
    unchanged.workspaces.ticketDiffs.set(WORKTREE, NO_CHANGE);
    await unchanged.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(await unchanged.ticket()).toMatchObject({ blocked: true, blockKind: 'question' });
    const unreadable = verified({ aiReview: true });
    unreadable.workspaces.ticketDiffs.delete(WORKTREE);
    await unreadable.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(await unreadable.ticket()).toMatchObject({ blocked: false });
  });

  it('nowhere to keep its effects: the ticket is blocked, and still nothing goes out', async () => {
    const h = verified({ noEffect: { keptEffectsDir: false } });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.tracker.calls.filter((c) => TRACKER_WRITES.includes(c.method))).toEqual([]);
    expect(h.publisher.asked).toEqual([]);
    expect(h.forge.opened).toEqual([]);
    expect((await h.ticket()).blocked).toBe(true);
  });
});

/**
 * ORC-376: `factory ghost start` rebuilds each closed ticket's environment, then the daemon delegates each one to the project on the
 * `factory/fantome` preset, on its clone, with its text and its linked tickets as of its start; `collect` reads what it ran to.
 */
describe('the replay of a closed ticket, from its start to its collection (ORC-376)', () => {
  /** The start commit of REL-1 was made then: what was written on Linear after it stays out of the run. */
  const START = Date.UTC(2026, 8, 1, 9, 0);
  const SPEC: Spec = { goal: 'Export the audits as CSV.', out_of_scope: [], criteria: ['Given 2 audits, when I click CSV, then 3 lines.'], files: ['src/export.ts'], architecture: 'None.', risks: [], assumed: [] };
  const out = (extra: Partial<AgentOutput> = {}) => ({ output: { status: 'done', summary: 'Done.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], ...extra } satisfies AgentOutput });

  function replayed(over: Parameters<typeof createHarness>[0] = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'factory-ghost-'));
    const h = createHarness({ fantome: true, sandboxed: true, replays: { dir, startTime: START }, repoConfig: withTestCommand(), ...over });
    const CLONE = join(dir, 'pilot', 'REL-1', 'repo');
    // REL-1 is Done on Linear, its PR merged: what came after its start is there too, and must not reach the run.
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Export the audits as CSV from the audit list.', stateName: 'Done', stateType: 'completed', createdAt: START - 86_400_000 });
    h.tracker.addIssue({ identifier: 'REL-2', title: 'Audit list', description: 'The list of the audits, paginated.', createdAt: START - 2 * 86_400_000 });
    h.tracker.addComment('REL-1', 'CSV only, no XLSX.', START - 3_600_000);
    h.tracker.addComment('REL-1', 'Shipped in PR #12, see src/export.ts.', START + 3_600_000);
    h.tracker.addComment('REL-2', 'Pages of 50 audits.', START - 3_600_000);
    h.tracker.relate('REL-1', 'REL-2');
    // The forge holds now the human's PR and its branch: the work the factory's is compared with.
    h.forge.openPullRequests = [{ number: 12, url: 'https://github.test/pr/12', title: 'REL-1 Export CSV', branch: 'lilian/rel-1-export-csv', fork: false, files: ['src/export.ts'], filesTotal: 1 }];
    h.forge.branchNames = ['lilian/rel-1-export-csv'];
    const WORKTREE = '/tmp/factory-fake/p/REL-1';
    h.workspaces.heads.set(WORKTREE, 'sha-dev');
    h.workspaces.ticketDiffs.set(WORKTREE, 'diff --git a/src/export.ts b/src/export.ts\n+export const csv = 1;');
    h.workspaces.steps.set(WORKTREE, { changed: [{ path: 'src/export.test.ts', deleted: false }], head: { 'src/export.test.ts': "it('exports', () => expect(toCsv([])).toBe(''));\n" } });
    const lines: string[] = [];
    const ghost = (args: string[], over: Partial<GhostOptions> = {}) => runGhost({
      args, store: h.store, print: (l) => void lines.push(l), now: () => h.clock.now(), user: 'armand', newId: () => 'pilot', dir,
      projects: [{ id: 'p', repoPath: '/repo', fantome: true }],
      sandboxes: async () => true,
      humanPr: async (_repo, n) => ({ number: n, url: `https://github.test/pr/${n}`, author: 'lilian', mergeSha: 'merge12', commits: ['Export CSV'] }),
      humanDiff: async () => 'diff --git a/src/export.ts b/src/export.ts',
      environment: async ({ dir: at }) => {
        mkdirSync(join(at, 'repo'), { recursive: true });
        return { start: 'start-sha' };
      },
      ask: async () => '',
      ...over,
    });
    return { h, ghost, lines, CLONE, WORKTREE };
  }

  it('criterion 1: each ticket runs the fantome pipeline on its historical clone, nothing reaches Linear or GitHub, and collect sees its run', async () => {
    const { h, ghost, CLONE } = replayed();
    expect(await ghost(['start', 'p', '--threshold', '0.6', '--as-is', '0.3', '--tickets', 'REL-1=12'])).toBe(0);
    h.checks.failNext('AssertionError: expected 1 to be 2');
    h.runner.enqueue(out({ intake: { size: 's', risk: 'low', complete: true, missing: [], screen: false } }), out({ spec: SPEC }), {}, out({ summary: 'Audits export to CSV.' }));
    await h.delegateReplays();

    // The fantome's pipeline, step by step, each on the clone at the start.
    expect(h.runner.requests.map((r) => r.prompt.split('\n')[0])).toEqual(['/factory:intake', '/factory:spec-draft', '/factory:tests', '/factory:build']);
    const worktrees = h.workspaces.prepared.filter((w) => w.kind === 'worktree');
    expect(worktrees.length).toBeGreaterThan(0);
    expect(new Set(worktrees.map((w) => w.repoPath))).toEqual(new Set([CLONE]));
    // The ticket as it was: its text, its thread and its linked ticket of before the start; nothing written after, no human work.
    const intake = h.runner.requests[0]!.prompt;
    expect(intake).toContain('Export the audits as CSV from the audit list.');
    expect(intake).toContain('CSV only, no XLSX.');
    expect(intake).toContain('### REL-2 — Audit list');
    expect(intake).toContain('Pages of 50 audits.');
    for (const later of ['Shipped in PR #12', 'lilian/rel-1-export-csv', 'linear.app']) expect(h.runner.requests.map((r) => r.prompt).join('\n')).not.toContain(later);

    // Nothing written outside: no call of the fake tracker or forge that writes, across the whole replay.
    expect(h.tracker.calls.filter((c) => TRACKER_WRITES.includes(c.method))).toEqual([]);
    expect(h.publisher.asked).toEqual([]);
    expect(h.forge.opened).toEqual([]);
    expect(h.forge.checkRuns).toEqual([]);
    expect((await h.store.artifacts('REL-1')).some((a) => a.kind === KEPT_PR)).toBe(true);

    expect(await ghost(['collect', 'pilot'])).toBe(0);
    expect(await h.store.ghostTickets('pilot')).toEqual([expect.objectContaining({ ticketId: 'REL-1', outcome: 'pr', factoryPr: expect.stringMatching(/^kept:/) })]);
  });

  it('ORC-386: a replayed ticket starts by the recipe of the knowledge base at its start, never searches one, never writes one', async () => {
    // A live knowledge base a write would succeed in: a clone without a remote, which commits locally.
    const live = mkdtempSync(join(tmpdir(), 'factory-ghost-kb-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: live, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    writeFileSync(join(live, 'INDEX.md'), '- none\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    const recipes = new PreviewRecipes(new KnowledgeBase(live));
    const asked: CleanVerifyRequest[] = [];
    const { h, ghost } = replayed({
      visualShooter: new FakeShooter(),
      previewRecipes: recipes,
      // The learned recipe no longer starts: a live ticket would invalidate it.
      cleanVerify: async (req) => {
        asked.push(req);
        return { ok: true, failures: [], sha: 'sha-dev', tree: 't', commands: [], preview: { of: 'learned', answered: false, detail: 'gone' } };
      },
    });
    const old: RecipeNote = { scope: 'repo:p', recipe: { command: 'npm start', setup: [] }, sha: 'a'.repeat(40), port: 4200, checkedAt: '2026-08-01', origin: 'agent:build@r0', ticket: 'REL-0', status: 'valid', research: false };
    expect(await ghost(['start', 'p', '--threshold', '0.6', '--as-is', '0.3', '--tickets', 'REL-1=12'], {
      environment: async ({ dir: at }) => {
        mkdirSync(join(at, 'repo'), { recursive: true });
        mkdirSync(join(at, 'knowledge', 'notes', 'preview'), { recursive: true });
        writeFileSync(join(at, 'knowledge', 'notes', 'preview', 'p.md'), formatRecipeNote(old));
        return { start: 'start-sha' };
      },
    })).toBe(0);
    h.checks.failNext('AssertionError: expected 1 to be 2');
    h.runner.enqueue(out({ intake: { size: 's', risk: 'low', complete: true, missing: [], screen: true } }), out({ spec: SPEC }), {}, out({ summary: 'Done.', preview: { command: 'make serve', setup: [] } }));
    await h.delegateReplays();
    const dev = h.runner.requests.find((r) => r.prompt.startsWith('/factory:build'))!;
    expect(dev.prompt).not.toContain('## Find how to start the application');
    const visual = asked.map((r) => r.visual).filter(Boolean);
    expect(visual.length).toBeGreaterThan(0);
    for (const v of visual) {
      expect(v).toMatchObject({ learned: old.recipe });
      expect(v!.found).toBeUndefined();
    }
    // Nothing written to the live knowledge base: neither the invalidation nor any recipe.
    expect(recipes.read('p')).toBeUndefined();
    expect(git('log', '--format=%s')).toBe('init');
  });

  it('ORC-406: a replayed ticket with no recipe to start by writes no failed search either', async () => {
    const live = mkdtempSync(join(tmpdir(), 'factory-ghost-kb-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: live, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    writeFileSync(join(live, 'INDEX.md'), '- none\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    const recipes = new PreviewRecipes(new KnowledgeBase(live));
    const { h, ghost } = replayed({
      visualShooter: new FakeShooter(),
      previewRecipes: recipes,
      startFingerprint: async () => 'a'.repeat(64),
      cleanVerify: async () => ({ ok: true, failures: [], sha: 'sha-dev', tree: 't', commands: [] }),
    });
    expect(await ghost(['start', 'p', '--threshold', '0.6', '--as-is', '0.3', '--tickets', 'REL-1=12'], {
      environment: async ({ dir: at }) => {
        mkdirSync(join(at, 'repo'), { recursive: true });
        mkdirSync(join(at, 'knowledge'), { recursive: true });
        return { start: 'start-sha' };
      },
    })).toBe(0);
    h.checks.failNext('AssertionError: expected 1 to be 2');
    h.runner.enqueue(out({ intake: { size: 's', risk: 'low', complete: true, missing: [], screen: true } }), out({ spec: SPEC }), {}, out({ summary: 'Done.' }));
    await h.delegateReplays();
    const dev = h.runner.requests.find((r) => r.prompt.startsWith('/factory:build'))!;
    expect(dev.prompt).not.toContain('## Find how to start the application');
    expect(recipes.read('p')).toBeUndefined();
    expect(git('log', '--format=%s')).toBe('init');
  });

  it('criterion 2: a daemon without sandboxes, the replay is refused with the reason', async () => {
    const { h, ghost, lines } = replayed();
    expect(await ghost(['start', 'p', '--threshold', '0.6', '--as-is', '0.3', '--tickets', 'REL-1=12'], { sandboxes: async () => false })).toBe(1);
    expect(lines.at(-1)).toMatch(/no sandboxes/);
    await h.delegateReplays();
    expect(h.runner.requests).toEqual([]);
  });
});
