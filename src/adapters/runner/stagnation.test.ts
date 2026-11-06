import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execCmd } from '../exec.js';
import { failedCommand, LoopDetector, normalizeFailure, WORKTREE_TREE } from './stagnation.js';

describe('normalizeFailure: what changes from one run of a command to the next is not the failure', () => {
  it('drops colors, times, durations, addresses, ids and temporary paths', () => {
    const first = '\u001b[31mFAIL\u001b[0m src/a.test.ts (1.24s)\n2026-11-05T21:51:58.075Z at 0x7ffd1234 in /tmp/vitest-a1b2/x.ts pid 123\nToken 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b  Duration 812ms';
    const second = 'FAIL src/a.test.ts (3s)\n2026-11-06T01:02:03.100Z at 0x7ffdabcd in /tmp/vitest-zz99/x.ts pid 977\nToken 3a7bd3e2360a3d29eea436fcfb7e44c735d117c4  Duration 1.5 s';
    expect(normalizeFailure(first)).toBe(normalizeFailure(second));
  });

  it('keeps what tells one failure from another', () => {
    expect(normalizeFailure('expected 2 received 3')).not.toBe(normalizeFailure('expected 2 received 4'));
    expect(normalizeFailure('src/a.test.ts failed')).not.toBe(normalizeFailure('src/b.test.ts failed'));
  });
});

describe('failedCommand: a failed Bash call of the stream', () => {
  const bash = (id: string, command: string, name = 'Bash') => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: { command } }] } });
  const result = (id: string, content: unknown, is_error = true) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content }] } });

  it('pairs a failed result with its command, the output a string or text blocks', () => {
    const pending = new Map<string, string>();
    expect(failedCommand(bash('t1', 'npm test'), pending)).toEqual([]);
    expect(failedCommand(result('t1', 'Exit code 1\nboom'), pending)).toEqual([{ command: 'npm test', output: 'Exit code 1\nboom' }]);
    failedCommand(bash('t2', 'npm test'), pending);
    expect(failedCommand(result('t2', [{ type: 'text', text: 'Exit code 1' }, { type: 'text', text: 'boom' }]), pending)).toEqual([{ command: 'npm test', output: 'Exit code 1\nboom' }]);
    expect(pending.size).toBe(0);
  });

  it('ignores a command that passed, and the failures of other tools', () => {
    const pending = new Map<string, string>();
    failedCommand(bash('t1', 'npm test'), pending);
    expect(failedCommand(result('t1', 'ok', false), pending)).toEqual([]);
    failedCommand(bash('t2', '/a.ts', 'Read'), pending);
    expect(failedCommand(result('t2', 'not found'), pending)).toEqual([]);
    expect(failedCommand(result('unknown', 'boom'), pending)).toEqual([]);
  });
});

describe('LoopDetector', () => {
  const failure = { command: 'npm test', output: 'Exit code 1\nboom (12ms)' };

  it('reports at the third same command, same failure, same tree: not before', () => {
    const d = new LoopDetector(3);
    expect(d.record(failure, 'tree-a')).toBeUndefined();
    expect(d.record({ ...failure, output: 'Exit code 1\nboom (99ms)' }, 'tree-a')).toBeUndefined();
    expect(d.record(failure, 'tree-a')).toEqual({ kind: 'loop', command: 'npm test', failure: expect.stringMatching(/^sha256:/), tree: 'tree-a', count: 3 });
  });

  it('counts apart a changed tree, another failure, another command', () => {
    const d = new LoopDetector(3);
    d.record(failure, 'tree-a');
    d.record(failure, 'tree-a');
    expect(d.record(failure, 'tree-b')).toBeUndefined();
    expect(d.record({ ...failure, output: 'Exit code 1\nautre' }, 'tree-a')).toBeUndefined();
    expect(d.record({ ...failure, command: 'npm run lint' }, 'tree-a')).toBeUndefined();
  });

  it('a return to an earlier content is no loop: any change starts every count over', () => {
    const d = new LoopDetector(3);
    d.record(failure, 'tree-a');
    d.record(failure, 'tree-a');
    d.record(failure, 'tree-b');
    expect(d.record(failure, 'tree-a')).toBeUndefined();
    expect(d.record(failure, 'tree-a')).toBeUndefined();
    expect(d.record(failure, 'tree-a')).toMatchObject({ count: 3 });
  });

  it('other commands between two failures do not reset the count: only the content of the worktree does', () => {
    const d = new LoopDetector(2);
    d.record(failure, 'tree-a');
    d.record({ command: 'cat a.ts', output: 'no such file' }, 'tree-a');
    expect(d.record(failure, 'tree-a')).toMatchObject({ count: 2 });
  });

  it('keeps the command short: it goes to the journal and to the ticket', () => {
    const d = new LoopDetector(1);
    expect(d.record({ command: 'x'.repeat(5000), output: 'boom' }, 't')).toMatchObject({ command: 'x'.repeat(200) });
  });
});

