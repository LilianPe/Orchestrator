import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KnowledgeBase } from './kb.js';
import { recipeStart } from '../core/agent-output.js';
import { formatRecipeNote, noSearchReason, parseRecipeNote, PreviewRecipes, recipeNotePath, repoNameOf, searchAsked, searchOwed, type NotFoundNote, type RecipeNote } from './preview-recipe.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const SHA = 'c0ffee'.padEnd(40, '0');

function kbRepo() {
  const base = mkdtempSync(join(tmpdir(), 'factory-recipe-'));
  const origin = join(base, 'origin.git');
  git(base, 'init', '--bare', '-q', '-b', 'main', origin);
  const repo = join(base, 'kb');
  git(base, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'INDEX.md'), '- nothing yet\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  return { base, origin, repo };
}

const valid: RecipeNote = {
  scope: 'repo:acme/shop',
  recipe: { command: 'npm run dev', setup: ['npm run build'] },
  sha: SHA,
  port: 4200,
  checkedAt: '2026-11-14',
  origin: 'agent:build@run-1',
  ticket: 'REL-1',
  status: 'valid',
  research: false,
};

describe('the format of a start recipe (ORC-386)', () => {
  it('reads back what it writes: a Claim Ledger `command` fact in a front matter, a line for humans under it', () => {
    const text = formatRecipeNote(valid);
    expect(text).toMatch(/^---\ntype: command\nkey: preview\nscope: repo:acme\/shop\n/);
    expect(text).toContain('npm run dev');
    expect(parseRecipeNote(text)).toEqual(valid);
    const invalid: RecipeNote = { ...valid, status: 'invalid', invalidated: { reason: 'nothing answers', sha: SHA, ticket: 'REL-2', at: '2026-11-15' }, searchesLeft: 1 };
    expect(parseRecipeNote(formatRecipeNote(invalid))).toEqual(invalid);
  });

  it('reads a note a human broke as unreadable, never as no note', () => {
    expect(parseRecipeNote('no front matter')).toBe('unreadable');
    expect(parseRecipeNote(formatRecipeNote(valid).replace('status: valid', 'status: maybe'))).toBe('unreadable');
    expect(parseRecipeNote(formatRecipeNote(valid).replace('command: npm run dev', 'command: ""'))).toBe('unreadable');
  });

  it('starts the setup then the command, in one line', () => {
    expect(recipeStart({ command: 'npm run dev', setup: [] })).toBe('npm run dev');
    expect(recipeStart({ command: 'npm run dev', setup: ['npm run build', 'npm run seed'] })).toBe('npm run build && npm run seed && npm run dev');
  });

  it("names the repository from its origin, never with the URL's credentials, else the project's id", () => {
    expect(repoNameOf('https://x-access-token:ghs_secret@github.com/acme/shop.git', 'p')).toBe('acme/shop');
    expect(repoNameOf('git@github.com:acme/shop.git', 'p')).toBe('acme/shop');
    expect(repoNameOf('https://github.com/acme/shop', 'p')).toBe('acme/shop');
    expect(repoNameOf('/tmp/origin', 'p')).toBe('p');
    expect(repoNameOf('https://github.com/../etc', 'p')).toBe('p');
    expect(repoNameOf(undefined, 'p')).toBe('p');
    expect(recipeNotePath('acme/shop')).toBe('notes/preview/acme/shop.md');
    expect(recipeNotePath('p')).toBe('notes/preview/p.md');
  });

  it('asks the build agent only where a proof could use it: a browser, nothing declared, no services, no replay, a search owed', () => {
    const ask = { step: 'build', canShoot: true, replayed: false, declared: false, services: false, fingerprint: undefined };
    expect(searchAsked(ask, undefined)).toBe(true);
    expect(searchAsked(ask, valid)).toBe(false);
    for (const over of [{ step: 'fix' }, { canShoot: false }, { replayed: true }, { declared: true }, { services: true }]) expect(searchAsked({ ...ask, ...over }, undefined)).toBe(false);
  });

  it('owes a search without a note, and once after an invalidation, never after a valid or unreadable note', () => {
    expect(searchOwed(undefined)).toBe(true);
    expect(searchOwed(valid)).toBe(false);
    expect(searchOwed('unreadable')).toBe(false);
    expect(searchOwed({ ...valid, status: 'invalid', searchesLeft: 1 })).toBe(true);
    expect(searchOwed({ ...valid, status: 'invalid', searchesLeft: 0 })).toBe(false);
  });
});

