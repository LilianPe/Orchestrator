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
const VITEST_TYPE_ERROR = `
 FAIL  src/export.test.ts > exportCsv
TypeError: exportCsv is not a function
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
const PYTEST_ASSERTION = `
    def test_header():
>       assert export_csv([]) == "id,score"
E       AssertionError: assert '' == 'id,score'
FAILED tests/test_export.py::test_header - AssertionError
========================= 1 failed in 0.03s =========================`;
const PYTEST_MISSING = `
_______________ ERROR collecting tests/test_export.py _______________
ImportError while importing test module '/work/tests/test_export.py'.
E   ModuleNotFoundError: No module named 'app.export'
!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!`;
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

  it('reads a syntax or compilation error, for each runner', () => {
    for (const out of [VITEST_SYNTAX, JEST_SYNTAX, PYTEST_SYNTAX]) expect(readTestRun(1, out).kind).toBe('compile');
  });

  it('reads a missing module with what imported it', () => {
    expect(readTestRun(1, VITEST_MISSING)).toEqual({ kind: 'missing_module', modules: [{ module: './export.js', importer: 'src/export.test.ts' }] });
    expect(readTestRun(1, JEST_MISSING)).toEqual({ kind: 'missing_module', modules: [{ module: './export', importer: 'src/export.test.ts' }] });
    expect(readTestRun(2, PYTEST_MISSING)).toEqual({ kind: 'missing_module', modules: [{ module: 'app.export', python: true }] });
  });

  it('reads no test run, and tests that already pass', () => {
    for (const [code, out] of [[1, VITEST_NO_TESTS], [1, JEST_NO_TESTS], [5, PYTEST_NO_TESTS]] as const) expect(readTestRun(code, out).kind).toBe('no_tests');
    expect(readTestRun(0, ' Test Files  1 passed (1)')).toEqual({ kind: 'passing' });
  });

  it('reads a failure with no assertion (a runtime error, a timeout) as an error', () => {
    expect(readTestRun(1, VITEST_TYPE_ERROR).kind).toBe('error');
    expect(readTestRun(null, '').kind).toBe('error');
  });
});

/** Deps of a tests step that added `files`, whose run prints `output` with `exitCode`. */
function deps(files: string[], exitCode: number | null, output: string, atBase: string[] = []): RedDeps & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    changed: files.map((path) => ({ path, deleted: false })),
    run: async (command) => {
      commands.push(command);
      return { exitCode, output };
    },
    existsAtBase: async (path) => atBase.includes(path),
  };
}

describe('checkRed', () => {
  it('runs only the added test files and verifies a red on an assertion', async () => {
    const d = deps(['src/export.test.ts', 'tests/test_b.py'], 1, VITEST_ASSERTION);
    expect(await checkRed('npm test --', d)).toMatchObject({ verified: true, cause: 'assertion' });
    expect(d.commands).toEqual(["npm test -- 'src/export.test.ts' 'tests/test_b.py'"]);
  });

  it('refuses a compilation error', async () => {
    expect(await checkRed('npx vitest run', deps(['src/export.test.ts'], 1, VITEST_SYNTAX))).toMatchObject({ verified: false, cause: 'compile' });
  });

  it('accepts a missing module only when its path does not exist at baseSha (TypeScript)', async () => {
    expect(await checkRed('npx vitest run', deps(['src/export.test.ts'], 1, VITEST_MISSING))).toMatchObject({ verified: true, cause: 'missing_module' });
    const present = deps(['src/export.test.ts'], 1, JEST_MISSING, ['src/export.ts']);
    expect(await checkRed('npx jest', present)).toMatchObject({ verified: false, cause: 'module_at_base' });
  });

  it('accepts a missing module only when its path does not exist at baseSha (Python)', async () => {
    expect(await checkRed('pytest', deps(['tests/test_export.py'], 2, PYTEST_MISSING))).toMatchObject({ verified: true, cause: 'missing_module' });
    const present = deps(['tests/test_export.py'], 2, PYTEST_MISSING, ['app/export/__init__.py']);
    expect(await checkRed('pytest', present)).toMatchObject({ verified: false, cause: 'module_at_base' });
  });

  it('refuses a missing package (no relative path): the build would not create it', async () => {
    const out = "Cannot find module 'left-pad' from 'src/export.test.ts'";
    expect(await checkRed('npx jest', deps(['src/export.test.ts'], 1, out))).toMatchObject({ verified: false, cause: 'module_at_base' });
  });

  it('refuses tests that already pass, and a step that added no test', async () => {
    expect(await checkRed('npm test --', deps(['src/export.test.ts'], 0, 'ok'))).toMatchObject({ verified: false, cause: 'passing' });
    const none = deps([], 1, '');
    expect(await checkRed('npm test --', none)).toMatchObject({ verified: false, cause: 'no_tests' });
    expect(none.commands).toEqual([]);
  });

  it('fails the step when it touched a file that is not a test, without running anything', async () => {
    const d = deps(['src/export.test.ts', 'src/export.ts'], 1, VITEST_ASSERTION);
    expect(await checkRed('npm test --', d)).toMatchObject({ verified: false, cause: 'scope', detail: expect.stringContaining('src/export.ts') });
    expect(d.commands).toEqual([]);
  });

  it('does not run a test file the step deleted', async () => {
    const d = { ...deps(['src/export.test.ts'], 1, VITEST_ASSERTION), changed: [{ path: 'src/export.test.ts', deleted: false }, { path: 'src/old.test.ts', deleted: true }] };
    await checkRed('npm test --', d);
    expect(d.commands).toEqual(["npm test -- 'src/export.test.ts'"]);
  });
});
