import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KnowledgeBase } from './kb.js';

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
    expect(kb.readIndex()).toContain('agrégats côté serveur');
    expect(kb.readIndex(5)).toHaveLength(5);
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
    await kb.pull();
    expect((await kb.search('webhooks'))[0]!.file).toBe('notes/new.md');
  });
});
