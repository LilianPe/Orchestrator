// The one rule for "is this a test file", shared by the deterministic checks: the anti-cheat scan (ORC-158),
// the diff size outside tests (ORC-145), the `tests` step touching only tests (ORC-123) and the freeze (ORC-131).
// Paths are repository-relative; backslashes are read as slashes.

// TS/JS: `*.test.ts`, `*.spec.tsx`, `*.test-d.ts` (vitest type tests)... Python: `test_*.py`, `*_test.py`, `conftest.py`.
const TEST_NAME = [/\.(?:test|spec)(?:-d)?\.[cm]?[jt]sx?$/, /^test_[^/]*\.py$/, /_test\.py$/, /^conftest\.py$/];

// Anything under one of these directories is test code (helpers, fixtures, contracts included).
const TEST_DIR = new Set(['test', 'tests', '__tests__']);

// The test runner's own configuration and global setup: not a test, but read only by the test run.
const HARNESS_NAME = [/^(?:vitest|jest)\.(?:config|setup|workspace)\.[cm]?[jt]s$/, /^setupTests\.[cm]?[jt]sx?$/, /^pytest\.ini$/];

function parts(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter(Boolean);
}

export function isTestFile(path: string): boolean {
  const segments = parts(path);
  const name = segments.at(-1) ?? '';
  return TEST_NAME.some((re) => re.test(name)) || segments.slice(0, -1).some((s) => TEST_DIR.has(s));
}

export function isTestHarnessFile(path: string): boolean {
  const name = parts(path).at(-1) ?? '';
  return HARNESS_NAME.some((re) => re.test(name));
}
