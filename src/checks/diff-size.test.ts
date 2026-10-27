import { describe, expect, it } from 'vitest';
import { DIFF_SIZE_CHECK, MAX_DIFF, MaxDiffConfigError, diffSizeCheck, measureDiff, resolveMaxDiff } from './diff-size.js';

// A new file of `lines` added lines.
function addedFile(path: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `+line ${i}`);
  return [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${lines} @@`, ...body, ''].join('\n');
}

// A modified file: `added` lines added, `removed` lines removed.
function modifiedFile(path: string, added: number, removed: number): string {
  const hunk = [...Array.from({ length: removed }, (_, i) => `-old ${i}`), ...Array.from({ length: added }, (_, i) => `+new ${i}`)];
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,${removed + 1} +1,${added + 1} @@`, ' context', ...hunk, ''].join('\n');
}

function deletedFile(path: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `-line ${i}`);
  return [`diff --git a/${path} b/${path}`, 'deleted file mode 100644', `--- a/${path}`, '+++ /dev/null', `@@ -1,${lines} +0,0 @@`, ...body, ''].join('\n');
}

function renamedFile(from: string, to: string, added = 0): string {
  const head = [`diff --git a/${from} b/${to}`, `similarity index ${added === 0 ? 100 : 90}%`, `rename from ${from}`, `rename to ${to}`];
  if (added === 0) return [...head, ''].join('\n');
  const body = Array.from({ length: added }, (_, i) => `+new ${i}`);
  return [...head, `--- a/${from}`, `+++ b/${to}`, `@@ -1,1 +1,${added + 1} @@`, ' context', ...body, ''].join('\n');
}