describe("the factory's writer of start recipes (ORC-386)", () => {
  const vet = async () => {};

  it('criterion 1: writes notes/preview/<repo>.md, commits it naming the ticket, pushes it', async () => {
    const { repo, origin } = kbRepo();
    const recipes = new PreviewRecipes(new KnowledgeBase(repo));
    const warning = await recipes.record('acme/shop', { recipe: valid.recipe, sha: SHA, port: 4200, runId: 'run-1', ticket: 'REL-1', at: new Date('2026-11-14T10:00:00Z') }, undefined, vet);
    expect(warning).toBeUndefined();
    expect(recipes.read('acme/shop')).toEqual(valid);
    expect(git(origin, 'log', '-1', '--format=%s%n%an', 'main')).toBe('preview(acme/shop): start recipe validated on c0ffee000000 (REL-1)\nOrchestrator factory');
    expect(git(origin, 'show', 'main:notes/preview/acme/shop.md')).toContain('npm run dev');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('a refused push is said, and the commit undone: the clone stays pullable', async () => {
    const { repo, origin } = kbRepo();
    const hook = join(origin, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "protected branch" >&2\nexit 1\n', { mode: 0o755 });
    const before = git(repo, 'rev-parse', 'HEAD');
    const recipes = new PreviewRecipes(new KnowledgeBase(repo));
    const warning = await recipes.record('acme/shop', { recipe: valid.recipe, sha: SHA, port: 4200, runId: 'run-1', ticket: 'REL-1', at: new Date('2026-11-14T10:00:00Z') }, undefined, vet);
    expect(warning).toMatch(/push refused.*undone/);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(existsSync(join(repo, 'notes/preview/acme/shop.md'))).toBe(false);
  });

  it('a clone without a remote keeps the commit, and says it is not pushed', async () => {
    const { repo } = kbRepo();
    git(repo, 'remote', 'remove', 'origin');
    const recipes = new PreviewRecipes(new KnowledgeBase(repo));
    const warning = await recipes.record('acme/shop', { recipe: valid.recipe, sha: SHA, port: 4200, runId: 'run-1', ticket: 'REL-1', at: new Date('2026-11-14T10:00:00Z') }, undefined, vet);
    expect(warning).toMatch(/no remote/);
    expect(recipes.read('acme/shop')).toMatchObject({ status: 'valid' });
  });

  it('a note the output policy refuses is not written', async () => {
    const { repo } = kbRepo();
    const recipes = new PreviewRecipes(new KnowledgeBase(repo));
    const refuse = async () => {
      throw new Error('a secret');
    };
    await expect(recipes.record('acme/shop', { recipe: valid.recipe, sha: SHA, port: 4200, runId: 'run-1', ticket: 'REL-1', at: new Date() }, undefined, refuse)).rejects.toThrow('a secret');
    expect(recipes.read('acme/shop')).toBeUndefined();
  });

  it('criterion 4: invalidates a recipe that no longer starts, owing one search; a recipe of that search invalidated owes none', async () => {
    const { repo, origin } = kbRepo();
    const recipes = new PreviewRecipes(new KnowledgeBase(repo));
    const at = new Date('2026-11-15T10:00:00Z');
    await recipes.record('acme/shop', { recipe: valid.recipe, sha: SHA, port: 4200, runId: 'run-1', ticket: 'REL-1', at }, undefined, vet);
    await recipes.invalidate('acme/shop', recipes.read('acme/shop') as RecipeNote, { reason: 'nothing answers on port 4200', sha: SHA, ticket: 'REL-2', at }, vet);
    const invalid = recipes.read('acme/shop') as RecipeNote;
    expect(invalid).toMatchObject({ status: 'invalid', searchesLeft: 1, invalidated: { reason: 'nothing answers on port 4200', ticket: 'REL-2', at: '2026-11-15' } });
    expect(git(origin, 'log', '-1', '--format=%s', 'main')).toBe('preview(acme/shop): start recipe invalidated on c0ffee000000 (REL-2)');
    // The one search after it finds a new recipe: written as found by that search.
    await recipes.record('acme/shop', { recipe: { command: 'make serve', setup: [] }, sha: SHA, port: 4200, runId: 'run-3', ticket: 'REL-3', at }, invalid, vet);
    const again = recipes.read('acme/shop') as RecipeNote;
    expect(again).toMatchObject({ status: 'valid', research: true, recipe: { command: 'make serve' } });
    await recipes.invalidate('acme/shop', again, { reason: 'EADDRINUSE', sha: SHA, ticket: 'REL-4', at }, vet);
    expect(recipes.read('acme/shop')).toMatchObject({ status: 'invalid', searchesLeft: 0 });
  });

  it('criterion 4: the one search after an invalidation that finds nothing owes no other', async () => {
    const { repo } = kbRepo();
    const recipes = new PreviewRecipes(new KnowledgeBase(repo));
    const at = new Date('2026-11-15T10:00:00Z');
    await recipes.record('acme/shop', { recipe: valid.recipe, sha: SHA, port: 4200, runId: 'run-1', ticket: 'REL-1', at }, undefined, vet);
    await recipes.invalidate('acme/shop', recipes.read('acme/shop') as RecipeNote, { reason: 'gone', sha: SHA, ticket: 'REL-2', at }, vet);
    await recipes.searchSpent('acme/shop', recipes.read('acme/shop') as RecipeNote, { ticket: 'REL-3', sha: SHA }, vet);
    expect(recipes.read('acme/shop')).toMatchObject({ status: 'invalid', searchesLeft: 0, invalidated: { reason: 'gone' } });
    expect(searchOwed(recipes.read('acme/shop'))).toBe(false);
  });

  it("a replayed ticket's read is the knowledge base at its start, never the one of now", async () => {
    const { repo, base } = kbRepo();
    const recipes = new PreviewRecipes(new KnowledgeBase(repo));
    const snapshot = join(base, 'snapshot');
    mkdirSync(join(snapshot, 'notes/preview/acme'), { recursive: true });
    writeFileSync(join(snapshot, 'notes/preview/acme/shop.md'), formatRecipeNote({ ...valid, recipe: { command: 'old start', setup: [] } }));
    await recipes.record('acme/shop', { recipe: valid.recipe, sha: SHA, port: 4200, runId: 'run-1', ticket: 'REL-1', at: new Date() }, undefined, vet);
    expect(recipes.read('acme/shop', snapshot)).toMatchObject({ recipe: { command: 'old start' } });
    expect(readFileSync(join(repo, 'notes/preview/acme/shop.md'), 'utf8')).toContain('npm run dev');
  });

  it('a clone off its default branch is not written to, as it is not pulled', async () => {
    const { repo, origin } = kbRepo();
    git(repo, 'switch', '-q', '-c', 'draft');
    const before = git(origin, 'rev-parse', 'main');
    const recipes = new PreviewRecipes(new KnowledgeBase(repo));
    const warning = await recipes.record('acme/shop', { recipe: valid.recipe, sha: SHA, port: 4200, runId: 'run-1', ticket: 'REL-1', at: new Date() }, undefined, vet);
    expect(warning).toMatch(/not on its default branch.*not written/);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('init');
    expect(git(origin, 'rev-parse', 'main')).toBe(before);
  });

  it('pulls before it writes: a remote that moved since the last refresh takes the write', async () => {
    const { base, origin, repo } = kbRepo();
    const other = join(base, 'other');
    git(base, 'clone', '-q', origin, other);
    writeFileSync(join(other, 'INDEX.md'), '- moved\n');
    git(other, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'moved');
    git(other, 'push', '-q');
    const recipes = new PreviewRecipes(new KnowledgeBase(repo));
    expect(await recipes.record('acme/shop', { recipe: valid.recipe, sha: SHA, port: 4200, runId: 'run-1', ticket: 'REL-1', at: new Date() }, undefined, vet)).toBeUndefined();
    expect(git(origin, 'log', '--format=%s', 'main').split('\n')).toEqual(['preview(acme/shop): start recipe validated on c0ffee000000 (REL-1)', 'moved', 'init']);
  });

  it('a note another write changed since it was read is left alone: two tickets of the same search lose nothing', async () => {
    const { repo } = kbRepo();
    const recipes = new PreviewRecipes(new KnowledgeBase(repo));
    const at = new Date('2026-11-15T10:00:00Z');
    await recipes.record('acme/shop', { recipe: valid.recipe, sha: SHA, port: 4200, runId: 'run-1', ticket: 'REL-1', at }, undefined, vet);
    await recipes.invalidate('acme/shop', recipes.read('acme/shop') as RecipeNote, { reason: 'gone', sha: SHA, ticket: 'REL-2', at }, vet);
    // Tickets A and B both read the invalid note; A finds a recipe first, then B's search found none.
    const read = recipes.read('acme/shop') as RecipeNote;
    await recipes.record('acme/shop', { recipe: { command: 'make serve', setup: [] }, sha: SHA, port: 4200, runId: 'run-a', ticket: 'REL-A', at }, read, vet);
    expect(await recipes.searchSpent('acme/shop', read, { ticket: 'REL-B', sha: SHA }, vet)).toMatch(/changed since it was read/);
    expect(recipes.read('acme/shop')).toMatchObject({ status: 'valid', recipe: { command: 'make serve' } });
    // A recipe read absent and written meanwhile is not written over either.
    expect(await recipes.record('acme/shop', { recipe: valid.recipe, sha: SHA, port: 4200, runId: 'run-c', ticket: 'REL-C', at }, undefined, vet)).toMatch(/changed since it was read/);
  });

  it('writes nowhere but under notes/preview/', async () => {
    const { repo } = kbRepo();
    const kb = new KnowledgeBase(repo);
    for (const path of ['INDEX.md', 'notes/a.md', 'notes/preview/../a.md', '/etc/x.md']) {
      await expect(kb.commitNote(path, 'x', 'm')).rejects.toThrow('notes/preview/');
    }
  });
});

describe('a search bounded at three failures (ORC-406)', () => {
  const vet = async () => {};
  const at = new Date('2026-11-15T10:00:00Z');
  const FP = 'a'.repeat(64);
  const ask = { step: 'build', canShoot: true, replayed: false, declared: false, services: false, fingerprint: FP };
  /** What `verify` made of a search: by default, asked and finding nothing. */
  const settled = (ticket: string, over: Partial<Parameters<PreviewRecipes['settle']>[2]> = {}) => ({ asked: true, found: undefined, outcome: undefined, sha: SHA, port: 4200, runId: `run-${ticket}`, ticket, at, fingerprint: FP, declared: false, ...over });
  const notFound: NotFoundNote = { scope: 'repo:acme/shop', status: 'not_found', failures: 2, fingerprint: FP, origin: 'agent:build@run-2', ticket: 'REL-2', checkedAt: '2026-11-15' };

  it('reads back a search that found nothing: its count and the fingerprint of the files that decide the start', () => {
    const text = formatRecipeNote(notFound);
    expect(text).toMatch(/^---\ntype: command\nkey: preview\nscope: repo:acme\/shop\nstatus: not_found\n/);
    expect(parseRecipeNote(text)).toEqual(notFound);
    const { fingerprint: _, ...unread } = notFound;
    expect(parseRecipeNote(formatRecipeNote(unread))).toEqual(unread);
  });

  it('criterion 1: three searches that find nothing are noted, and no fourth is asked while the fingerprint holds', async () => {
    const { repo, origin } = kbRepo();
    const recipes = new PreviewRecipes(new KnowledgeBase(repo));
    for (const [i, ticket] of ['REL-1', 'REL-2', 'REL-3'].entries()) {
      expect(searchAsked(ask, recipes.read('acme/shop'))).toBe(true);
      expect(await recipes.settle('acme/shop', recipes.read('acme/shop'), settled(ticket), vet)).toBeUndefined();
      expect(recipes.read('acme/shop')).toMatchObject({ status: 'not_found', failures: i + 1, fingerprint: FP, ticket, origin: `agent:build@run-${ticket}` });
    }
    expect(git(origin, 'log', '-1', '--format=%s', 'main')).toBe('preview(acme/shop): no start recipe found on c0ffee000000 (REL-3, 3 of 3)');
    const note = recipes.read('acme/shop');
    expect(searchOwed(note, FP)).toBe(false);
    expect(searchAsked(ask, note)).toBe(false);
    expect(noSearchReason(note, FP)).toMatch(/searched 3 times.*until the files that decide how it starts change/);
    expect(noSearchReason(notFound, FP)).toBeUndefined();
  });

  it('criterion 2: a changed fingerprint asks again, and its failure counts from one', async () => {
    const { repo } = kbRepo();
    const recipes = new PreviewRecipes(new KnowledgeBase(repo));
    for (const ticket of ['REL-1', 'REL-2', 'REL-3']) await recipes.settle('acme/shop', recipes.read('acme/shop'), settled(ticket), vet);
    const other = 'b'.repeat(64);
    expect(searchAsked({ ...ask, fingerprint: other }, recipes.read('acme/shop'))).toBe(true);
    expect(noSearchReason(recipes.read('acme/shop'), other)).toBeUndefined();
    await recipes.settle('acme/shop', recipes.read('acme/shop'), settled('REL-4', { fingerprint: other }), vet);
    expect(recipes.read('acme/shop')).toMatchObject({ status: 'not_found', failures: 1, fingerprint: other });
  });

  it('a fingerprint git could not read leaves the last one standing: a passing git failure neither asks again nor resets the count', async () => {
    const { fingerprint: _, ...unread } = { ...notFound, failures: 3 };
    expect(searchOwed(unread, undefined)).toBe(false);
    expect(searchOwed(unread, FP)).toBe(true);
    expect(searchOwed({ ...notFound, failures: 3 }, undefined)).toBe(false);
    expect(noSearchReason({ ...notFound, failures: 3 }, undefined)).toMatch(/searched 3 times/);
    const { repo } = kbRepo();
    const recipes = new PreviewRecipes(new KnowledgeBase(repo));
    await recipes.settle('acme/shop', undefined, settled('REL-1'), vet);
    await recipes.settle('acme/shop', recipes.read('acme/shop'), settled('REL-2', { fingerprint: undefined }), vet);
    expect(recipes.read('acme/shop')).toMatchObject({ failures: 2, fingerprint: FP });
  });

  it("counts one failure per ticket: a ticket's own relaunches spend nothing of the other tickets' searches", async () => {
    const { repo } = kbRepo();
    const recipes = new PreviewRecipes(new KnowledgeBase(repo));
    await recipes.settle('acme/shop', undefined, settled('REL-1'), vet);
    expect(await recipes.settle('acme/shop', recipes.read('acme/shop'), settled('REL-1'), vet)).toBeUndefined();
    expect(recipes.read('acme/shop')).toMatchObject({ failures: 1, ticket: 'REL-1' });
    // Unless the start files changed meanwhile: that count starts again from this ticket.
    await recipes.settle('acme/shop', recipes.read('acme/shop'), settled('REL-1', { fingerprint: 'b'.repeat(64) }), vet);
    expect(recipes.read('acme/shop')).toMatchObject({ failures: 1, fingerprint: 'b'.repeat(64) });
  });

  it('a found recipe that did not answer is a failure; one the check never reached is not, and a search not asked writes nothing', async () => {
    const { repo } = kbRepo();
    const recipes = new PreviewRecipes(new KnowledgeBase(repo));
    await recipes.settle('acme/shop', undefined, settled('REL-1', { found: valid.recipe }), vet);
    expect(recipes.read('acme/shop')).toBeUndefined();
    await recipes.settle('acme/shop', undefined, settled('REL-1', { asked: false }), vet);
    expect(recipes.read('acme/shop')).toBeUndefined();
    await recipes.settle('acme/shop', undefined, settled('REL-1', { found: valid.recipe, outcome: { of: 'found', answered: false, detail: 'nothing answers' } }), vet);
    expect(recipes.read('acme/shop')).toMatchObject({ status: 'not_found', failures: 1 });
  });

  it('a recipe found after failures replaces them, as any first recipe', async () => {
    const { repo } = kbRepo();
    const recipes = new PreviewRecipes(new KnowledgeBase(repo));
    await recipes.settle('acme/shop', undefined, settled('REL-1'), vet);
    await recipes.settle('acme/shop', recipes.read('acme/shop'), settled('REL-2', { found: valid.recipe, outcome: { of: 'found', answered: true } }), vet);
    expect(recipes.read('acme/shop')).toMatchObject({ status: 'valid', research: false, recipe: valid.recipe, ticket: 'REL-2' });
  });

  it('a declared `preview` sets the count back to zero, once', async () => {
    const { repo, origin } = kbRepo();
    const recipes = new PreviewRecipes(new KnowledgeBase(repo));
    for (const ticket of ['REL-1', 'REL-2', 'REL-3']) await recipes.settle('acme/shop', recipes.read('acme/shop'), settled(ticket), vet);
    await recipes.settle('acme/shop', recipes.read('acme/shop'), settled('REL-4', { asked: false, declared: true }), vet);
    expect(recipes.read('acme/shop')).toMatchObject({ status: 'not_found', failures: 0, origin: 'factory@run-REL-4', ticket: 'REL-4' });
    expect(git(origin, 'log', '-1', '--format=%s', 'main')).toBe('preview(acme/shop): failed searches reset, `preview` declared (REL-4)');
    expect(searchOwed(recipes.read('acme/shop'), FP)).toBe(true);
    const commits = git(origin, 'rev-list', '--count', 'main');
    await recipes.settle('acme/shop', recipes.read('acme/shop'), settled('REL-5', { asked: false, declared: true }), vet);
    expect(git(origin, 'rev-list', '--count', 'main')).toBe(commits);
  });
});
