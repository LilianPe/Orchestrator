import { describe, expect, it } from 'vitest';
import { coverageOf, diffQualityCheck, qualityArgv, readQuality, worstOfQuality, type DiffQuality } from './diff-quality.js';

const ok = (out: unknown) => ({ code: 0, stdout: JSON.stringify(out), stderr: '' });
const fn = (over: Partial<{ path: string; name: string; start: number; end: number; cc: number; coverage: number | null; crap: number | null }>) => ({
  path: 'src/a.ts', name: 'f', start: 1, end: 10, cc: 2, coverage: null, crap: null, ...over,
});
const pair = (score: number, left: [string, number, number], right: [string, number, number]) => ({
  score, left: { path: left[0], start: left[1], end: left[2] }, right: { path: right[0], start: right[1], end: right[2] },
});
const added = (entries: Record<string, number[]>) => new Map(Object.entries(entries).map(([p, ls]) => [p, new Set(ls)]));

describe('readQuality', () => {
  it('lists a function the diff touches whose CRAP is above 10, and not one under it', () => {
    const q = readQuality(ok({ functions: [fn({ name: 'grade', cc: 9, coverage: 42.9, crap: 24.1 }), fn({ name: 'total', start: 11, end: 20, cc: 3, coverage: 100, crap: 3 })], pairs: [] }), added({ 'src/a.ts': [2, 12] }));
    expect(q.functions.map((f) => f.name)).toEqual(['grade']);
  });

  it('leaves out a function the diff does not touch, however bad', () => {
    const q = readQuality(ok({ functions: [fn({ name: 'old', start: 30, end: 60, cc: 20, coverage: 0, crap: 420 })], pairs: [] }), added({ 'src/a.ts': [2] }));
    expect(q.functions).toEqual([]);
  });

  it('lists a function of unknown coverage by its complexity, above 5', () => {
    const q = readQuality(ok({ functions: [fn({ name: 'big', cc: 6 }), fn({ name: 'small', start: 11, end: 20, cc: 5 })], pairs: [] }), added({ 'src/a.ts': [2, 12] }));
    expect(q.functions.map((f) => f.name)).toEqual(['big']);
  });

  it('sorts the scored functions worst first, then the unknown ones by complexity', () => {
    const q = readQuality(
      ok({ functions: [fn({ name: 'u', cc: 30 }), fn({ name: 'a', cc: 4, coverage: 0, crap: 20 }), fn({ name: 'b', cc: 9, coverage: 0, crap: 90 })], pairs: [] }),
      added({ 'src/a.ts': [2] }),
    );
    expect(q.functions.map((f) => f.name)).toEqual(['b', 'a', 'u']);
  });

  it('lists a pair with one side on a line the diff adds, the closest first', () => {
    const q = readQuality(
      ok({ functions: [], pairs: [pair(0.9, ['lib/c.py', 1, 6], ['pkg/d.py', 1, 6]), pair(1, ['pkg/d.py', 10, 20], ['lib/e.py', 1, 9]), pair(1, ['pkg/d.py', 30, 40], ['lib/f.py', 1, 9])] }),
      added({ 'pkg/d.py': [3, 12] }),
    );
    expect(q.pairs.map((p) => [p.left.path, p.left.start, p.right.path, p.right.start])).toEqual([
      ['pkg/d.py', 10, 'lib/e.py', 1],
      ['lib/c.py', 1, 'pkg/d.py', 1],
    ]);
  });

  it('says it is unavailable when the tools fail or print no readable report, and never throws', () => {
    expect(readQuality({ code: 1, stdout: '', stderr: 'ModuleNotFoundError: No module named crapper' }, added({}))).toMatchObject({ functions: [], pairs: [], unavailable: expect.stringContaining('No module named crapper') });
    expect(readQuality({ code: 0, stdout: 'not json', stderr: '' }, added({}))).toMatchObject({ unavailable: expect.stringContaining('no readable report') });
    expect(readQuality(ok({ functions: 'x' }), added({}))).toMatchObject({ unavailable: expect.stringContaining('no readable report') });
  });
});

describe('qualityArgv', () => {
  it('runs the script with its own interpreter, isolated, under the cap, on the paths after a `--`', () => {
    const argv = qualityArgv({ coverageDir: '/tmp/cov', covered: ['typescript'], files: ['-odd.ts', 'src/a.ts'], timeoutS: 900 });
    expect(argv.slice(0, 4)).toEqual(['timeout', '900', '/opt/quality/crapper/bin/python', '-I']);
    expect(argv).toContain('/usr/local/share/factory/quality/diff_quality.py');
    expect(argv.slice(argv.indexOf('--coverage'), argv.indexOf('--coverage') + 4)).toEqual(['--coverage', '/tmp/cov', '--covered', 'typescript']);
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['-odd.ts', 'src/a.ts']);
  });
});