function binaryFile(path: string): string {
  return [`diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..1234567', `Binary files /dev/null and b/${path} differ`, ''].join('\n');
}

const files = (n: number, lines = 1, dir = 'src'): string => Array.from({ length: n }, (_, i) => addedFile(`${dir}/f${i}.ts`, lines)).join('');

describe('diffSizeCheck', () => {
  it('passes a diff at the base thresholds (15 files, 400 lines outside tests)', () => {
    const diff = files(14, 20) + addedFile('src/last.ts', 400 - 14 * 20);
    const result = diffSizeCheck(diff);
    expect(result).toMatchObject({ check: DIFF_SIZE_CHECK, ok: true, size: { files: 15, lines: 400 }, limits: MAX_DIFF });
    expect(result.summary).toContain('15 fichier(s), 400 ligne(s) hors tests');
  });

  it('blocks 16 files outside tests and proposes a split or asks a question', () => {
    const result = diffSizeCheck(files(16));
    expect(result.ok).toBe(false);
    expect(result.size).toEqual({ files: 16, lines: 16 });
    expect(result.summary).toContain('16 fichiers hors tests, au-delà de 15');
    expect(result.summary).toMatch(/découp/);
    expect(result.summary).toMatch(/\?/);
  });

  it('blocks 401 lines outside tests', () => {
    const result = diffSizeCheck(addedFile('src/a.ts', 200) + modifiedFile('src/b.ts', 100, 101));
    expect(result.ok).toBe(false);
    expect(result.size).toEqual({ files: 2, lines: 401 });
    expect(result.summary).toContain('401 lignes hors tests, au-delà de 400');
  });

  it('does not count tests: 600 lines of tests and a small change pass', () => {
    const tests = addedFile('src/score.test.ts', 300) + addedFile('tests/test_score.py', 200) + addedFile('test/helpers/fixture.ts', 100);
    const result = diffSizeCheck(tests + modifiedFile('src/score.ts', 10, 2));
    expect(result.ok).toBe(true);
    expect(result.size).toEqual({ files: 1, lines: 12 });
    expect(result.summary).toContain('3 fichier(s) de test non compté(s)');
  });

  it('does not count test files towards the file bound either', () => {
    expect(diffSizeCheck(files(30, 1, 'test') + files(15)).ok).toBe(true);
  });

  it('applies a threshold the repository tightens', () => {
    const diff = files(6, 10);
    expect(diffSizeCheck(diff).ok).toBe(true);
    const tightFiles = diffSizeCheck(diff, { maxDiff: { files: 5 } });
    expect(tightFiles).toMatchObject({ ok: false, limits: { files: 5, lines: 400 } });
    expect(tightFiles.summary).toContain('6 fichiers hors tests, au-delà de 5');
    const tightLines = diffSizeCheck(diff, { maxDiff: { lines: 50 } });
    expect(tightLines).toMatchObject({ ok: false, limits: { files: 15, lines: 50 } });
    expect(tightLines.summary).toContain('60 lignes hors tests, au-delà de 50');
  });

  it('refuses a configuration that loosens the base thresholds, and blocks', () => {
    const result = diffSizeCheck(files(1), { maxDiff: { files: 30, lines: 1000 } });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('ne peut que resserrer');
    expect(result.summary).toContain('files');
  });

  it('counts a deleted file and its removed lines', () => {
    expect(diffSizeCheck(deletedFile('src/old.ts', 401)).size).toEqual({ files: 1, lines: 401 });
  });

  it('counts a pure rename as one file with no line, and a rename with edits by its lines', () => {
    expect(measureDiff(renamedFile('src/a.ts', 'src/b.ts')).size).toEqual({ files: 1, lines: 0 });
    expect(measureDiff(renamedFile('src/a.ts', 'src/b.ts', 7)).size).toEqual({ files: 1, lines: 7 });
  });

  it('counts a file moved out of the tests, or into them: one side is code', () => {
    expect(measureDiff(renamedFile('test/helper.ts', 'src/helper.ts', 3)).size).toEqual({ files: 1, lines: 3 });
    expect(measureDiff(renamedFile('src/helper.ts', 'test/helper.ts', 3)).size).toEqual({ files: 1, lines: 3 });
    expect(measureDiff(renamedFile('test/a.ts', 'tests/a.ts', 3)).size).toEqual({ files: 0, lines: 0 });
  });

  it('counts a binary file as one file with no line', () => {
    expect(measureDiff(binaryFile('assets/logo.png')).size).toEqual({ files: 1, lines: 0 });
  });

  it('leaves lockfiles out, wherever they are, and lists them', () => {
    const locks = ['package-lock.json', 'web/pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'npm-shrinkwrap.json', 'bun.lock'];
    const diff = locks.map((p) => addedFile(p, 2000)).join('') + modifiedFile('package.json', 1, 0);
    const result = diffSizeCheck(diff);
    expect(result.ok).toBe(true);
    expect(result.size).toEqual({ files: 1, lines: 1 });
    expect(result.summary).toContain(`${locks.length} fichier(s) de verrouillage non compté(s)`);
  });

  it('counts a file only named like a lockfile', () => {
    expect(measureDiff(addedFile('src/package-lock.json.ts', 3)).size).toEqual({ files: 1, lines: 3 });
  });

  it('counts the test runner configuration: it is not a test', () => {
    expect(measureDiff(modifiedFile('vitest.config.ts', 2, 1)).size).toEqual({ files: 1, lines: 3 });
  });

  it('passes an empty diff', () => {
    expect(diffSizeCheck('')).toMatchObject({ ok: true, size: { files: 0, lines: 0 } });
  });

  it('names the biggest files outside tests when it blocks', () => {
    const result = diffSizeCheck(addedFile('src/big.ts', 380) + addedFile('src/small.ts', 30));
    expect(result.summary.indexOf('src/big.ts')).toBeGreaterThan(-1);
    expect(result.summary.indexOf('src/big.ts')).toBeLessThan(result.summary.indexOf('src/small.ts'));
  });
});

describe('resolveMaxDiff', () => {
  it('keeps the base thresholds without configuration', () => {
    expect(resolveMaxDiff()).toEqual({ files: 15, lines: 400 });
    expect(resolveMaxDiff({})).toEqual({ files: 15, lines: 400 });
  });

  it('takes each tightened bound, the other keeps its base value', () => {
    expect(resolveMaxDiff({ files: 10 })).toEqual({ files: 10, lines: 400 });
    expect(resolveMaxDiff({ lines: 200 })).toEqual({ files: 15, lines: 200 });
    expect(resolveMaxDiff({ files: 15, lines: 400 })).toEqual({ files: 15, lines: 400 });
  });

  it('refuses to loosen a bound', () => {
    expect(() => resolveMaxDiff({ files: 16 })).toThrow(MaxDiffConfigError);
    expect(() => resolveMaxDiff({ lines: 401 })).toThrow(/max_diff\.lines = 401 .* 400 .* ne peut que resserrer/);
  });

  it('refuses a bound that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveMaxDiff({ files: bad })).toThrow(MaxDiffConfigError);
    }
    expect(() => resolveMaxDiff({ lines: '100' as unknown as number })).toThrow(MaxDiffConfigError);
  });
});
