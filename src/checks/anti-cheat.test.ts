import { describe, expect, it } from 'vitest';
import { ANTI_CHEAT_CHECK, antiCheatCheck, justifiedRemovals, scanDiff } from './anti-cheat.js';

// One modified file, its hunk given as diff lines (' ' context, '+' added, '-' removed), starting at line 10.
function fileDiff(path: string, ...hunk: string[]): string {
  const old = hunk.filter((l) => !l.startsWith('+')).length;
  const neu = hunk.filter((l) => !l.startsWith('-')).length;
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -10,${old} +10,${neu} @@`, ...hunk, ''].join('\n');
}

const added = (path: string, line: string): string => fileDiff(path, ' before', `+${line}`);

describe('scanDiff', () => {
  const blocked: [string, string, string, string][] = [
    // form, file, added line, expected match
    ['disabled-test', 'src/a.test.ts', "  it.skip('rounds the score', () => {", 'it.skip'],
    ['disabled-test', 'src/a.test.ts', "describe.only('scores', () => {", 'describe.only'],
    ['disabled-test', 'src/a.test.ts', "  it.todo('rounds the score');", 'it.todo'],
    ['disabled-test', 'src/a.test.ts', "  test.skipIf(process.platform === 'win32')('paths', () => {", 'test.skipIf'],
    ['disabled-test', 'src/a.spec.js', "  xit('rounds', () => {", 'xit'],
    ['disabled-test', 'src/a.spec.js', "xdescribe('scores', () => {", 'xdescribe'],
    ['disabled-test', 'src/a.spec.js', "  fit('rounds', () => {", 'fit'],
    ['disabled-test', 'tests/test_scores.py', '@pytest.mark.skip(reason="flaky")', 'pytest.mark.skip'],
    ['disabled-test', 'tests/test_scores.py', '@pytest.mark.xfail', 'pytest.mark.xfail'],
    ['disabled-test', 'tests/test_scores.py', '    pytest.skip("later")', 'pytest.skip('],
    ['disabled-test', 'tests/test_scores.py', '@unittest.skip("later")', 'unittest.skip'],
    ['bypass', 'src/score.ts', '  // @ts-ignore', '@ts-ignore'],
    ['bypass', 'src/score.ts', '// @ts-nocheck', '@ts-nocheck'],
    ['bypass', 'src/score.ts', '  // @ts-expect-error wrong type', '@ts-expect-error'],
    ['bypass', 'src/score.ts', '/* eslint-disable */', 'eslint-disable'],
    ['bypass', 'src/score.ts', '  const x = y as any; // eslint-disable-line', 'eslint-disable'],
    ['bypass', 'package.json', '    "commit": "git commit --no-verify",', '--no-verify'],
    ['bypass', 'scripts/release.sh', 'git push --no-verify origin HEAD', '--no-verify'],
    ['bypass', 'app/scores.py', 'total = compute(x)  # type: ignore[arg-type]', '# type: ignore'],
    ['bypass', 'app/scores.py', 'total = compute(x)  # pyright: ignore', '# pyright: ignore'],
    ['bypass', 'app/scores.py', 'import os, sys  # noqa: E401', '# noqa'],
    // The file-level directives of ruff, flake8 and mypy (ORC-311), the Python `eslint-disable` and `@ts-nocheck`.
    ['bypass', 'app/scores.py', '# ruff: noqa', '# ruff: noqa'],
    ['bypass', 'app/scores.py', '# flake8: noqa: E501', '# flake8: noqa'],
    ['bypass', 'app/scores.py', '# mypy: ignore-errors', '# mypy: ignore-errors'],
    ['bypass', 'app/scores.py', '# mypy: strict, ignore_errors', '# mypy: strict, ignore_errors'],
    ['bypass', 'app/scores.py', '# mypy: disable-error-code="arg-type"', '# mypy: disable-error-code'],
    ['bypass', 'app/scores.py', '# pyright: basic', '# pyright: basic'],
    ['bypass', 'app/scores.py', '# pyright: reportGeneralTypeIssues=false', '# pyright: reportGeneralTypeIssues=false'],
    ['bypass', 'src/a.test.ts', '    expect(true).toBe(true);', 'expect(true)'],
    ['bypass', 'src/a.test.ts', "    expect('ok').toEqual('ok');", "expect('ok')"],
    ['bypass', 'src/a.test.ts', '    assert.ok(true);', 'assert.ok(true)'],
    ['bypass', 'tests/test_scores.py', '    assert True', 'assert True'],
    ['bypass', 'tests/test_scores.py', '    self.assertTrue(True)', 'self.assertTrue(True)'],
    ['bypass', 'src/cli.ts', '  process.exit(0);', 'process.exit(0)'],
    ['bypass', 'tests/conftest.py', 'sys.exit(0)', 'sys.exit(0)'],
    ['bypass', 'app/main.py', '    exit(0)', 'exit(0)'],
    ['test-only-behaviour', 'src/score.ts', "  if (process.env.NODE_ENV === 'test') return 42;", "process.env.NODE_ENV === 'test'"],
    ['test-only-behaviour', 'src/score.ts', "  if ('test' == process.env['NODE_ENV']) return 42;", "'test' == process.env['NODE_ENV']"],
    ['test-only-behaviour', 'src/score.ts', '  if (process.env.VITEST) return 42;', 'VITEST'],
    ['test-only-behaviour', 'src/score.ts', "  const under = process.env['JEST_WORKER_ID'] !== undefined;", 'JEST_WORKER_ID'],
    ['test-only-behaviour', 'app/scores.py', '    if os.environ.get("PYTEST_CURRENT_TEST"):', 'PYTEST_CURRENT_TEST'],
    ['test-only-behaviour', 'app/scores.py', "    if 'pytest' in sys.modules:", "'pytest' in sys.modules"],
  ];

  it.each(blocked)('blocks %s in %s: %s', (form, file, line, match) => {
    expect(scanDiff(added(file, line))).toEqual([{ file, line: 11, form, match }]);
  });

  it('passes a clean diff', () => {
    const diff = [
      fileDiff('src/score.ts', ' export function score(x: number) {', '-  return x;', '+  return Math.round(x * 100) / 100;', ' }'),
      fileDiff('src/score.test.ts', " it('rounds', () => {", '+  expect(score(1.234)).toBe(1.23);', ' });'),
      fileDiff('app/scores.py', ' def score(x):', '+    return round(x, 2)'),
      fileDiff('tests/test_scores.py', '+def test_rounds():', '+    assert score(1.234) == 1.23'),
    ].join('');
    expect(scanDiff(diff)).toEqual([]);
  });

  it('never flags a removed line', () => {
    const diff = fileDiff(
      'src/a.test.ts',
      " it.skip('rounds', () => {",
      "-  it.skip('rounds', () => {",
      '-  // @ts-ignore',
      '-  expect(true).toBe(true);',
      "-  if (process.env.NODE_ENV === 'test') process.exit(0);",
      "+  it('rounds', () => {",
    );
    expect(scanDiff(diff)).toEqual([]);
  });

  it('does not flag test detection inside test files or the runner configuration', () => {
    const lines = ["if (process.env.NODE_ENV === 'test') setup();", 'const pool = process.env.VITEST_POOL_ID;', "if (process.env['JEST_WORKER_ID']) {}"];
    const py = ['if os.environ.get("PYTEST_CURRENT_TEST"):', "if 'pytest' in sys.modules:"];
    const diff = [
      ...['src/a.test.ts', 'test/helpers/harness.ts', 'src/__tests__/b.ts', 'vitest.config.ts', 'jest.setup.js'].flatMap((f) => lines.map((l) => added(f, l))),
      ...['tests/test_scores.py', 'pkg/scores_test.py', 'conftest.py'].flatMap((f) => py.map((l) => added(f, l))),
    ].join('');
    expect(scanDiff(diff)).toEqual([]);
  });

  it('only flags fit and fdescribe in test files', () => {
    expect(scanDiff(added('src/layout.ts', 'const box = fit(image, frame);'))).toEqual([]);
    expect(scanDiff(added('src/model.ts', 'model.fit(data);'))).toEqual([]);
  });

  it('ignores lookalikes: other methods, other exit codes, documentation', () => {
    const diff = [
      added('src/a.ts', 'parser.skip(3);'),
      added('src/a.ts', 'const ok = /x/.test(s);'),
      added('src/a.ts', 'process.exit(1);'),
      added('src/a.ts', 'session.exit();'),
      added('src/a.ts', "expect(score(1)).toBe('1');"),
      added('src/a.ts', '// @ts-check'),
      added('src/a.ts', "const env = process.env.NODE_ENV ?? 'production';"),
      added('app/a.py', 'assert total == 3'),
      added('app/a.py', 'sys.exit(main())'),
      added('docs/tests.md', "N'ajoutez jamais `it.skip`, `@ts-ignore`, `--no-verify` ni `process.exit(0)`."),
    ].join('');
    expect(scanDiff(diff)).toEqual([]);
  });

  it('leaves skip-like calls alone outside test files', () => {
    const diff = [added('src/parse.ts', 'this.skip(1);'), added('src/parse.ts', "t.skip('x');"), added('src/ui.tsx', 'const v = context.only;')].join('');
    expect(scanDiff(diff)).toEqual([]);
  });

  it('reads code, not the strings, regex literals and comments that quote a pattern', () => {
    const quotes = [
      "const fixture = \"  it.skip('rounds', () => {\";",
      "const rule = { pattern: /--no-verify\\b/, other: /@ts-ignore|process\\.exit\\(0\\)/ };",
      '// Never add it.skip, process.exit(0) or a --no-verify here; expect(true) proves nothing.',
      '/* the scanner reads VITEST and NODE_ENV === "test" */',
      ' * it.skip and @ts-ignore are findings, the doc comment says.',
      "const s = '// @ts-ignore' + '/* eslint-disable */';",
      'const half = total / 2 / count; it(`works ${half}`, () => {});',
    ];
    const diff = [
      ...quotes.map((l) => added('src/a.test.ts', l)),
      ...quotes.slice(1).map((l) => added('src/scanner.ts', l)),
      added('app/a.py', 'msg = "pytest.skip( and # noqa are findings"  # see it.skip'),
      added('app/a.py', "rule = r'#\\s*type:\\s*ignore'"),
    ].join('');
    expect(scanDiff(diff)).toEqual([]);
  });

  it('still reads the directives in comments and the commands in strings', () => {
    const diff = [
      added('src/a.ts', "const run = () => execSync('git commit --no-verify -m x');"),
      added('src/a.ts', 'const x = f(); /* @ts-ignore */'),
      added('src/a.ts', ' * @ts-expect-error'),
      added('src/a.ts', "if (process.env['VITEST']) return 1;"),
      added('src/a.test.ts', "expect('ok').toBe('ok');"),
      added('src/a.test.ts', 'expect(`${x}`).toBe(y);'),
      added('app/a.py', 'x = f()  # type: ignore'),
    ].join('');
    expect(scanDiff(diff).map((f) => [f.file, f.form, f.match])).toEqual([
      ['src/a.ts', 'bypass', '--no-verify'],
      ['src/a.ts', 'bypass', '@ts-ignore'],
      ['src/a.ts', 'bypass', '@ts-expect-error'],
      ['src/a.ts', 'test-only-behaviour', 'VITEST'],
      ['src/a.test.ts', 'bypass', "expect('ok')"],
      ['app/a.py', 'bypass', '# type: ignore'],
    ]);
  });

  it('lets test files run --no-verify on throwaway repositories', () => {
    expect(scanDiff(added('test/helpers/repo.ts', "git(['commit', '--no-verify', '-m', 'seed']);"))).toEqual([]);
  });

  it('reads a Claude permission rule in a settings file as a rule, not a command', () => {
    const rules = ['      "Bash(git commit --no-verify:*)",', '      "Bash(*--no-verify*)"'];
    const diff = [...rules.map((l) => added('.claude/settings.json', l)), ...rules.map((l) => added('packs/standard/settings.local.json', l))].join('');
    expect(scanDiff(diff)).toEqual([]);
    expect(scanDiff(added('.claude/settings.json', '  "hooks": { "PreToolUse": "git commit --no-verify" },'))).toHaveLength(1);
  });

  it('blocks tests left out by the runner configuration', () => {
    const diff = [
      added('jest.config.js', "  testPathIgnorePatterns: ['/scores/'],"),
      added('package.json', '    "test": "pytest --deselect tests/test_scores.py::test_rounds",'),
      added('pytest.ini', 'addopts = --deselect tests/test_scores.py::test_rounds'),
    ].join('');
    expect(scanDiff(diff).map((f) => [f.file, f.form, f.match])).toEqual([
      ['jest.config.js', 'disabled-test', 'testPathIgnorePatterns'],
      ['package.json', 'disabled-test', '--deselect'],
      ['pytest.ini', 'disabled-test', '--deselect'],
    ]);
  });

  it('reports every finding of a line, at its line in the new file, in the order of the line', () => {
    const diff = fileDiff('src/a.test.ts', ' a', '-b', '+c', ' d', "+it.skip('x', () => expect(1).toBe(1)); // eslint-disable-line");
    expect(scanDiff(diff)).toEqual([
      { file: 'src/a.test.ts', line: 13, form: 'disabled-test', match: 'it.skip' },
      { file: 'src/a.test.ts', line: 13, form: 'bypass', match: 'expect(1)' },
      { file: 'src/a.test.ts', line: 13, form: 'bypass', match: 'eslint-disable' },
    ]);
  });

  describe('frozen acceptance tests', () => {
    const frozenTests = ['test/acceptance/scores.test.ts', 'tests/test_scores.py'];

    it('blocks any change to a frozen test, even an honest-looking one', () => {
      const diff = fileDiff('test/acceptance/scores.test.ts', " it('rounds', () => {", '-  expect(score(1.234)).toBe(1.23);', '+  expect(score(1.234)).toBe(1.2);');
      expect(scanDiff(diff, { frozenTests })).toEqual([{ file: 'test/acceptance/scores.test.ts', line: 11, form: 'frozen-test', match: 'changed' }]);
      expect(scanDiff(diff)).toEqual([]);
    });

    it('blocks a frozen test deleted or renamed, and keeps scanning its added lines', () => {
      const diff = [
        ['diff --git a/tests/test_scores.py b/tests/test_scores.py', 'deleted file mode 100644', '--- a/tests/test_scores.py', '+++ /dev/null', '@@ -1 +0,0 @@', '-def test_rounds(): ...', ''].join('\n'),
        ['diff --git a/test/acceptance/scores.test.ts b/test/old/scores.test.ts', 'similarity index 90%', 'rename from test/acceptance/scores.test.ts', 'rename to test/old/scores.test.ts', '@@ -1,1 +1,2 @@', ' a', "+it.skip('x', () => {});", ''].join('\n'),
      ].join('');
      expect(scanDiff(diff, { frozenTests })).toEqual([
        { file: 'tests/test_scores.py', form: 'frozen-test', match: 'deleted' },
        { file: 'test/acceptance/scores.test.ts', form: 'frozen-test', match: 'renamed to test/old/scores.test.ts' },
        { file: 'test/old/scores.test.ts', line: 2, form: 'disabled-test', match: 'it.skip' },
      ]);
    });

    it('leaves a frozen test alone when it is only the source of a copy', () => {
      const diff = ['diff --git a/tests/test_scores.py b/tests/test_copy.py', 'similarity index 100%', 'copy from tests/test_scores.py', 'copy to tests/test_copy.py', ''].join('\n');
      expect(scanDiff(diff, { frozenTests })).toEqual([]);
    });

    it('leaves files outside the frozen set alone', () => {
      expect(scanDiff(fileDiff('test/unit/other.test.ts', ' a', "+it('b', () => expect(f()).toBe(2));"), { frozenTests })).toEqual([]);
    });

    it('accepts Windows-style frozen paths', () => {
      const diff = fileDiff('tests/test_scores.py', ' a', '+b');
      expect(scanDiff(diff, { frozenTests: ['tests\\test_scores.py'] })).toHaveLength(1);
    });
  });
});

/** A whole file as git prints it with full context: ' ' kept, '+' added, '-' removed. */
function wholeFile(path: string, ...lines: string[]): string {
  const old = lines.filter((l) => !l.startsWith('+')).length;
  const neu = lines.filter((l) => !l.startsWith('-')).length;
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,${old} +1,${neu} @@`, ...lines, ''].join('\n');
}

