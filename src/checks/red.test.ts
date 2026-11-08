import { describe, expect, it } from 'vitest';
import { checkRed, readTestRun, type RedDeps } from './red.js';

// Trimmed outputs of each runner, as they print them.
const VITEST_ASSERTION = `
 FAIL  src/export.test.ts > exportCsv > writes a header
AssertionError: expected '' to be 'id,score'
 Test Files  1 failed (1)
      Tests  1 failed (1)`;
const VITEST_SYNTAX = `
 FAIL  src/export.test.ts [ src/export.test.ts ]
Error: Transform failed with 1 error:
/work/src/export.test.ts:3:10: ERROR: Expected ")" but found "{"
 Test Files  1 failed (1)`;
const VITEST_MISSING = `
 FAIL  src/export.test.ts [ src/export.test.ts ]
Error: Failed to resolve import "./export.js" from "src/export.test.ts". Does the file exist?
 Test Files  1 failed (1)`;
const VITEST_NO_TESTS = `No test files found, exiting with code 1`;
const VITEST_NOT_A_FUNCTION = `
 FAIL  src/export.test.ts > exportCsv
TypeError: (0 , __vi_import_0__.exportCsv) is not a function
 Test Files  1 failed (1)`;
const VITEST_RUNTIME_ERROR = `
 FAIL  src/export.test.ts > exportCsv
TypeError: Cannot read properties of undefined (reading 'rows')
 Test Files  1 failed (1)`;
const JEST_ASSERTION = `
 FAIL  src/export.test.ts
  ● exportCsv › writes a header
    expect(received).toBe(expected) // Object.is equality
    Expected: "id,score"
    Received: ""
Tests:       1 failed, 1 total`;
const JEST_MISSING = `
 FAIL  src/export.test.ts
  ● Test suite failed to run
    Cannot find module './export' from 'src/export.test.ts'
Tests:       0 total`;
const JEST_SYNTAX = `
 FAIL  src/export.test.ts
  ● Test suite failed to run
    SyntaxError: /work/src/export.test.ts: Unexpected token (3:10)`;
const JEST_NO_TESTS = `No tests found, exiting with code 1`;
const TS_JEST_NO_EXPORT = `
 FAIL  src/export.test.ts
  ● Test suite failed to run
    src/export.test.ts:1:10 - error TS2305: Module '"./export"' has no exported member 'exportCsv'.`;
const TS_JEST_NO_MODULE = `
 FAIL  src/export.test.ts
  ● Test suite failed to run
    src/export.test.ts:1:27 - error TS2307: Cannot find module './export' or its corresponding type declarations.`;
const TS_JEST_TYPE_ERROR = `
    src/export.test.ts:1:27 - error TS2307: Cannot find module './export' or its corresponding type declarations.
    src/export.test.ts:4:7 - error TS2322: Type 'string' is not assignable to type 'number'.`;
const NODE_ESM_NO_EXPORT = `SyntaxError: The requested module './export.js' does not provide an export named 'exportCsv'`;
const PYTEST_HEADER = `============================= test session starts ==============================
collected 0 items / 1 error

==================================== ERRORS ====================================
_______________ ERROR collecting tests/test_export.py _______________
ImportError while importing test module '/work/tests/test_export.py'.`;
const PYTEST_FOOTER = `=========================== short test summary info ============================
ERROR tests/test_export.py
!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!
=============================== 1 error in 0.05s ===============================`;
const PYTEST_ASSERTION = `
    def test_header():
>       assert export_csv([]) == "id,score"
E       AssertionError: assert '' == 'id,score'
FAILED tests/test_export.py::test_header - AssertionError
========================= 1 failed in 0.03s =========================`;
const PYTEST_MISSING = `${PYTEST_HEADER}\nE   ModuleNotFoundError: No module named 'app.export'\n${PYTEST_FOOTER}`;
const PYTEST_PACKAGE = `${PYTEST_HEADER}\nE   ModuleNotFoundError: No module named 'requests'\n${PYTEST_FOOTER}`;
const PYTEST_NO_NAME = `${PYTEST_HEADER}\nE   ImportError: cannot import name 'export_csv' from 'app.export' (/work/app/export.py)\n${PYTEST_FOOTER}`;
const PYTEST_SYNTAX = `
_______________ ERROR collecting tests/test_export.py _______________
E     File "/work/tests/test_export.py", line 3
E       def test_header(:
E   SyntaxError: invalid syntax
!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!`;
const PYTEST_NO_TESTS = `collected 0 items\n\n========================= no tests ran in 0.01s =========================`;

