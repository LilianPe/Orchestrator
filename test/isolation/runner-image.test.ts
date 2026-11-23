import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCleanVerify } from '../../src/core/clean-verify.js';
import { cli, enabled, image, useSandboxes } from './helpers.js';

const built = enabled && !!process.env['FACTORY_RUNNER_IMAGE'];

/** docker/runner.Dockerfile (ORC-203): skipped on the public node image the other isolation tests default to. */
describe.skipIf(!built)(`the runner image (${cli})`, () => {
  const inImage = (script: string) => execFileSync(cli, ['run', '--rm', '--network', 'none', image, 'sh', '-c', script], { encoding: 'utf8', timeout: 60_000 }).trim();

  it.each([
    ['node', 'node --version', /^v24\./],
    ['pnpm', 'pnpm --version', /^10\.20\.0$/],
    ['python', 'python3 --version', /^Python 3\./],
    ['uv', 'uv --version', /^uv 0\.13\.7/],
    ['git', 'git --version', /^git version/],
    ['gitleaks', 'gitleaks version', /^v?8\.30\.1/],
    ['semgrep', 'SEMGREP_ENABLE_VERSION_CHECK=0 semgrep --version', /^1\.182\.1$/],
    ['claude', 'claude --version', /^2\.1\.316/],
  ])('has %s', (_name, command, expected) => {
    expect(inImage(command)).toMatch(expected);
  });

  it('has neither gh nor an engine CLI, nor any daemon code', () => {
    // One name at a time: dash's `command -v` looks at its first operand only.
    expect(inImage('for c in gh docker podman; do command -v "$c"; done; echo end')).toBe('end');
    expect(inImage('ls /app 2>/dev/null || echo none')).toBe('none');
  });
});