describe('coverageOf', () => {
  const at = (files: Record<string, string>) => ({ showAtHead: async (p: string) => files[p] });

  it('asks vitest for an LCOV, with the provider the commit installs, and thresholds that cannot fail the run', async () => {
    const c = await coverageOf('vitest', at({ 'package.json': JSON.stringify({ devDependencies: { '@vitest/coverage-istanbul': '^5' } }) }));
    expect(c?.language).toBe('typescript');
    const flags = c!.flags('/tmp/cov/0');
    expect(flags).toContain('--coverage.enabled');
    expect(flags).toContain('--coverage.provider=istanbul');
    expect(flags).toContain('--coverage.reporter=lcov');
    expect(flags).toContain('--coverage.reportsDirectory=/tmp/cov/0');
    expect(flags).toContain('--coverage.thresholds.lines=0');
  });

  it('adds nothing to vitest without a coverage package in the commit', async () => {
    expect(await coverageOf('vitest', at({ 'package.json': JSON.stringify({ devDependencies: { vitest: '^5' } }) }))).toBeUndefined();
    expect(await coverageOf('vitest', at({}))).toBeUndefined();
  });

  it("asks jest for its own coverage, which it carries, its threshold emptied", async () => {
    const flags = (await coverageOf('jest', at({})))!.flags('/tmp/cov/1');
    expect(flags).toContain('--coverage');
    expect(flags).toContain('--coverageReporters=lcov');
    expect(flags).toContain('--coverageDirectory=/tmp/cov/1');
    expect(flags).toContain("--coverageThreshold='{}'");
  });

  it('asks pytest for an LCOV only when pytest-cov is declared in the commit', async () => {
    expect(await coverageOf('pytest', at({ 'pyproject.toml': '[project]\ndependencies = ["pytest"]\n' }))).toBeUndefined();
    const c = await coverageOf('pytest', at({ 'requirements-dev.txt': 'pytest==8.3\npytest-cov==6.0\n' }));
    expect(c?.language).toBe('python');
    expect(c!.flags('/tmp/cov/2')).toContain('--cov-report=lcov:/tmp/cov/2/pytest.lcov');
    expect(c!.flags('/tmp/cov/2')).toContain('--cov-fail-under=0');
  });

  it('adds nothing to a command of no known runner', async () => {
    expect(await coverageOf(undefined, at({}))).toBeUndefined();
  });
});

describe('diffQualityCheck', () => {
  const q = (over: Partial<DiffQuality>): DiffQuality => ({ functions: [], pairs: [], ...over });

  it('is neutral and lists what it found, never a failure', () => {
    const r = diffQualityCheck(q({ functions: [{ path: 'src/a.ts', name: 'grade', start: 1, end: 8, cc: 9, coverage: 42.9, crap: 24.1 }], pairs: [pair(1, ['pkg/d.py', 1, 6], ['lib/c.py', 1, 6])] }));
    expect(r.conclusion).toBe('neutral');
    expect(r.summary).toContain('`src/a.ts:1-8` `grade`: CRAP 24.1 (CC 9, coverage 42.9 %)');
    expect(r.summary).toContain('`pkg/d.py:1-6` and `lib/c.py:1-6`: similarity 1.00');
  });

  it('clips a path or a name past 120 characters: the summary and the PR keep their size', () => {
    const long = `src/${'x'.repeat(300)}.ts`;
    const r = diffQualityCheck(q({ functions: [{ path: long, name: 'n'.repeat(300), start: 1, end: 9, cc: 7, coverage: null, crap: null }] }));
    expect(r.summary).not.toContain('x'.repeat(130));
    expect(r.summary).not.toContain('n'.repeat(130));
    expect(r.summary).toContain('…');
  });

  it('says the coverage is unknown rather than a score', () => {
    expect(diffQualityCheck(q({ functions: [{ path: 'a.py', name: 'g', start: 1, end: 9, cc: 7, coverage: null, crap: null }] })).summary).toContain('`a.py:1-9` `g`: CC 7, coverage unknown');
  });

  it('succeeds when the diff adds nothing to look at', () => {
    expect(diffQualityCheck(q({}))).toMatchObject({ conclusion: 'success', summary: expect.stringContaining('Nothing') });
  });

  it('is neutral when the tools could not run, and says why', () => {
    expect(diffQualityCheck(q({ unavailable: 'crapper and dryer could not run (code 127)' }))).toMatchObject({ conclusion: 'neutral', summary: expect.stringContaining('code 127') });
  });
});

describe('worstOfQuality', () => {
  it('names the worst function and the closest pair', () => {
    const w = worstOfQuality({
      functions: [{ path: 'src/a.ts', name: 'grade', start: 1, end: 8, cc: 9, coverage: 0, crap: 90 }, { path: 'src/a.ts', name: 'other', start: 9, end: 20, cc: 4, coverage: 0, crap: 20 }],
      pairs: [pair(0.9, ['pkg/d.py', 1, 6], ['lib/c.py', 1, 6])],
    });
    expect(w).toEqual(['`src/a.ts:1-8` `grade`: CRAP 90 (CC 9, coverage 0 %)', '`pkg/d.py:1-6` and `lib/c.py:1-6`: similarity 0.90']);
  });

  it('takes two of one kind when the other found nothing', () => {
    expect(worstOfQuality({ functions: [], pairs: [pair(1, ['a.ts', 1, 6], ['b.ts', 1, 6]), pair(0.9, ['a.ts', 9, 16], ['c.ts', 1, 6])] })).toHaveLength(2);
  });
});
