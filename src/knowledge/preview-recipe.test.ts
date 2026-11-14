import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KnowledgeBase } from './kb.js';
import { formatRecipeNote, parseRecipeNote, PreviewRecipes, recipeNotePath, recipeStart, repoNameOf, searchOwed, type RecipeNote } from './preview-recipe.js';

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
    expect(git(origin, 'log', '-1', '--format=%s%n%an', 'main')).toBe('preview(acme/shop): start recipe validated on c0ffee000000 (REL-1)\nRelais factory');
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

  it('writes nowhere but under notes/preview/', async () => {
    const { repo } = kbRepo();
    const kb = new KnowledgeBase(repo);
    for (const path of ['INDEX.md', 'notes/a.md', 'notes/preview/../a.md', '/etc/x.md']) {
      await expect(kb.commitNote(path, 'x', 'm')).rejects.toThrow('notes/preview/');
    }
  });
});