/** ORC-333, criterion 2: the image's Semgrep and the factory's rules, in `verify`, through what the branch writes to silence them. */
describe.skipIf(!built)(`semgrep in verify on the runner image (${cli})`, () => {
  const { provider } = useSandboxes('verify-semgrep');
  const base = mkdtempSync(join(tmpdir(), 'factory-semgrep-'));
  const BRANCH = 'factory/iso-3';
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const commit = (cwd: string, files: Record<string, string>, message: string) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-q', '-m', message);
  };
  let origin: string;
  let repo: string;

  const check = async (name: string) => {
    const workDir = join(base, name);
    mkdirSync(workDir);
    return runCleanVerify({
      sandboxes: provider, runId: `isolation-verify-semgrep-${name}-${Date.now()}`, ticketId: 'ISO-3', branch: BRANCH, worktree: repo, originUrl: origin, workDir,
      gitleaks: false, semgrep: true, setup: [], commands: [], env: async () => ({}), log: () => {},
    });
  };

  beforeAll(() => {
    origin = join(base, 'origin');
    git(base, 'init', '-q', '-b', 'main', origin);
    for (const c of [['user.email', 't@t'], ['user.name', 't']] as const) git(origin, 'config', ...c);
    // A finding on a line the branch does not write stays the base's.
    commit(origin, { 'src/old.js': 'eval(legacy);\n' }, 'base');
    repo = join(base, 'repo');
    git(base, 'clone', '-q', origin, repo);
    for (const c of [['user.email', 't@t'], ['user.name', 't']] as const) git(repo, 'config', ...c);
    git(repo, 'checkout', '-q', '-b', BRANCH);
    commit(repo, { 'src/old.js': 'eval(legacy);\nexport const a = 1;\n' }, 'clean');
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('passes a branch that breaks no rule: the witness that it scans comes next', async () => {
    expect(await check('clean')).toMatchObject({ ok: true, failures: [] });
  }, 300_000);

  it('blocks eval on an added line, through a nosemgrep comment and a .semgrepignore', async () => {
    commit(repo, { 'src/run.js': 'export const run = (input) => eval(input); // nosemgrep\n', '.semgrepignore': 'src/\n' }, 'eval, silenced');
    const res = await check('eval');
    expect(res.ok).toBe(false);
    expect(res.failures).toEqual([{ command: 'factory/semgrep', exitCode: 1, output: expect.stringMatching(/`src\/run\.js`:1 \([\w.]*js-eval\)/) }]);
    expect(res.failures[0]!.output).not.toContain('old.js');
  }, 300_000);
});

/** ORC-280, criteria 1 to 3: the image's crapper and dryer in `verify`, without network, on a TypeScript and a Python repository. */
describe.skipIf(!built)(`factory/qualité-diff in verify on the runner image (${cli})`, () => {
  const { provider } = useSandboxes('verify-quality');
  const base = mkdtempSync(join(tmpdir(), 'factory-quality-'));
  const BRANCH = 'factory/iso-280';
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const commit = (cwd: string, files: Record<string, string>, message: string) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-q', '-m', message);
  };

  /** A repository whose base holds `old`, and a branch that adds `added`: `verify` with the measure, one command that passes. */
  const measure = async (name: string, old: Record<string, string>, added: Record<string, string>, commands = ['true']) => {
    const origin = join(base, name, 'origin');
    mkdirSync(origin, { recursive: true });
    git(origin, 'init', '-q', '-b', 'main');
    for (const c of [['user.email', 't@t'], ['user.name', 't']] as const) git(origin, 'config', ...c);
    commit(origin, old, 'base');
    const repo = join(base, name, 'repo');
    git(base, 'clone', '-q', origin, repo);
    for (const c of [['user.email', 't@t'], ['user.name', 't']] as const) git(repo, 'config', ...c);
    git(repo, 'checkout', '-q', '-b', BRANCH);
    commit(repo, added, 'work');
    const workDir = join(base, name, 'work');
    mkdirSync(workDir);
    return runCleanVerify({
      sandboxes: provider, runId: `isolation-verify-quality-${name}-${Date.now()}`, ticketId: 'ISO-280', branch: BRANCH, worktree: repo, originUrl: origin, workDir,
      gitleaks: false, semgrep: false, quality: true, setup: [], commands, env: async () => ({}), log: () => {},
    });
  };

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('lists, on a TypeScript repository, the complex function the branch adds and the function it copies', async () => {
    const total = (name: string) => `export function ${name}(items: number[]): number {\n  let sum = 0;\n  for (const it of items) {\n    if (it > 0) {\n      sum += it * 2;\n    }\n  }\n  return sum;\n}\n`;
    const grade = 'export function grade(n: number, b?: number): string {\n  const s = n + (b ?? 0);\n  if (s > 90 && n > 0) return "A";\n  else if (s > 80) return "B";\n  else if (s > 70 || n < 0) return "C";\n  for (let i = 0; i < 3; i++) { if (i === s) return "D"; }\n  return "F";\n}\n';
    const res = await measure('ts', { 'src/old.ts': total('total') }, { 'src/new.ts': `${grade}${total('amount')}` });
    expect(res).toMatchObject({ ok: true, failures: [] });
    expect(res.quality?.unavailable).toBeUndefined();
    expect(res.quality!.functions).toEqual([expect.objectContaining({ path: 'src/new.ts', name: 'grade', cc: 9, coverage: null })]);
    expect(res.quality!.pairs).toEqual([expect.objectContaining({ score: 1, left: expect.objectContaining({ path: 'src/new.ts' }), right: expect.objectContaining({ path: 'src/old.ts' }) })]);
  }, 300_000);

  it('criterion 1 with a coverage: the LCOV the tests write where the factory asks is read, and the CRAP computed from it', async () => {
    // The repository's own pytest, which the factory runs as pytest: it writes the LCOV at the path `--cov-report=lcov:` names.
    const pytest = '#!/bin/sh\nfor a in "$@"; do case "$a" in --cov-report=lcov:*) out="${a#--cov-report=lcov:}";; esac; done\n[ -n "$out" ] || exit 9\nmkdir -p "$(dirname "$out")"\nprintf "SF:app/grade.py\\nDA:1,1\\nDA:2,1\\nDA:3,1\\nDA:4,0\\nDA:5,0\\nDA:6,0\\nDA:7,0\\nDA:8,0\\nend_of_record\\n" > "$out"\n';
    const grade = 'def grade(n, b=None):\n    s = n + (b or 0)\n    if s > 90 and n > 0:\n        return "A"\n    elif s > 80 or n < 0:\n        return "B"\n    return "F"\n\n\ndef unreported(n):\n    if n > 1 and n < 9:\n        return 1\n    elif n > 20 or n < -3:\n        return 2\n    return 3\n';
    const res = await measure('cov', { 'requirements.txt': 'pytest-cov==6.0\n', 'bin/pytest': pytest }, { 'app/grade.py': grade }, ['sh bin/pytest']);
    expect(res).toMatchObject({ ok: true, failures: [] });
    expect(res.quality?.unavailable).toBeUndefined();
    const graded = res.quality!.functions.find((f) => f.name === 'grade')!;
    expect(graded.coverage).toBeGreaterThan(0);
    expect(graded.coverage).toBeLessThan(100);
    expect(graded.crap).toBeGreaterThan(10);
  }, 300_000);

  it('merges the reports of two commands, gives no file the coverage of another it shares a suffix with, and is not stopped by a language without a grammar', async () => {
    // Two pytest commands, each covering half of grade (lines 1-4, then 5-8, of 12): merged, 8 of 12. Only the first names
    // lib/util.py, whose path ends as src/util.py's does once its `src/` is cut: src/util.py, which no report names, stays unknown.
    const pytest = [
      '#!/bin/sh',
      'for a in "$@"; do case "$a" in --cov-report=lcov:*) out="${a#--cov-report=lcov:}";; esac; done',
      '[ -n "$out" ] || exit 9',
      'mkdir -p "$(dirname "$out")"',
      'case "$1" in one) from=1; to=4;; *) from=5; to=8;; esac',
      '{ echo SF:app/grade.py; i=1; while [ $i -le 12 ]; do if [ $i -ge $from ] && [ $i -le $to ]; then echo "DA:$i,1"; else echo "DA:$i,0"; fi; i=$((i+1)); done; echo end_of_record',
      '  if [ "$1" = one ]; then echo SF:lib/util.py; i=1; while [ $i -le 8 ]; do echo "DA:$i,1"; i=$((i+1)); done; echo end_of_record; fi; } > "$out"',
      '',
    ].join('\n');
    const grade = 'def grade(n, b=None):\n    s = n + (b or 0)\n    if s > 90 and n > 0:\n        return "A"\n    elif s > 80:\n        return "B"\n    elif s > 70 or n < 0:\n        return "C"\n    for i in range(3):\n        if i == s:\n            return "D"\n    return "F"\n';
    const route = 'def route(n):\n    if n > 1 and n < 9:\n        return 1\n    elif n > 20 or n < -3:\n        return 2\n    elif n == 15:\n        return 3\n    return 4\n';
    // A Go file: the image carries no grammar for it, and tree-sitter would fetch one through the network the sandbox lacks.
    const old = { 'requirements.txt': 'pytest-cov==6.0\n', 'bin/pytest': pytest, 'lib/util.py': route, 'tools/gen.go': 'package main\n\nfunc main() {\n}\n' };
    const res = await measure('merge', old, { 'app/grade.py': grade, 'src/util.py': route }, ['sh bin/pytest one', 'sh bin/pytest two']);
    expect(res).toMatchObject({ ok: true, failures: [] });
    expect(res.quality?.unavailable).toBeUndefined();
    expect(res.quality!.functions).toEqual([
      expect.objectContaining({ path: 'app/grade.py', name: 'grade', cc: 9, coverage: 66.7 }),
      expect.objectContaining({ path: 'src/util.py', name: 'route', coverage: null, crap: null }),
    ]);
  }, 300_000);

  it('lists the same on a Python repository', async () => {
    const total = (name: string) => `def ${name}(items):\n    out = 0\n    for it in items:\n        if it > 0:\n            out += it * 2\n    return out\n`;
    const grade = 'def grade(n, b=None):\n    s = n + (b or 0)\n    if s > 90 and n > 0:\n        return "A"\n    elif s > 80:\n        return "B"\n    elif s > 70 or n < 0:\n        return "C"\n    for i in range(3):\n        if i == s:\n            return "D"\n    return "F"\n';
    const res = await measure('py', { 'app/old.py': total('total') }, { 'app/new.py': `${grade}\n\n${total('amount')}` });
    expect(res.quality?.unavailable).toBeUndefined();
    expect(res.quality!.functions).toEqual([expect.objectContaining({ path: 'app/new.py', name: 'grade', coverage: null })]);
    expect(res.quality!.pairs).toEqual([expect.objectContaining({ left: expect.objectContaining({ path: 'app/new.py' }), right: expect.objectContaining({ path: 'app/old.py' }) })]);
  }, 300_000);
});