describe('readTestRun', () => {
  it('reads a failure on an assertion, for vitest, jest and pytest', () => {
    for (const out of [VITEST_ASSERTION, JEST_ASSERTION, PYTEST_ASSERTION]) expect(readTestRun(1, out)).toEqual({ kind: 'assertion' });
  });

  it('reads a syntax or compilation error, for each runner, and a TS error besides a missing module', () => {
    for (const out of [VITEST_SYNTAX, JEST_SYNTAX, PYTEST_SYNTAX, TS_JEST_TYPE_ERROR]) expect(readTestRun(1, out).kind, out).toBe('compile');
  });

  it('reads a missing module with what imported it, the pytest header with 0 items included', () => {
    expect(readTestRun(1, VITEST_MISSING)).toEqual({ kind: 'missing', missing: [{ module: './export.js', importer: 'src/export.test.ts' }] });
    expect(readTestRun(1, JEST_MISSING)).toEqual({ kind: 'missing', missing: [{ module: './export', importer: 'src/export.test.ts' }] });
    expect(readTestRun(1, TS_JEST_NO_MODULE)).toEqual({ kind: 'missing', missing: [{ module: './export', importer: 'src/export.test.ts' }] });
    expect(readTestRun(2, PYTEST_MISSING)).toEqual({ kind: 'missing', missing: [{ module: 'app.export', python: true }] });
  });

  it('reads a missing export of a module, for each runner', () => {
    expect(readTestRun(1, TS_JEST_NO_EXPORT)).toEqual({ kind: 'missing', missing: [{ module: './export', symbol: 'exportCsv', importer: 'src/export.test.ts' }] });
    expect(readTestRun(1, NODE_ESM_NO_EXPORT)).toEqual({ kind: 'missing', missing: [{ module: './export.js', symbol: 'exportCsv' }] });
    expect(readTestRun(1, VITEST_NOT_A_FUNCTION)).toEqual({ kind: 'missing', missing: [{ symbol: 'exportCsv' }] });
    expect(readTestRun(2, PYTEST_NO_NAME)).toEqual({ kind: 'missing', missing: [{ module: 'app.export', symbol: 'export_csv', python: true }] });
  });

  it('reads no test run, and tests that already pass', () => {
    for (const [code, out] of [[1, VITEST_NO_TESTS], [1, JEST_NO_TESTS], [5, PYTEST_NO_TESTS]] as const) expect(readTestRun(code, out).kind).toBe('no_tests');
    expect(readTestRun(0, ' Test Files  1 passed (1)')).toEqual({ kind: 'passing' });
  });

  it('reads a failure with no assertion (a runtime error, a timeout) as an error', () => {
    expect(readTestRun(1, VITEST_RUNTIME_ERROR).kind).toBe('error');
    expect(readTestRun(null, '').kind).toBe('error');
  });
});

interface Repo {
  /** Files at baseSha, with their content. */
  base?: Record<string, string>;
  /** Test files at the step's head, with their content. */
  head?: Record<string, string>;
  uncommitted?: string[];
}

/** Deps of a tests step that committed `files`, whose run prints `output` with `exitCode`. */
function deps(files: string[], exitCode: number | null, output: string, repo: Repo = {}): RedDeps & { commands: string[] } {
  const commands: string[] = [];
  const base = repo.base ?? {};
  return {
    commands,
    changed: files.map((path) => ({ path, deleted: false })),
    uncommitted: repo.uncommitted ?? [],
    run: async (command) => {
      commands.push(command);
      return { exitCode, output };
    },
    existsAtBase: async (paths) => new Set(paths.filter((p) => p in base || Object.keys(base).some((f) => f.startsWith(`${p}/`)))),
    showAtBase: async (path) => base[path],
    showAtHead: async (path) => repo.head?.[path],
  };
}

