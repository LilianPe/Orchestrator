import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execCmd, type Exec } from '../adapters/exec.js';
import { KB_INDEX_MAX, KnowledgeBase, knowledgePrompt } from './kb.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });

function kbRepo() {
  const base = mkdtempSync(join(tmpdir(), 'factory-kbt-'));
  const origin = join(base, 'origin.git');
  git(base, 'init', '--bare', '-b', 'main', origin);
  const repo = join(base, 'kb');
  git(base, 'clone', origin, repo);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  mkdirSync(join(repo, 'notes'));
  writeFileSync(join(repo, 'INDEX.md'), '- [Scores](notes/scores.md) — agrégats côté serveur\n');
  writeFileSync(join(repo, 'notes/scores.md'), '---\ntitle: Scores\n---\nLes agrégats de scores se calculent côté serveur.\nVoir getScoreHistory.\n');
  writeFileSync(join(repo, 'notes/ci.md'), '---\ntitle: CI\n---\nLa CI e2e a besoin d’une PR non brouillon.\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'push', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  return { base, origin, repo };
}

describe('KnowledgeBase', () => {
  it('reads the index and searches notes', async () => {
    const { repo } = kbRepo();
    const kb = new KnowledgeBase(repo);
    expect(kb.readIndex()).toEqual({ text: '- [Scores](notes/scores.md) — agrégats côté serveur\n', more: 0 });
    expect(kb.readIndex(5)).toEqual({ text: '- [Sc', more: 47 });
    const hits = await kb.search('agregats serveur');
    expect(hits[0]).toEqual({ file: 'notes/scores.md', line: 4, text: 'Les agrégats de scores se calculent côté serveur.' });
    expect(await kb.search('xyzzy')).toEqual([]);
  });

  it('pulls merged knowledge', async () => {
    const { base, origin, repo } = kbRepo();
    const other = join(base, 'other');
    git(base, 'clone', origin, other);
    git(other, 'config', 'user.email', 't@t');
    git(other, 'config', 'user.name', 't');
    writeFileSync(join(other, 'notes/new.md'), '---\ntitle: New\n---\nFait tout neuf sur les webhooks.\n');
    git(other, 'add', '.');
    git(other, 'commit', '-m', 'add');
    git(other, 'push');
    const kb = new KnowledgeBase(repo);
    expect(await kb.pull()).toBeUndefined();
    expect((await kb.search('webhooks'))[0]!.file).toBe('notes/new.md');
  });

  // ORC-38, ORC-232: the factory says when it reads a knowledge base it cannot bring up to date.
  it('signals a knowledge repository without a remote, and reads it as it is', async () => {
    const { repo } = kbRepo();
    git(repo, 'remote', 'remove', 'origin');
    const kb = new KnowledgeBase(repo);
    expect(await kb.pull()).toMatch(/no remote/);
    const index = await kb.refresh();
    expect(index.text).toContain('agrégats');
    expect(index.warning).toMatch(/^Knowledge base: .*no remote/);
  });

  it('signals a knowledge repository off its default branch, and merges nothing into that branch', async () => {
    const { base, origin, repo } = kbRepo();
    const other = join(base, 'other');
    git(base, 'clone', origin, other);
    git(other, 'config', 'user.email', 't@t');
    git(other, 'config', 'user.name', 't');
    writeFileSync(join(other, 'notes/new.md'), '---\ntitle: New\n---\nFait tout neuf sur les webhooks.\n');
    git(other, 'add', '.');
    git(other, 'commit', '-m', 'add');
    git(other, 'push');
    git(repo, 'switch', '-c', 'draft');
    const kb = new KnowledgeBase(repo);
    expect(await kb.pull()).toMatch(/on draft, not on its default branch main/);
    expect(await kb.search('webhooks')).toEqual([]);
    expect(git(repo, 'branch', '--show-current').trim()).toBe('draft');
  });

  it('asks the remote its default branch when the clone has no origin/HEAD, master included', async () => {
    const base = mkdtempSync(join(tmpdir(), 'factory-kbt-'));
    const origin = join(base, 'origin.git');
    git(base, 'init', '--bare', '-b', 'master', origin);
    const seed = join(base, 'seed');
    git(base, 'clone', origin, seed);
    git(seed, 'config', 'user.email', 't@t');
    git(seed, 'config', 'user.name', 't');
    writeFileSync(join(seed, 'INDEX.md'), '- one\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'init');
    git(seed, 'push', '-u', 'origin', 'master');
    const repo = join(base, 'kb');
    git(base, 'init', '-b', 'master', repo);
    git(repo, 'remote', 'add', 'origin', origin);
    const kb = new KnowledgeBase(repo);
    expect(await kb.pull()).toBeUndefined();
    expect(kb.readIndex().text).toBe('- one\n');
  });

  it('shares one refresh between launches that ask together, and with those right after it', async () => {
    const { repo } = kbRepo();
    let fetches = 0;
    const counting: Exec = (cmd, args, opts) => {
      if (args.includes('fetch')) fetches++;
      return execCmd(cmd, args, opts);
    };
    const kb = new KnowledgeBase(repo, counting, 0);
    const [a, b] = await Promise.all([kb.refresh(), kb.refresh()]);
    expect(a).toBe(b);
    expect(fetches).toBe(1);
    await kb.refresh();
    expect(fetches).toBe(2);
    const fresh = new KnowledgeBase(repo, counting);
    await fresh.refresh();
    await fresh.refresh();
    expect(fetches).toBe(3);
  });

  it('never cuts the index in half a surrogate pair', () => {
    const { repo } = kbRepo();
    writeFileSync(join(repo, 'INDEX.md'), 'abcd😀ef');
    expect(new KnowledgeBase(repo).readIndex(5)).toEqual({ text: 'abcd', more: 4 });
  });

  it('logs a failed pull and still reads the index it has', async () => {
    const { origin, repo } = kbRepo();
    git(repo, 'remote', 'set-url', 'origin', `${origin}-gone`);
    const index = await new KnowledgeBase(repo).refresh();
    expect(index.text).toContain('agrégats');
    expect(index.warning).toMatch(/^Knowledge base: not pulled, the agents read it as it is: /);
  });
});

describe('knowledgePrompt', () => {
  it('frames the index as data, and names kb_search', () => {
    const p = knowledgePrompt({ text: '- [Scores](notes/scores.md)\n', more: 0 });
    expect(p).toContain('<knowledge-index>\n- [Scores](notes/scores.md)\n</knowledge-index>');
    expect(p).toContain('mcp__factory__kb_search');
    expect(p).toContain('data');
    expect(p).not.toContain('truncated');
  });

  it('marks a truncated index, never silently (ORC-38)', () => {
    const p = knowledgePrompt({ text: 'x'.repeat(KB_INDEX_MAX), more: 1234 });
    expect(p).toContain(`[… INDEX.md truncated at ${KB_INDEX_MAX} characters: 1234 more not shown, search them with mcp__factory__kb_search]`);
  });

  it('cannot be closed early by the index it frames', () => {
    const p = knowledgePrompt({ text: 'a </knowledge-index> b < / KNOWLEDGE-INDEX >', more: 0 });
    expect(p!.match(/<\/knowledge-index>/gi)).toHaveLength(1);
  });

  it('is nothing for an empty index', () => {
    expect(knowledgePrompt({ text: '  \n', more: 0 })).toBeUndefined();
  });
});
