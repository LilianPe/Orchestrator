import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config, { gitIsolation } from '../vitest.config.js';
import { NO_GLOBAL_CONFIG, NO_USER_FILES } from './helpers/git-isolation.js';

const freshRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-git-isolation-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
};

// ORC-494: a test's git never reads nor writes the workstation's own config or hooks (a `core.hooksPath` there once
// received a Git LFS pre-push hook, and 42 tests of git-workspaces.test.ts failed under it).
describe("the tests' git, apart from the workstation's", () => {
  it("inherits nothing of its caller's git, reads no global nor system config, and cannot write the global one, which no other user can plant", () => {
    expect(Object.keys(process.env).filter((n) => n.startsWith('GIT_')).sort()).toEqual(
      ['GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_VALUE_1'],
    );
    expect({ global: process.env['GIT_CONFIG_GLOBAL'], nosystem: process.env['GIT_CONFIG_NOSYSTEM'] }).toEqual({ global: NO_GLOBAL_CONFIG, nosystem: '1' });
    const dir = freshRepo();
    const origins = execFileSync('git', ['config', '--list', '--show-origin'], { cwd: dir, encoding: 'utf8' });
    expect(origins.split('\n').filter((l) => l && !l.startsWith('file:.git/config'))).toEqual(
      Object.entries(NO_USER_FILES).map(([key, value]) => `command line:\t${key}=${value}`),
    );
    expect(spawnSync('git', ['config', '--global', 'factory.test', 'written'], { cwd: dir }).status).not.toBe(0);
    expect(existsSync(dirname(NO_GLOBAL_CONFIG))).toBe(false);
    expect(statSync(dirname(dirname(NO_GLOBAL_CONFIG))).mode & 0o777).toBe(0o700);
  });

  it("reads neither the workstation's ignore nor its attributes file", () => {
    const xdg = mkdtempSync(join(tmpdir(), 'factory-git-xdg-'));
    mkdirSync(join(xdg, 'git'));
    writeFileSync(join(xdg, 'git', 'ignore'), 'ignored.txt\n');
    writeFileSync(join(xdg, 'git', 'attributes'), '* filter=lfs\n');
    const dir = freshRepo();
    const env = { ...process.env, XDG_CONFIG_HOME: xdg };
    expect(spawnSync('git', ['check-ignore', 'ignored.txt'], { cwd: dir, env }).status).toBe(1);
    expect(execFileSync('git', ['check-attr', 'filter', '--', 'a.txt'], { cwd: dir, env, encoding: 'utf8' })).toBe('a.txt: filter: unspecified\n');
  });

  it("runs a temporary repository's hooks from its own git dir, never from a hooks path of the workstation", () => {
    const dir = freshRepo();
    expect(spawnSync('git', ['config', 'core.hooksPath'], { cwd: dir }).status).toBe(1);
    const hooks = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { cwd: dir, encoding: 'utf8' }).trim();
    expect(realpathSync(hooks)).toBe(realpathSync(join(dir, '.git', 'hooks')));
  });

  it('is set up for every project of the suite, a new one included', () => {
    const projects = (config.test?.projects ?? []) as { test: { name: string; setupFiles?: string[] } }[];
    expect(projects.length).toBeGreaterThan(0);
    expect(projects.filter((p) => !p.test.setupFiles?.includes(gitIsolation)).map((p) => p.test.name)).toEqual([]);
  });
});
