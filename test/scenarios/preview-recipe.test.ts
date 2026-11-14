import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeShooter } from '../../src/adapters/browser/fake.js';
import { VISUAL_PROOF_CHECK, type VisualProof } from '../../src/checks/visual-proof.js';
import type { AgentOutput, PreviewRecipe } from '../../src/core/agent-output.js';
import type { CleanVerifyRequest, CleanVerifyResult } from '../../src/core/clean-verify.js';
import { KnowledgeBase } from '../../src/knowledge/kb.js';
import { PreviewRecipes, type RecipeNote } from '../../src/knowledge/preview-recipe.js';
import { createHarness } from '../helpers/harness.js';

/**
 * ORC-386: without a declared `preview`, the build agent finds how to start the application, the factory probes it in `verify`
 * (`clean-verify.test.ts`), then records it in the knowledge base. Here, what the orchestrator does around `verify`: when it asks
 * the agent, what it hands `verify`, what it writes to the knowledge base, and what the PR says.
 */
const SHA = 'c0ffee'.padEnd(40, '0');
const WORKTREE = '/tmp/factory-fake/p/REL-1';
const SEARCH = '## Find how to start the application';
const NPM_DEV: PreviewRecipe = { command: 'npm run dev', setup: [] };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function kbRepo() {
  const base = mkdtempSync(join(tmpdir(), 'factory-kb-preview-'));
  const origin = join(base, 'origin.git');
  git(base, 'init', '--bare', '-q', '-b', 'main', origin);
  const repo = join(base, 'kb');
  git(base, 'clone', '-q', origin, repo);
  writeFileSync(join(repo, 'INDEX.md'), '- nothing yet\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  return { origin, recipes: new PreviewRecipes(new KnowledgeBase(repo)) };
}

const dev = (extra: Partial<AgentOutput> = {}) => ({
  output: { status: 'done', summary: 'Button restyled.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], ...extra } satisfies AgentOutput,
});
const required = (start: VisualProof['start'], unavailable?: string): CleanVerifyResult['visual'] => ({
  proof: { decision: 'required', triggers: ['app/page.tsx'], start, ...(unavailable ? { unavailable } : {}) },
  files: [],
});

function preview(opts: { result?: (req: CleanVerifyRequest) => Partial<CleanVerifyResult>; output?: Partial<AgentOutput>; projectYaml?: string; tickets?: number } = {}) {
  const kb = kbRepo();
  const asked: CleanVerifyRequest[] = [];
  const h = createHarness({
    ...(opts.projectYaml ? { projectYaml: opts.projectYaml } : {}),
    sandboxed: true,
    visualShooter: new FakeShooter(),
    previewRecipes: kb.recipes,
    cleanVerify: async (req) => {
      asked.push(req);
      return { ok: true, failures: [], sha: SHA, tree: 't', commands: [], ...opts.result?.(req) };
    },
  });
  for (let i = 1; i <= (opts.tickets ?? 1); i++) {
    h.tracker.addIssue({ identifier: `REL-${i}`, title: 'Restyle the button', description: 'Restyle the settings button.\n\nAcceptance criteria:\n1. It is blue.' });
    h.workspaces.heads.set(`/tmp/factory-fake/p/REL-${i}`, SHA);
  }
  h.workspaces.heads.set(WORKTREE, SHA);
  return { h, asked, ...kb };
}

const delegate = (h: ReturnType<typeof createHarness>, ticketId = 'REL-1') => h.send('ticket.delegated', { linearSessionId: `ls-${ticketId}` }, ticketId);
const lastSubject = (origin: string) => git(origin, 'log', '-1', '--format=%s', 'main');
/** A recipe as the knowledge base kept it, before its fate. */
const learned: Omit<RecipeNote, 'status' | 'research'> = { scope: 'repo:p', recipe: NPM_DEV, sha: SHA, port: 4200, checkedAt: '2026-11-14', origin: 'agent:build@r0', ticket: 'REL-0' };

describe('the start recipe learned in the knowledge base (ORC-386)', () => {
  it('criterion 1: no recipe: the build agent is asked, its recipe probed by verify, recorded naming the ticket, and the PR says it was learned', async () => {
    const { h, asked, recipes, origin } = preview({ result: () => ({ preview: { of: 'found', answered: true }, visual: required('learned') }) });
    h.runner.enqueue(dev({ preview: NPM_DEV }));
    await delegate(h);
    expect(h.runner.requests[0]!.prompt).toContain(SEARCH);
    expect(asked[0]!.visual).toMatchObject({ found: NPM_DEV });
    expect(asked[0]!.visual?.learned).toBeUndefined();
    expect(recipes.read('p')).toMatchObject({ status: 'valid', recipe: NPM_DEV, sha: SHA, ticket: 'REL-1', research: false });
    expect(lastSubject(origin)).toBe('preview(p): start recipe validated on c0ffee000000 (REL-1)');
    expect(h.publisher.asked[0]!.body).toContain('**Start command**: learned in the knowledge base');
    expect(h.forge.checkRuns.find((c) => c.name === VISUAL_PROOF_CHECK)).toMatchObject({ summary: expect.stringContaining('Start command: learned') });
  });

  it('criterion 2: a recipe recorded: no search, verify gets it, nothing written', async () => {
    const { h, asked, recipes, origin } = preview();
    await recipes.record('p', { recipe: NPM_DEV, sha: SHA, port: 4200, runId: 'r0', ticket: 'REL-0', at: new Date() }, undefined, async () => {});
    const before = lastSubject(origin);
    h.runner.enqueue(dev({ preview: { command: 'make serve', setup: [] } }));
    await delegate(h);
    expect(h.runner.requests[0]!.prompt).not.toContain(SEARCH);
    expect(asked[0]!.visual).toMatchObject({ learned: NPM_DEV });
    // What the agent hands back unasked is not even probed.
    expect(asked[0]!.visual?.found).toBeUndefined();
    expect(lastSubject(origin)).toBe(before);
  });

  it('criterion 3: a declared `preview` comes first: no search, and the learned recipe is no start of its own', async () => {
    const { h, asked, recipes } = preview({ projectYaml: 'version: 1\nworkspace:\n  preview: npm start\n' });
    await recipes.record('p', { recipe: NPM_DEV, sha: SHA, port: 4200, runId: 'r0', ticket: 'REL-0', at: new Date() }, undefined, async () => {});
    h.runner.enqueue(dev());
    await delegate(h);
    expect(h.runner.requests[0]!.prompt).not.toContain(SEARCH);
    // verify reads the declared start first (`planVisual`): the learned one comes only after it.
    expect(asked[0]!.visual).toMatchObject({ start: 'npm start' });
  });

  it('criterion 4: a learned recipe that no longer starts is invalidated, and the next build searches once more', async () => {
    let call = 0;
    const { h, recipes, origin } = preview({
      tickets: 2,
      result: () => (call++ === 0 ? { preview: { of: 'learned', answered: false, detail: 'nothing answers on port 4200\nnpm ERR! missing script: dev' }, visual: required('learned', 'stale') } : {}),
    });
    await recipes.record('p', { recipe: NPM_DEV, sha: SHA, port: 4200, runId: 'r0', ticket: 'REL-0', at: new Date() }, undefined, async () => {});
    h.runner.enqueue(dev(), dev());
    await delegate(h);
    expect(recipes.read('p')).toMatchObject({ status: 'invalid', searchesLeft: 1, invalidated: { reason: 'nothing answers on port 4200', ticket: 'REL-1' } });
    expect(lastSubject(origin)).toBe('preview(p): start recipe invalidated on c0ffee000000 (REL-1)');
    // The one new search: asked, and it finds nothing that answers. No other is owed.
    await delegate(h, 'REL-2');
    expect(h.runner.requests[1]!.prompt).toContain(SEARCH);
    expect(recipes.read('p')).toMatchObject({ status: 'invalid', searchesLeft: 0 });
    expect(h.publisher.asked[0]!.body).toContain('**Start command**: learned');
  });

  it('criterion 5: the agent finds none: nothing written, the proof unavailable with why in the PR, which is not blocked', async () => {
    const { h, recipes, origin } = preview({ result: () => ({ visual: required('none', 'no command starts the application (`preview` in .factory/config.yml), and the knowledge base has learned none') }) });
    const before = lastSubject(origin);
    h.runner.enqueue(dev());
    await delegate(h);
    expect(h.runner.requests[0]!.prompt).toContain(SEARCH);
    expect(recipes.read('p')).toBeUndefined();
    expect(lastSubject(origin)).toBe(before);
    expect(h.publisher.asked[0]!.body).toContain('**Start command**: none');
    expect(h.forge.checkRuns.find((c) => c.name === VISUAL_PROOF_CHECK)).toMatchObject({ conclusion: 'neutral', summary: expect.stringContaining('learned none') });
    expect(await h.ticket()).toMatchObject({ logical: 'human_review' });
  });

  it('a write the knowledge base refuses is logged: the verdict stands', async () => {
    const { h, origin } = preview({ result: () => ({ preview: { of: 'found', answered: true } }) });
    writeFileSync(join(origin, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    h.runner.enqueue(dev({ preview: NPM_DEV }));
    await delegate(h);
    expect(h.logs.some((l) => l.message.includes('push refused'))).toBe(true);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review' });
  });

  it('a found recipe is written only where verify says it answered', async () => {
    const { h, recipes } = preview({ result: () => ({ preview: { of: 'found', answered: false, detail: 'nothing answers' } }) });
    h.runner.enqueue(dev({ preview: NPM_DEV }));
    await delegate(h);
    expect(recipes.read('p')).toBeUndefined();
  });

  it('a recipe already invalidated twice is no search, and verify gets nothing to start', async () => {
    const { h, asked, recipes } = preview();
    const found: RecipeNote = { ...learned, status: 'valid', research: true };
    await recipes.invalidate('p', found, { reason: 'gone', sha: SHA, ticket: 'REL-0', at: new Date() }, async () => {});
    h.runner.enqueue(dev({ preview: NPM_DEV }));
    await delegate(h);
    expect(h.runner.requests[0]!.prompt).not.toContain(SEARCH);
    expect(asked[0]!.visual?.learned).toBeUndefined();
    expect(asked[0]!.visual?.found).toBeUndefined();
  });
});