describe('checkRed', () => {
  it('runs only the added test files, not their helpers, and verifies a red on an assertion', async () => {
    const d = deps(['src/export.test.ts', 'tests/test_b.py', 'tests/fixtures/data.json', 'tests/conftest.py'], 1, VITEST_ASSERTION);
    expect(await checkRed('npm test --', d)).toMatchObject({ verified: true, cause: 'assertion' });
    expect(d.commands).toEqual(["npm test -- 'src/export.test.ts' 'tests/test_b.py'"]);
  });

  it('refuses a compilation error', async () => {
    expect(await checkRed('npx vitest run', deps(['src/export.test.ts'], 1, VITEST_SYNTAX))).toMatchObject({ verified: false, cause: 'compile' });
  });

  it('accepts a missing module only when its path does not exist at baseSha (TypeScript)', async () => {
    expect(await checkRed('npx vitest run', deps(['src/export.test.ts'], 1, VITEST_MISSING))).toMatchObject({ verified: true, cause: 'missing_module' });
    const present = deps(['src/export.test.ts'], 1, JEST_MISSING, { base: { 'src/export.ts': '' } });
    expect(await checkRed('npx jest', present)).toMatchObject({ verified: false, cause: 'module_at_base' });
    expect(await checkRed('npx jest', deps(['src/export.test.ts'], 1, TS_JEST_NO_MODULE))).toMatchObject({ verified: true, cause: 'missing_module' });
  });

  it('resolves a relative module from the test file of the diff, under a sub-root', async () => {
    const d = deps(['packages/api/src/export.test.ts'], 1, JEST_MISSING, { base: { 'src/export.ts': '' } });
    expect(await checkRed('npx jest', d)).toMatchObject({ verified: true, cause: 'missing_module' });
    const present = deps(['packages/api/src/export.test.ts'], 1, JEST_MISSING, { base: { 'packages/api/src/export.ts': '' } });
    expect(await checkRed('npx jest', present)).toMatchObject({ verified: false, cause: 'module_at_base' });
  });

  it('accepts a missing Python module of a package of the repository, not when it exists at baseSha', async () => {
    const repo = { base: { 'app/__init__.py': '' } };
    expect(await checkRed('pytest', deps(['tests/test_export.py'], 2, PYTEST_MISSING, repo))).toMatchObject({ verified: true, cause: 'missing_module' });
    const present = deps(['tests/test_export.py'], 2, PYTEST_MISSING, { base: { 'app/__init__.py': '', 'app/export/__init__.py': '' } });
    expect(await checkRed('pytest', present)).toMatchObject({ verified: false, cause: 'module_at_base' });
  });

  it('refuses a missing package, Python or npm: the build does not install one', async () => {
    expect(await checkRed('pytest', deps(['tests/test_export.py'], 2, PYTEST_PACKAGE))).toMatchObject({ verified: false, cause: 'missing_package' });
    expect(await checkRed('pytest', deps(['tests/test_export.py'], 2, PYTEST_MISSING))).toMatchObject({ verified: false, cause: 'missing_package' });
    const npm = "Cannot find module 'left-pad' from 'src/export.test.ts'";
    expect(await checkRed('npx jest', deps(['src/export.test.ts'], 1, npm))).toMatchObject({ verified: false, cause: 'missing_package' });
  });

  it('accepts a missing export of a module that exists, only when the symbol is not there at baseSha', async () => {
    const without = { base: { 'src/export.ts': 'export const other = 1;\n' } };
    const withIt = { base: { 'src/export.ts': 'export function exportCsv() {}\n' } };
    for (const out of [TS_JEST_NO_EXPORT, NODE_ESM_NO_EXPORT]) {
      expect(await checkRed('npx jest', deps(['src/export.test.ts'], 1, out, without)), out).toMatchObject({ verified: true, cause: 'missing_export' });
      expect(await checkRed('npx jest', deps(['src/export.test.ts'], 1, out, withIt)), out).toMatchObject({ verified: false, cause: 'compile' });
    }
    const py = { base: { 'app/__init__.py': '', 'app/export.py': 'def other(): pass\n' } };
    expect(await checkRed('pytest', deps(['tests/test_export.py'], 2, PYTEST_NO_NAME, py))).toMatchObject({ verified: true, cause: 'missing_export' });
  });

  it('finds the module of an undefined function in the imports of the test file (vitest)', async () => {
    const head = { 'src/export.test.ts': "import { describe } from 'vitest';\nimport { exportCsv, other } from './export';\n" };
    const d = deps(['src/export.test.ts'], 1, VITEST_NOT_A_FUNCTION, { base: { 'src/export.ts': 'export const other = 1;\n' }, head });
    expect(await checkRed('npx vitest run', d)).toMatchObject({ verified: true, cause: 'missing_export' });
    // Not imported by a test: nothing says what is missing.
    expect(await checkRed('npx vitest run', deps(['src/export.test.ts'], 1, VITEST_NOT_A_FUNCTION))).toMatchObject({ verified: false, cause: 'error' });
  });

  it('refuses tests that already pass, and a step that added no test', async () => {
    expect(await checkRed('npm test --', deps(['src/export.test.ts'], 0, 'ok'))).toMatchObject({ verified: false, cause: 'passing' });
    const none = deps(['tests/fixtures/data.json'], 1, '');
    expect(await checkRed('npm test --', none)).toMatchObject({ verified: false, cause: 'no_tests' });
    expect(none.commands).toEqual([]);
  });

  it('fails the step when it touched a file that is not a test, committed or not, without running anything', async () => {
    const d = deps(['src/export.test.ts', 'src/export.ts'], 1, VITEST_ASSERTION);
    expect(await checkRed('npm test --', d)).toMatchObject({ verified: false, cause: 'scope', detail: expect.stringContaining('src/export.ts') });
    const dirty = deps(['src/export.test.ts'], 1, VITEST_ASSERTION, { uncommitted: ['src/draft.ts', 'src/wip.test.ts'] });
    expect(await checkRed('npm test --', dirty)).toMatchObject({ verified: false, cause: 'scope', detail: expect.stringContaining('src/draft.ts') });
    expect([...d.commands, ...dirty.commands]).toEqual([]);
  });

  it('does not run a test file the step deleted', async () => {
    const d = { ...deps(['src/export.test.ts'], 1, VITEST_ASSERTION), changed: [{ path: 'src/export.test.ts', deleted: false }, { path: 'src/old.test.ts', deleted: true }] };
    await checkRed('npm test --', d);
    expect(d.commands).toEqual(["npm test -- 'src/export.test.ts'"]);
  });
});