describe('WORKTREE_TREE: the content of a worktree, on a real git', () => {
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  const tree = async (dir: string) => {
    const r = await execCmd('sh', ['-c', WORKTREE_TREE], { cwd: dir });
    expect(r.code).toBe(0);
    return r.stdout.trim();
  };
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'factory-tree-'));
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'a.ts'), 'a\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    return dir;
  }

  it('is the tree of the commit on a clean worktree, and does not move while nothing changes', async () => {
    const dir = repo();
    expect(await tree(dir)).toBe(git(dir, 'rev-parse', 'HEAD^{tree}'));
    expect(await tree(dir)).toBe(await tree(dir));
  });

  it('changes with an edit, a staged edit, and an untracked file and its content', async () => {
    const dir = repo();
    const seen = [await tree(dir)];
    writeFileSync(join(dir, 'a.ts'), 'b\n');
    seen.push(await tree(dir));
    writeFileSync(join(dir, 'new.ts'), 'un\n');
    seen.push(await tree(dir));
    writeFileSync(join(dir, 'new.ts'), 'deux\n');
    seen.push(await tree(dir));
    git(dir, 'add', 'new.ts');
    expect(await tree(dir)).toBe(seen[3]);
    expect(new Set(seen).size).toBe(4);
  });

  it('a commit of the same content is the same tree: committing is no progress', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.ts'), 'b\n');
    const before = await tree(dir);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'edit');
    expect(await tree(dir)).toBe(before);
  });

  it('leaves the real index alone: what the agent staged stays as it is', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'new.ts'), 'un\n');
    const index = join(dir, '.git', 'index');
    const [bytes, mtime] = [readFileSync(index), statSync(index).mtimeMs];
    await tree(dir);
    expect(readFileSync(index).equals(bytes)).toBe(true);
    expect(statSync(index).mtimeMs).toBe(mtime);
    expect(git(dir, 'status', '--porcelain')).toBe('?? new.ts');
  });

  it('writes nothing in the repository: its objects stay as they are', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'new.ts'), 'un\n');
    const count = () => git(dir, 'count-objects');
    const before = count();
    await tree(dir);
    expect(count()).toBe(before);
  });

  it('reads a sparse worktree: what it hides is no deletion, a file written where it hides is a change', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-tree-'));
    git(dir, 'init', '-q');
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), '{}\n');
    writeFileSync(join(dir, '.claude', 'CLAUDE.md'), 'c\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    git(dir, 'sparse-checkout', 'set', '--no-cone', '/*', '!/.claude/*', '/.claude/CLAUDE.md');
    const clean = await tree(dir);
    expect(clean).toBe(git(dir, 'rev-parse', 'HEAD^{tree}'));
    writeFileSync(join(dir, '.claude', 'settings.local.json'), 'one\n');
    const made = await tree(dir);
    expect(made).not.toBe(clean);
    writeFileSync(join(dir, '.claude', 'settings.local.json'), 'two\n');
    expect(await tree(dir)).not.toBe(made);
    expect(git(dir, 'ls-files', '-t', '.claude')).toBe('H .claude/CLAUDE.md\nS .claude/settings.json');
  });

  it('fails outside a git worktree: no fingerprint, nothing tracked', async () => {
    const r = await execCmd('sh', ['-c', WORKTREE_TREE], { cwd: mkdtempSync(join(tmpdir(), 'factory-nogit-')), env: { GIT_CEILING_DIRECTORIES: tmpdir() } });
    expect(r.code).not.toBe(0);
  });
});