function deletedFile(path: string, ...lines: string[]): string {
  return [`diff --git a/${path} b/${path}`, 'deleted file mode 100644', `--- a/${path}`, '+++ /dev/null', `@@ -1,${lines.length} +0,0 @@`, ...lines.map((l) => `-${l}`), ''].join('\n');
}

describe('removed and renamed tests (ORC-342)', () => {
  const SUITE = [" import { describe, expect, it } from 'vitest';", " describe('scores', () => {"];

  it('blocks a test case removed from a test file', () => {
    const diff = wholeFile('src/a.test.ts', ...SUITE, "-  it('rounds', () => expect(score(1.234)).toBe(1.23));", "   it('floors', () => expect(floor(1.9)).toBe(1));", ' });');
    expect(scanDiff(diff)).toEqual([{ file: 'src/a.test.ts', form: 'removed-test', match: 'scores > rounds' }]);
  });

  it('blocks a test case renamed, or moved under another describe', () => {
    const renamed = wholeFile('src/a.test.ts', ...SUITE, "-  it('rounds', () => expect(score(1.234)).toBe(1.23));", "+  it('rounds up', () => expect(score(1.234)).toBe(1.23));", ' });');
    expect(scanDiff(renamed).map((f) => [f.form, f.match])).toEqual([['removed-test', 'scores > rounds']]);
    const moved = wholeFile('src/a.test.ts', " import { describe, it } from 'vitest';", "-describe('scores', () => {", "+describe('totals', () => {", "   it('rounds', () => {});", ' });');
    expect(scanDiff(moved).map((f) => [f.form, f.match])).toEqual([['removed-test', 'scores > rounds']]);
  });

  it('blocks a test file deleted, from the diff or as given, and a test file renamed', () => {
    const deleted = deletedFile('src/a.test.ts', "import { it } from 'vitest';", "it('rounds', () => {});", "it.each([1, 2])('floors %i', () => {});");
    expect(scanDiff(deleted).map((f) => [f.file, f.match])).toEqual([
      ['src/a.test.ts', 'rounds'],
      ['src/a.test.ts', 'floors %i'],
    ]);
    expect(scanDiff('', { deletedTests: { 'tests/test_scores.py': 'def test_rounds():\n    assert score(1.234) == 1.23\n' } })).toEqual([{ file: 'tests/test_scores.py', form: 'removed-test', match: 'test_rounds' }]);
    const renamed = ['diff --git a/src/a.test.ts b/src/b.test.ts', 'similarity index 100%', 'rename from src/a.test.ts', 'rename to src/b.test.ts', ''].join('\n');
    expect(scanDiff(renamed, { deletedTests: { 'src/a.test.ts': "it('rounds', () => {});\n" } }).map((f) => [f.file, f.form, f.match])).toEqual([['src/a.test.ts', 'removed-test', 'rounds']]);
  });

  it('reads the Python tests by function and class, a renamed method included', () => {
    const diff = wholeFile('tests/test_scores.py', ' class TestScores:', '-    def test_rounds(self):', '+    def test_rounds_up(self):', '         assert score(1.234) == 1.23', ' ', '-def test_floors():', '-    assert floor(1.9) == 1', ' async def test_total():', '     assert total() == 0');
    expect(scanDiff(diff).map((f) => f.match)).toEqual(['TestScores::test_rounds', 'test_floors']);
  });

  it('passes added tests, a changed test body, a test moved inside its describe, a helper or a fixture deleted', () => {
    const diff = [
      wholeFile('src/a.test.ts', ...SUITE, "-  it('rounds', () => expect(score(1.234)).toBe(1.23));", "   it('floors', () => expect(floor(1.9)).toBe(1));", "+  it('rounds', () => expect(score(1.235)).toBe(1.24));", "+  it('caps', () => expect(cap(9)).toBe(5));", ' });'),
      deletedFile('test/helpers/scores.ts', "export const it = (name: string) => name;", "it('not a test');"),
      deletedFile('tests/fixtures/test_data.json', '{}'),
    ].join('');
    expect(scanDiff(diff)).toEqual([]);
  });

  it('a test removed on purpose is justified by a trailer of the branch, file by file', () => {
    const diff = [
      wholeFile('src/a.test.ts', ...SUITE, "-  it('rounds', () => {});", ' });'),
      wholeFile('src/b.test.ts', ...SUITE, "-  it('rounds', () => {});", ' });'),
    ].join('');
    const justified = justifiedRemovals('feat: drop the rounding\n\nRemoved-test: src/a.test.ts: rounding is gone with ORC-1\nRemoved-test: src/b.test.ts:\nremoved-test: src/c.test.ts: lower case\n');
    expect(justified).toEqual(['src/a.test.ts', 'src/c.test.ts']);
    expect(scanDiff(diff, { justified }).map((f) => f.file)).toEqual(['src/b.test.ts']);
  });

  it('says how to justify a removal in the summary', () => {
    const r = antiCheatCheck(wholeFile('src/a.test.ts', ...SUITE, "-  it('rounds', () => {});", ' });'));
    expect(r.summary).toBe(
      ['1 finding:', '- `src/a.test.ts`: test removed or renamed (`scores > rounds`)', 'A test removed or renamed on purpose is justified by a `Removed-test: <path>: <reason>` trailer in a commit of the branch.'].join('\n'),
    );
  });
});