// ORC-342: the runner's machine report, not its text output.
interface ReportTest {
  fullName: string;
  status: 'passed' | 'failed' | 'pending';
  failureMessages?: string[];
}

/** A JSON report as vitest and jest write it (`--reporter=json`, `--json`), trimmed to what the check reads. */
function jsonReport(files: { name: string; message?: string; tests: ReportTest[] }[]): string {
  const tests = files.flatMap((f) => f.tests);
  return JSON.stringify({
    numTotalTests: tests.length,
    numPassedTests: tests.filter((t) => t.status === 'passed').length,
    numFailedTests: tests.filter((t) => t.status === 'failed').length,
    success: false,
    testResults: files.map((f) => ({
      name: `/work/${f.name}`,
      status: f.message || f.tests.some((t) => t.status === 'failed') ? 'failed' : 'passed',
      message: f.message ?? '',
      assertionResults: f.tests.map((t) => ({ ancestorTitles: [], title: t.fullName, failureMessages: [], ...t })),
    })),
  });
}

const ASSERTION_FAILURE = 'AssertionError: expected 1 to be 2 // Object.is equality\n    at /work/src/export.test.ts:4:38';

/** Deps whose run prints `output`, then writes `report` where the command asked for it. */
function reporting(files: string[], exitCode: number | null, output: string, report: string | undefined, repo: Repo = {}): RedDeps & { commands: string[] } {
  const d = deps(files, exitCode, output, repo);
  return {
    ...d,
    run: async (command) => {
      d.commands.push(command);
      const marker = /'(@@factory-report-[\w-]+@@)'/.exec(command)?.[1];
      return { exitCode, output: report === undefined || !marker ? output : `${output}\n${marker}\n${report}` };
    },
  };
}

