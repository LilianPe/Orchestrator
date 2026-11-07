import { describe, expect, it } from 'vitest';
import { checkForbiddenPaths, FORBIDDEN_CHECK, forbiddenPattern, isOutwardLink, type ForbiddenView } from './forbidden-paths.js';

const view = (changed: ForbiddenView['changed'], base: Record<string, string> = {}, head: Record<string, string> = {}): ForbiddenView => ({
  changed,
  showAtBase: async (p) => base[p],
  showAtHead: async (p) => head[p],
});
const file = (path: string, deleted = false) => ({ path, deleted });

describe('forbiddenPattern', () => {
  it.each([
    ['.github/workflows/ci.yml', '.github/workflows/**'],
    ['.github/workflows/deep/ci.yml', '.github/workflows/**'],
    ['.factory/config.yml', '.factory/**'],
    ['.claude/settings.json', '.claude/**'],
    ['packages/app/.claude/settings.json', '.claude/**'],
    ['.gitattributes', '.gitattributes'],
    ['src/.gitattributes', '.gitattributes'],
    ['.gitmodules', '.gitmodules'],
    ['.npmrc', '.npmrc'],
    ['packages/app/.npmrc', '.npmrc'],
    ['.husky/pre-commit', '.husky/**'],
    ['.vscode/tasks.json', '.vscode/**'],
    ['Dockerfile', 'Dockerfile*'],
    ['Dockerfile.prod', 'Dockerfile*'],
    ['services/api/Dockerfile', 'Dockerfile*'],
    ['.devcontainer/devcontainer.json', '.devcontainer/**'],
    ['claims/facts.md', 'claims/**'],
    ['.GitHub/Workflows/ci.yml', '.github/workflows/**'],
    ['.\\.factory\\config.yml', '.factory/**'],
  ])('%s is forbidden', (path, pattern) => {
    expect(forbiddenPattern(path)).toBe(pattern);
  });

  it.each(['src/app.ts', '.github/CODEOWNERS', 'src/claims/model.ts', 'docs/Dockerfile.md.txt.keep/readme', 'mydockerfile', 'src/factory/x.ts', '.npmrc.example', 'a/.factory.ts', 'package.json'])(
    '%s is not',
    (path) => {
      expect(forbiddenPattern(path)).toBeUndefined();
    },
  );
});

describe('isOutwardLink', () => {
  it.each([
    ['link', '/etc/passwd'],
    ['link', '../outside'],
    ['a/link', '../../outside'],
    ['a/link', '../b/../../outside'],
    ['link', 'C:\\Windows'],
    ['link', '..'],
  ])('%s -> %s leaves the tree', (path, target) => {
    expect(isOutwardLink(path, target)).toBe(true);
  });

  it.each([
    ['link', 'file'],
    ['a/link', '../file'],
    ['a/b/link', '../../c'],
    ['link', './a/../b'],
  ])('%s -> %s stays in it', (path, target) => {
    expect(isOutwardLink(path, target)).toBe(false);
  });
});

describe('factory/chemins-interdits', () => {
  it('passes a diff that touches nothing forbidden', async () => {
    expect(await checkForbiddenPaths(view([file('src/a.ts'), file('test/a.test.ts', true)]))).toMatchObject({ check: FORBIDDEN_CHECK, ok: true });
  });

  it('names each forbidden path, deleted ones too', async () => {
    const r = await checkForbiddenPaths(view([file('.factory/config.yml'), file('.github/workflows/ci.yml', true), file('src/a.ts')]));
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('.factory/config.yml');
    expect(r.summary).toContain('.github/workflows/ci.yml');
    expect(r.summary).not.toContain('src/a.ts');
  });

  it('an outward symbolic link blocks, an inward one does not', async () => {
    expect((await checkForbiddenPaths(view([{ path: 'x', deleted: false, link: '/etc/passwd' }]))).summary).toContain('symbolic link pointing outside');
    expect((await checkForbiddenPaths(view([{ path: 'x', deleted: false, link: 'src/a.ts' }]))).ok).toBe(true);
  });

  describe('package.json#scripts', () => {
    const scripts = (s: Record<string, string>) => JSON.stringify({ name: 'a', scripts: s });

    it('a change of scripts blocks, at any depth', async () => {
      const path = 'packages/a/package.json';
      const r = await checkForbiddenPaths(view([file(path)], { [path]: scripts({ test: 'vitest' }) }, { [path]: scripts({ test: 'true' }) }));
      expect(r.ok).toBe(false);
      expect(r.summary).toContain('package.json#scripts');
    });

    it('the rest of the manifest is free', async () => {
      const path = 'package.json';
      const r = await checkForbiddenPaths(view([file(path)], { [path]: scripts({ test: 'vitest' }) }, { [path]: JSON.stringify({ name: 'b', dependencies: { x: '1' }, scripts: { test: 'vitest' } }) }));
      expect(r.ok).toBe(true);
    });

    it('a new manifest with scripts, one deleted with its scripts, and one that no longer parses all block', async () => {
      const path = 'package.json';
      expect((await checkForbiddenPaths(view([file(path)], {}, { [path]: scripts({ postinstall: 'x' }) }))).ok).toBe(false);
      expect((await checkForbiddenPaths(view([file(path, true)], { [path]: scripts({ test: 'x' }) }))).ok).toBe(false);
      expect((await checkForbiddenPaths(view([file(path)], { [path]: scripts({ test: 'x' }) }, { [path]: '{ broken' }))).ok).toBe(false);
    });

    it('a new manifest without scripts passes', async () => {
      expect((await checkForbiddenPaths(view([file('package.json')], {}, { 'package.json': '{"name":"a"}' }))).ok).toBe(true);
    });
  });
});
