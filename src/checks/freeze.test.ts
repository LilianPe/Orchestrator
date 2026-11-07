import { describe, expect, it } from 'vitest';
import { checkFrozen, fingerprint, FREEZE_CHECK, freezeTests, isFrozenHarness, newTestsOnly, type FreezeView } from './freeze.js';

const TEST = "import { expect, it } from 'vitest';\nit('exports', () => expect(toCsv([])).toBe(''));\n";
const PKG = JSON.stringify({ name: 'app', scripts: { test: 'vitest run', build: 'tsc' } });
const PYPROJECT = '[project]\nname = "app"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n';

/** A commit's files by content: what the factory reads on its repository. */
function view(head: string, files: Record<string, string>, changed: string[] = []): FreezeView {
  return {
    head,
    changed: changed.map((path) => ({ path, deleted: !(path in files) })),
    filesAtHead: async () => Object.keys(files),
    showAtHead: async (p) => files[p],
  };
}

const AT_FREEZE = {
  'src/export.test.ts': TEST,
  'src/export.ts': 'export const toCsv = () => "";\n',
  'vitest.config.ts': 'export default {};\n',
  'tests/conftest.py': 'import pytest\n',
  'package.json': PKG,
  'pyproject.toml': PYPROJECT,
  'tsconfig.json': '{}',
};

async function frozen() {
  return freezeTests(['src/export.test.ts'], view('sha-1', AT_FREEZE));
}

/** The check on the head after `changes` (a file set to undefined is deleted). */
async function after(changes: Record<string, string | undefined>) {
  const files = { ...AT_FREEZE, ...changes };
  for (const [p, c] of Object.entries(changes)) if (c === undefined) delete files[p as keyof typeof files];
  return checkFrozen(await frozen(), view('sha-2', files as Record<string, string>, Object.keys(changes)));
}

describe('freezeTests (ORC-131)', () => {
  it('throws on a file of the commit it cannot read: a breakdown never leaves it out of the freeze', async () => {
    const broken: FreezeView = { ...view('sha-1', AT_FREEZE), showAtHead: async (p) => (p === 'src/export.test.ts' ? undefined : AT_FREEZE[p as keyof typeof AT_FREEZE]) };
    await expect(freezeTests(['src/export.test.ts'], broken)).rejects.toThrow('src/export.test.ts');
  });

  it('leaves out a file frozen before and deleted since: a /refreeze takes it out', async () => {
    const { files } = await freezeTests(['src/gone.test.ts'], view('sha-1', AT_FREEZE));
    expect(files).not.toHaveProperty(['src/gone.test.ts']);
  });

  it('fingerprints the tests of the step and the harness at the head, nothing else', async () => {
    const f = await frozen();
    expect(f.sha).toBe('sha-1');
    expect(Object.keys(f.files).sort()).toEqual(['package.json', 'pyproject.toml', 'src/export.test.ts', 'tests/conftest.py', 'tsconfig.json', 'vitest.config.ts']);
  });

  it('a package.json without a test script, a pyproject.toml without pytest are not frozen', async () => {
    const f = await freezeTests([], view('s', { 'package.json': '{"name":"x"}', 'pyproject.toml': '[project]\nname = "x"\n' }));
    expect(f.files).toEqual({});
  });
});

describe('newTestsOnly (ORC-131)', () => {
  it('keeps the tests of a later step, not the harness, a conftest.py under a test directory included', () => {
    const read = { sha: 's', files: { 'src/new.test.ts': 'a', 'jest.config.js': 'b', 'tests/conftest.py': 'c', 'package.json': 'd' } };
    expect(newTestsOnly(read)).toEqual({ sha: 's', files: { 'src/new.test.ts': 'a' } });
  });
});

describe('checkFrozen (ORC-131)', () => {
  it('a skip added to a frozen test blocks', async () => {
    const r = await after({ 'src/export.test.ts': TEST.replace("it('", "it.skip('") });
    expect(r).toMatchObject({ check: FREEZE_CHECK, ok: false });
    expect(r.summary).toContain('src/export.test.ts');
  });

  it('a modified vitest.config.ts blocks', async () => {
    expect((await after({ 'vitest.config.ts': 'export default { test: { exclude: ["**"] } };\n' })).ok).toBe(false);
  });

  it('a modified conftest.py blocks', async () => {
    expect((await after({ 'tests/conftest.py': 'import pytest\ncollect_ignore = ["test_export.py"]\n' })).ok).toBe(false);
  });

  it('a deleted frozen file blocks', async () => {
    const r = await after({ 'src/export.test.ts': undefined });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('deleted');
  });

  it('a harness file added after the freeze blocks: it can switch tests off', async () => {
    expect((await after({ 'jest.config.js': 'module.exports = { testPathIgnorePatterns: ["export"] };\n' })).ok).toBe(false);
  });

  it('the test script of package.json changed blocks; another script does not', async () => {
    expect((await after({ 'package.json': PKG.replace('vitest run', 'true') })).ok).toBe(false);
    expect((await after({ 'package.json': PKG.replace('"tsc"', '"tsc -b"') })).ok).toBe(true);
  });

  it('the pytest section of pyproject.toml changed blocks; another section does not', async () => {
    expect((await after({ 'pyproject.toml': PYPROJECT.replace('-q', '-q --deselect tests/test_export.py') })).ok).toBe(false);
    expect((await after({ 'pyproject.toml': PYPROJECT.replace('"app"', '"app2"') })).ok).toBe(true);
  });

  it('a file that is not frozen passes, a new test included', async () => {
    const r = await after({ 'src/export.ts': 'export const toCsv = (r: string[]) => r.join(",");\n', 'src/other.test.ts': TEST });
    expect(r).toEqual({ check: FREEZE_CHECK, ok: true, summary: '6 frozen files, unchanged since the freeze' });
  });
});

describe('the freeze rule', () => {
  it('reads the harness by name, anywhere in the repository', () => {
    for (const p of ['vitest.config.ts', 'web/vitest.config.mts', 'jest.config.js', 'tsconfig.build.json', 'pkg/package.json', 'pytest.ini', 'a/conftest.py', 'pyproject.toml']) {
      expect(isFrozenHarness(p), p).toBe(true);
    }
    for (const p of ['src/export.test.ts', 'vite.config.ts', 'README.md']) expect(isFrozenHarness(p), p).toBe(false);
  });

  it('an unreadable package.json is fingerprinted whole: it cannot be read, so any change counts', () => {
    expect(fingerprint('package.json', '{oops')).toBe(fingerprint('x', '{oops'));
  });
});