describe('checkRed reads the runner report (ORC-342)', () => {
  it('a passing test whose name says fail or AssertionError does not make the run red', async () => {
    const output = ' ✓ src/export.test.ts > fails with an AssertionError on bad input\n Tests  1 passed (1)\n ERROR: Coverage for lines (12%) does not meet threshold (80%)';
    // The text alone reads an assertion: the name says so.
    expect(readTestRun(1, output).kind).toBe('assertion');
    const report = jsonReport([{ name: 'src/export.test.ts', tests: [{ fullName: 'fails with an AssertionError on bad input', status: 'passed' }] }]);
    expect(await checkRed('npx vitest run', reporting(['src/export.test.ts'], 1, output, report))).toMatchObject({ verified: false, cause: 'passing' });
  });

  it('a failing assertion beside a passing test named after a SyntaxError is an assertion', async () => {
    const output = ' ✓ src/export.test.ts > rejects a SyntaxError in the header\n × src/export.test.ts > writes a header\nAssertionError: expected 1 to be 2';
    expect(readTestRun(1, output).kind).toBe('compile');
    const report = jsonReport([
      {
        name: 'src/export.test.ts',
        tests: [
          { fullName: 'rejects a SyntaxError in the header', status: 'passed' },
          { fullName: 'writes a header', status: 'failed', failureMessages: [ASSERTION_FAILURE] },
        ],
      },
    ]);
    expect(await checkRed('npx vitest run', reporting(['src/export.test.ts'], 1, output, report))).toMatchObject({ verified: true, cause: 'assertion' });
  });

  it('asks vitest and jest for their JSON report, pytest for its JUnit report, after the test files; the command it records is the plain one', async () => {
    const cases: [string, RegExp][] = [
      ['npx vitest run', /^npx vitest run 'src\/export\.test\.ts' --reporter=default --reporter=json --outputFile\.json="\$f"/m],
      ['npx jest', /^npx jest 'src\/export\.test\.ts' --json --outputFile="\$f"/m],
      ['python -m pytest', /^python -m pytest 'src\/export\.test\.ts' --junitxml="\$f"/m],
    ];
    for (const [command, flags] of cases) {
      const d = reporting(['src/export.test.ts'], 1, VITEST_ASSERTION, undefined);
      expect(await checkRed(command, d), command).toMatchObject({ command: `${command} 'src/export.test.ts'` });
      expect(d.commands[0], command).toMatch(flags);
    }
  });

  it('through npm test, reads the runner of the test script, only when the flags reach it', async () => {
    const pkg = (test: string) => ({ head: { 'package.json': JSON.stringify({ scripts: { test } }) } });
    const ran = async (command: string, test: string) => {
      const d = reporting(['src/export.test.ts'], 1, VITEST_ASSERTION, undefined, pkg(test));
      await checkRed(command, d);
      return d.commands[0]!;
    };
    expect(await ran('npm test --', 'tsc --noEmit && vitest run')).toContain("npm test -- 'src/export.test.ts' --reporter=default --reporter=json");
    // The flags would go to another command, or to npm itself: the text output is read.
    expect(await ran('npm test --', 'vitest run && echo done')).toBe("npm test -- 'src/export.test.ts'");
    expect(await ran('npm test', 'vitest run')).toBe("npm test 'src/export.test.ts'");
    expect(await ran('npm test --', 'mocha')).toBe("npm test -- 'src/export.test.ts'");
  });

  it('reads a test file that did not load from the report: a missing module', async () => {
    const report = jsonReport([{ name: 'src/export.test.ts', message: "Cannot find module './export.js' imported from /work/src/export.test.ts", tests: [] }]);
    expect(await checkRed('npx vitest run', reporting(['src/export.test.ts'], 1, '', report))).toMatchObject({ verified: true, cause: 'missing_module' });
    const present = reporting(['src/export.test.ts'], 1, '', report, { base: { 'src/export.ts': '' } });
    expect(await checkRed('npx vitest run', present)).toMatchObject({ verified: false, cause: 'module_at_base' });
  });

  it('reads an undefined function of the vitest 5 form, and a runtime error, per failing test', async () => {
    const head = { 'src/export.test.ts': "import { exportCsv } from './export';\n" };
    const notAFunction = jsonReport([{ name: 'src/export.test.ts', tests: [{ fullName: 'exports', status: 'failed', failureMessages: ['TypeError: __vite_ssr_import_1__.exportCsv is not a function\n    at x'] }] }]);
    const d = reporting(['src/export.test.ts'], 1, '', notAFunction, { base: { 'src/export.ts': 'export const other = 1;\n' }, head });
    expect(await checkRed('npx vitest run', d)).toMatchObject({ verified: true, cause: 'missing_export' });
    const runtime = jsonReport([{ name: 'src/export.test.ts', tests: [{ fullName: 'exports', status: 'failed', failureMessages: ["TypeError: Cannot read properties of undefined (reading 'rows')"] }] }]);
    expect(await checkRed('npx vitest run', reporting(['src/export.test.ts'], 1, '', runtime))).toMatchObject({ verified: false, cause: 'error' });
  });

  it('reads no test from the report', async () => {
    const report = jsonReport([{ name: 'src/export.test.ts', tests: [] }]);
    expect(await checkRed('npx vitest run', reporting(['src/export.test.ts'], 1, 'AssertionError somewhere in a log', report))).toMatchObject({ verified: false, cause: 'no_tests' });
  });

  it('reads a jest assertion from its colored failure message', async () => {
    const failure = '\u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m\u001b[2m).\u001b[22mtoBe\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m)\u001b[22m';
    const report = jsonReport([{ name: 'src/export.test.ts', tests: [{ fullName: 'exports', status: 'failed', failureMessages: [`Error: ${failure}`] }] }]);
    expect(await checkRed('npx jest', reporting(['src/export.test.ts'], 1, '', report))).toMatchObject({ verified: true, cause: 'assertion' });
  });

  it('reads the JUnit report of pytest: an assertion, a collection error, a test named after a failure that passes', async () => {
    const junit = (cases: string) => `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest">${cases}</testsuite></testsuites>`;
    const assertion = junit(
      '<testcase classname="tests.test_export" name="test_fails_on_AssertionError" time="0.01"/>' +
        '<testcase classname="tests.test_export" name="test_header" time="0.01"><failure message="AssertionError: assert &apos;&apos; == &apos;id,score&apos;">def test_header():\n&gt;       assert export_csv([]) == "id,score"\nE       AssertionError</failure></testcase>',
    );
    expect(await checkRed('pytest', reporting(['tests/test_export.py'], 1, 'ERROR collecting', assertion))).toMatchObject({ verified: true, cause: 'assertion' });
    const collection = junit('<testcase classname="" name="tests.test_export" time="0.00"><error message="collection failure">ImportError while importing test module.\nE   ModuleNotFoundError: No module named &apos;app.export&apos;</error></testcase>');
    const repo = { base: { 'app/__init__.py': '' } };
    expect(await checkRed('pytest', reporting(['tests/test_export.py'], 2, '', collection, repo))).toMatchObject({ verified: true, cause: 'missing_module' });
    const passing = junit('<testcase classname="tests.test_export" name="test_fails_with_SyntaxError" time="0.01"/>');
    expect(await checkRed('pytest', reporting(['tests/test_export.py'], 1, 'SyntaxError', passing))).toMatchObject({ verified: false, cause: 'passing' });
  });

  it('falls back on the text output when the runner wrote no report', async () => {
    expect(await checkRed('npx vitest run', reporting(['src/export.test.ts'], 1, VITEST_SYNTAX, undefined))).toMatchObject({ verified: false, cause: 'compile' });
    expect(await checkRed('npx vitest run', reporting(['src/export.test.ts'], 1, VITEST_ASSERTION, 'not json'))).toMatchObject({ verified: true, cause: 'assertion' });
  });
});