describe('cheats read on the syntax tree (ORC-342)', () => {
  const blocked: [string, string, string, string][] = [
    // form, file, source, expected match
    ['disabled-test', 'src/a.test.ts', "const later = it.skip;\nlater('rounds', () => {});", 'it.skip'],
    ['disabled-test', 'src/a.test.ts', "it['skip']('rounds', () => {});", "it['skip']"],
    ['disabled-test', 'src/a.test.ts', "it['sk' + 'ip']('rounds', () => {});", "it['sk' + 'ip']"],
    ['disabled-test', 'src/a.test.ts', "import { test as check } from 'vitest';\ncheck.only('rounds', () => {});", 'check.only'],
    ['disabled-test', 'src/a.test.ts', "import * as v from 'vitest';\nv.describe.skip('scores', () => {});", 'v.describe.skip'],
    ['disabled-test', 'src/a.test.ts', "const { skip } = describe;\nskip('scores', () => {});", 'skip'],
    ['disabled-test', 'src/a.test.ts', "test('rounds', { skip: true }, () => {});", 'skip: true'],
    ['disabled-test', 'src/a.test.ts', "test('rounds', (context) => {\n  context.skip();\n});", 'context.skip'],
    ['disabled-test', 'src/a.test.ts', "test('rounds', ({ skip }) => {\n  skip();\n});", 'skip'],
    ['disabled-test', 'src/a.spec.js', "import { xit as later } from 'vitest';\nlater('rounds', () => {});", 'later'],
    ['bypass', 'src/a.test.ts', 'const check = expect;\ncheck(1).toBe(1);', 'check(1)'],
    ['bypass', 'src/a.test.ts', 'expect(!0).toBe(true);', 'expect(!0)'],
    ['bypass', 'src/a.test.ts', 'expect([1, 2]).toEqual([1, 2]);', 'expect([1, 2])'],
    ['bypass', 'src/a.test.ts', "const expected = 'ok';\nexpect(expected).toBe('ok');", 'expect(expected)'],
    ['bypass', 'src/a.test.ts', "import assert from 'node:assert';\nassert.equal(1, 1);", 'assert.equal(1, 1)'],
    ['bypass', 'src/a.test.ts', "import { strict as check } from 'node:assert';\ncheck(true);", 'check(true)'],
    ['bypass', 'src/cli.ts', 'const { exit } = process;\nexit(0);', 'exit(0)'],
    ['bypass', 'src/cli.ts', "process['exit']();", "process['exit']()"],
    ['bypass', 'src/cli.ts', "import { exit as leave } from 'node:process';\nleave(0);", 'leave(0)'],
    ['bypass', 'src/score.ts', '/**\n * @ts-expect-error\n */\nconst x: number = "1";', '@ts-expect-error'],
    ['bypass', 'src/score.ts', '/* eslint no-console: "off" */', 'eslint no-console: "off"'],
    ['test-only-behaviour', 'src/score.ts', "const mode = process.env.NODE_ENV;\nif (mode === 'test') return 42;", "mode === 'test'"],
    ['test-only-behaviour', 'src/score.ts', "const { NODE_ENV: env } = process.env;\nexport const fake = env == 'test';", "env == 'test'"],
    ['test-only-behaviour', 'src/score.ts', "switch (process.env.NODE_ENV) {\n  case 'test':\n    return 42;\n}", "switch (process.env.NODE_ENV) case 'test'"],
    ['test-only-behaviour', 'src/score.ts', "if (['test', 'e2e'].includes(import.meta.env.MODE)) return 42;", "['test', 'e2e'].includes(import.meta.env.MODE)"],
    ['test-only-behaviour', 'src/score.ts', "if (process.env['VI' + 'TEST']) return 42;", 'VITEST'],
    ['test-only-behaviour', 'src/score.ts', "const t = 'te' + 'st';\nif (process.env.NODE_ENV === t) return 42;", 'process.env.NODE_ENV === t'],
  ];

  it.each(blocked)('blocks %s in %s: %s', (form, file, source, match) => {
    const lines = source.split('\n');
    const diff = [`diff --git a/${file} b/${file}`, 'new file mode 100644', '--- /dev/null', `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ''].join('\n');
    expect(scanDiff(diff).map((f) => [f.form, f.match])).toEqual([[form, match]]);
  });

  it('reads the whole file but flags only what the diff added', () => {
    const diff = wholeFile('src/a.test.ts', ' const later = it.skip;', "+later('rounds', () => {});", ' // @ts-ignore', "+it('floors', () => {});");
    expect(scanDiff(diff)).toEqual([]);
  });

  it('an alias added on one line counts for the calls it changes, left as they were', () => {
    const xit = wholeFile('src/a.test.ts', "-import { it } from '@jest/globals';", "+import { xit as it } from '@jest/globals';", " it('rounds', () => {});");
    expect(scanDiff(xit)).toEqual([{ file: 'src/a.test.ts', line: 1, form: 'disabled-test', match: 'it' }]);
    const mode = wholeFile('src/score.ts', "+const env = process.env.NODE_ENV;", " export const fake = env === 'test';");
    expect(scanDiff(mode).map((f) => [f.line, f.match])).toEqual([[1, "env === 'test'"]]);
    // A plain import, `vi` added to it, makes no old finding new.
    const plain = wholeFile('src/a.test.ts', "-import { it } from 'vitest';", "+import { it, vi } from 'vitest';", " it.skip('rounds', () => {});");
    expect(scanDiff(plain)).toEqual([]);
  });

  it('an edit inside a long call or switch does not make its old finding new', () => {
    const diff = wholeFile('src/score.ts', ' switch (process.env.NODE_ENV) {', "   case 'development':", '-    return 1;', '+    return 2;', "   case 'test':", '     return 42;', ' }');
    expect(scanDiff(diff)).toEqual([]);
  });

  it('a skip() of a helper parameter is no test context: only a test or hook callback has one', () => {
    const diff = added('src/a.test.ts', 'const page = (cursor) => cursor.skip(10).limit(5);');
    expect(scanDiff(diff)).toEqual([]);
    expect(scanDiff(added('src/a.test.ts', 'beforeEach((ctx) => ctx.skip());')).map((f) => f.match)).toEqual(['ctx.skip']);
  });

  it('reads a string spanning lines as a string, in a whole file', () => {
    const diff = wholeFile('src/a.ts', ' const doc = `', '+  it.skip and process.exit(0) and // @ts-ignore', ' `;');
    expect(scanDiff(diff)).toEqual([]);
  });

  it('reads the script of a component, not its markup', () => {
    const diff = wholeFile('src/Score.vue', '+<template><p>process.exit(0) // @ts-ignore</p></template>', '+<script setup lang="ts">', "+if (process.env.NODE_ENV === 'test') emit('done');", '+</script>');
    expect(scanDiff(diff).map((f) => [f.line, f.match])).toEqual([[3, "process.env.NODE_ENV === 'test'"]]);
  });
});

describe('antiCheatCheck', () => {
  it('is green with the clean summary when nothing is found', () => {
    expect(antiCheatCheck(fileDiff('src/a.ts', ' a', '+b'))).toEqual({
      check: ANTI_CHEAT_CHECK,
      ok: true,
      summary: 'no disabled test, no workaround',
      findings: [],
    });
    expect(ANTI_CHEAT_CHECK).toBe('factory/anti-triche');
  });

  it('fails with the list of findings, file:line and form', () => {
    const diff = [
      added('src/a.test.ts', "it.skip('x', () => {});"),
      added('src/score.ts', "if (process.env.NODE_ENV === 'test') return 1;"),
      added('src/b.test.ts', 'expect(`ok`).toBe(`ok`);'),
    ].join('');
    const result = antiCheatCheck(diff, { frozenTests: ['src/a.test.ts'] });
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(4);
    expect(result.summary).toBe(
      [
        '4 findings:',
        '- `src/a.test.ts:11`: frozen acceptance test changed (changed)',
        '- `src/a.test.ts:11`: disabled test (`it.skip`)',
        "- `src/score.ts:11`: different behaviour under test (`process.env.NODE_ENV === 'test'`)",
        '- `src/b.test.ts:11`: workaround (`` expect(`ok`) ``)',
      ].join('\n'),
    );
  });

  it('keeps the summary under the GitHub limit, cutting long matches and counting what is left out', () => {
    const long = added('src/score.test.ts', `expect('${'x'.repeat(1000)}').toBe(1);`);
    const many = Array.from({ length: 2000 }, (_, i) => added(`src/f${i}.ts`, '// @ts-ignore')).join('');
    const result = antiCheatCheck(long + many);
    expect(result.findings).toHaveLength(2001);
    expect(result.summary.length).toBeLessThanOrEqual(65_535);
    expect(result.summary.split('\n')[1]).toMatch(/^- `src\/score\.test\.ts:11`: workaround \(`expect\('x{180,}…`\)$/);
    expect(result.summary).toMatch(/\n… and \d+ more$/);
  });

  it('says 1 finding for a single finding', () => {
    expect(antiCheatCheck(added('src/a.ts', '// @ts-ignore')).summary).toBe('1 finding:\n- `src/a.ts:11`: workaround (`@ts-ignore`)');
  });
});
