import { describe, expect, it } from 'vitest';
import { isTestFile, isTestHarnessFile } from './test-files.js';

describe('isTestFile', () => {
  it('recognises TS and JS test files by name', () => {
    for (const p of ['src/a.test.ts', 'src/a.spec.tsx', 'a.test.mjs', 'web/b.spec.js', 'src/x.live.test.ts', 'types.test-d.ts', 'src\\win\\c.test.cts']) {
      expect(isTestFile(p), p).toBe(true);
    }
  });

  it('recognises Python test files and conftest.py', () => {
    for (const p of ['test_scores.py', 'pkg/test_api.py', 'pkg/api_test.py', 'conftest.py', 'pkg/conftest.py']) expect(isTestFile(p), p).toBe(true);
  });

  it('counts everything under a test directory, helpers and fixtures included', () => {
    for (const p of ['test/helpers/harness.ts', 'tests/fixtures/data.json', 'src/__tests__/a.ts', 'pkg/tests/factories.py']) expect(isTestFile(p), p).toBe(true);
  });

  it('leaves source files alone, even with test in their name', () => {
    for (const p of ['src/core/verify.ts', 'src/testing.ts', 'src/latest.ts', 'pkg/contest.py', 'pkg/testing/util.py', 'src/test.ts', 'README.md', 'test']) {
      expect(isTestFile(p), p).toBe(false);
    }
  });
});

describe('isTestHarnessFile', () => {
  it('recognises the runner configuration and global setup, which are not test files', () => {
    for (const p of ['vitest.config.ts', 'web/vitest.config.mts', 'vitest.config.e2e.ts', 'vitest.workspace.unit.mjs', 'jest.config.js', 'jest.setup.ts', 'jest.config.ci.cjs', 'jest.config.json', 'src/setupTests.ts', 'pytest.ini', '.pytest.ini', 'pytest.toml', 'pkg/.pytest.toml']) {
      expect(isTestHarnessFile(p), p).toBe(true);
      expect(isTestFile(p), p).toBe(false);
    }
    // vite.config.* also builds the app: what it reads of the test environment can ship.
    for (const p of ['vite.config.ts', 'vitest.ts', 'jest.configure.ts']) expect(isTestHarnessFile(p), p).toBe(false);
  });
});