describe('checkRed reads symbols on the AST (ORC-342)', () => {
  it('a symbol only named in a comment or a string at baseSha is missing', async () => {
    const base = { 'src/export.ts': "// exportCsv comes with the ticket\nexport const other = 'exportCsv';\n" };
    expect(await checkRed('npx jest', deps(['src/export.test.ts'], 1, TS_JEST_NO_EXPORT, { base }))).toMatchObject({ verified: true, cause: 'missing_export' });
  });

  it('a symbol exported under another form exists: a renamed export, an export list, a re-export', async () => {
    for (const source of ['const csv = () => "";\nexport { csv as exportCsv };\n', 'function exportCsv() {}\nexport { exportCsv };\n', 'export default class {}\nexport type { Row as exportCsv } from "./row";\n']) {
      const base = { 'src/export.ts': source };
      expect(await checkRed('npx jest', deps(['src/export.test.ts'], 1, TS_JEST_NO_EXPORT, { base })), source).toMatchObject({ verified: false, cause: 'compile' });
    }
  });

  it('a symbol declared but not exported at baseSha is a missing export', async () => {
    const base = { 'src/export.ts': 'function exportCsv() {}\nexport const other = exportCsv;\n' };
    expect(await checkRed('npx jest', deps(['src/export.test.ts'], 1, TS_JEST_NO_EXPORT, { base }))).toMatchObject({ verified: true, cause: 'missing_export' });
  });

  it('finds the import of an undefined function on the AST: a commented import is not one, a multi-line one is', async () => {
    const head = { 'src/export.test.ts': "// import { exportCsv } from './old';\nimport {\n  type Row,\n  exportCsv,\n} from './export';\n" };
    const d = deps(['src/export.test.ts'], 1, VITEST_NOT_A_FUNCTION, { base: { 'src/export.ts': 'export const other = 1;\n' }, head });
    expect(await checkRed('npx vitest run', d)).toMatchObject({ verified: true, cause: 'missing_export' });
    const withIt = deps(['src/export.test.ts'], 1, VITEST_NOT_A_FUNCTION, { base: { 'src/export.ts': 'export function exportCsv() {}\n' }, head });
    expect(await checkRed('npx vitest run', withIt)).toMatchObject({ verified: false, cause: 'compile' });
  });
});
