import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../vitest.config.js';

const SETUP = 'test/helpers/git-isolation.ts';

// ORC-494: a test's git never reads nor writes the workstation's own config or hooks (a `core.hooksPath` there once
// received a Git LFS pre-push hook, and 42 tests of git-workspaces.test.ts failed under it).
describe("the tests' git, apart from the workstation's", () => {
  it('reads no global nor system config, and cannot write the global one', () => {
    expect({ global: process.env['GIT_CONFIG_GLOBAL'], nosystem: process.env['GIT_CONFIG_NOSYSTEM'] }).toEqual({ global: devNull, nosystem: '1' });
    expect(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'].filter((n) => n in process.env)).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'factory-git-isolation-'));
    execFileSync('git', ['init', '-q', dir]);
    const origins = execFileSync('git', ['config', '--list', '--show-origin'], { cwd: dir, encoding: 'utf8' });
    expect(origins.split('\n').filter((l) => l && !l.startsWith('file:.git/config'))).toEqual([]);
    expect(spawnSync('git', ['config', '--global', 'factory.test', 'written'], { cwd: dir }).status).not.toBe(0);
  });

  it("runs a temporary repository's hooks from its own git dir, never from a hooks path of the workstation", () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-git-isolation-'));
    execFileSync('git', ['init', '-q', dir]);
    expect(spawnSync('git', ['config', 'core.hooksPath'], { cwd: dir }).status).toBe(1);
    const hooks = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { cwd: dir, encoding: 'utf8' }).trim();
    expect(realpathSync(hooks)).toBe(realpathSync(join(dir, '.git', 'hooks')));
  });

  it('is set up for every project of the suite, a new one included', () => {
    const projects = (config.test?.projects ?? []) as { test: { name: string; setupFiles?: string[] } }[];
    expect(projects.length).toBeGreaterThan(0);
    expect(projects.filter((p) => !p.test.setupFiles?.includes(SETUP)).map((p) => p.test.name)).toEqual([]);
  });
});
