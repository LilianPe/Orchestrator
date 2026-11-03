// The one rule for "is this a test file", shared by the deterministic checks: the anti-cheat scan (ORC-158),
// the diff size outside tests (ORC-145), the `tests` step touching only tests (ORC-123) and the freeze (ORC-131).
// Paths are repository-relative; backslashes are read as slashes.

// TS/JS: `*.test.ts`, `*.spec.tsx`, `*.test-d.ts` (vitest type tests)... Python: `test_*.py`, `*_test.py`, `conftest.py`.
const TEST_NAME = [/\.(?:test|spec)(?:-d)?\.[cm]?[jt]sx?$/, /^test_[^/]*\.py$/, /_test\.py$/, /^conftest\.py$/];

// Anything under one of these directories is test code (helpers, fixtures, contracts included).
const TEST_DIR = new Set(['test', 'tests', '__tests__']);

// The test runner's own configuration and global setup: not a test, but read only by the test run. Variants
// (`vitest.config.e2e.ts`) included. `vite.config.*` is not: it also builds the app, where a `define` reading the test
// environment would change what ships.
const HARNESS_NAME = [/^(?:vitest|jest)\.(?:config|setup|workspace)(?:\.[\w-]+)?\.[cm]?[jt]s$/, /^setupTests\.[cm]?[jt]sx?$/, /^pytest\.ini$/];

/** Repository-relative path with slashes and no leading `./`, as git prints it. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function parts(path: string): string[] {
  return normalizePath(path).split('/').filter(Boolean);
}

export function isTestFile(path: string): boolean {
  const segments = parts(path);
  const name = segments.at(-1) ?? '';
  return TEST_NAME.some((re) => re.test(name)) || segments.slice(0, -1).some((s) => TEST_DIR.has(s));
}

/** A file the test runner runs, by its name: not a helper, a fixture or `conftest.py` under a test directory (ORC-123). */
export function isTestSpec(path: string): boolean {
  const name = parts(path).at(-1) ?? '';
  return name !== 'conftest.py' && TEST_NAME.some((re) => re.test(name));
}

export function isTestHarnessFile(path: string): boolean {
  const name = parts(path).at(-1) ?? '';
  return HARNESS_NAME.some((re) => re.test(name));
}
