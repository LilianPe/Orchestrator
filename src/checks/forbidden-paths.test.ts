import { describe, expect, it } from 'vitest';
import { checkForbiddenPaths, FORBIDDEN_CHECK, forbiddenPattern, isOutwardLink, repoPatternError, sensitiveMatcher, type ForbiddenView } from './forbidden-paths.js';

const sensitivePattern = (path: string, patterns: readonly string[]) => sensitiveMatcher(patterns)(path);

const view = (changed: ForbiddenView['changed'], base: Record<string, string> = {}, head: Record<string, string> = {}): ForbiddenView => ({
  changed,
  showAtBase: async (p) => base[p],
  showAtHead: async (p) => head[p],
});
const file = (path: string, deleted = false) => ({ path, deleted });

describe('forbiddenPattern', () => {
  it.each([
    ['.github/workflows/ci.yml', '.github/**'],
    ['.github/workflows/deep/ci.yml', '.github/**'],
    ['.github/actions/setup/action.yml', '.github/**'],
    ['.github/dependabot.yml', '.github/**'],
    ['.github/CODEOWNERS', '.github/**'],
    ['CODEOWNERS', 'CODEOWNERS'],
    ['docs/CODEOWNERS', 'CODEOWNERS'],
    ['.env', '.env'],
    ['.env.production', '.env.*'],
    ['apps/web/.env.local', '.env.*'],
    ['.envrc', '.envrc'],
    ['.yarnrc.yml', '.yarnrc*'],
    ['.yarnrc', '.yarnrc*'],
    ['.yarn/releases/yarn-4.cjs', '.yarn/releases/**'],
    ['.yarn/plugins/x.cjs', '.yarn/plugins/**'],
    ['.pnpmfile.cjs', '.pnpmfile.cjs'],
    ['setup.py', 'setup.py'],
    ['packages/lib/setup.py', 'setup.py'],
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
    ['.GitHub/Workflows/ci.yml', '.github/**'],
    ['.\\.factory\\config.yml', '.factory/**'],
  ])('%s is forbidden', (path, pattern) => {
    expect(forbiddenPattern(path)).toBe(pattern);
  });

  it.each(['src/app.ts', 'packages/a/.github/workflows/ci.yml', 'docs/codeowners.md', 'src/environment.ts', '.yarn/cache/x.zip', 'setup.pyc', 'src/claims/model.ts', 'docs/Dockerfile.md.txt.keep/readme', 'mydockerfile', 'src/factory/x.ts', '.npmrc.example', 'a/.factory.ts', 'package.json'])(
    '%s is not',
    (path) => {
      expect(forbiddenPattern(path)).toBeUndefined();
    },
  );

  it.each(['.env', '.env.local', '.env.production', '.env.production.local', 'apps/web/.env.development', '.envrc', '.ENV.Local'])('%s, which holds values a loader reads or runs, is forbidden', (path) => {
    expect(forbiddenPattern(path)).toBeDefined();
  });

  it.each(['.env.example', '.env.sample', '.env.template', 'apps/web/.env.example', '.ENV.EXAMPLE', '.envoy.yaml', 'env.ts'])('%s, a template or another file, is not', (path) => {
    expect(forbiddenPattern(path)).toBeUndefined();
  });

  it.each([
    ['claims/.env.example', 'claims/**'],
    ['.factory/.env.example', '.factory/**'],
    ['.github/workflows/.env.example', '.github/**'],
    ['.claude/.env.sample', '.claude/**'],
    ['.devcontainer/.env.template', '.devcontainer/**'],
  ])('a template under a forbidden directory, %s, stays forbidden by %s', (path, pattern) => {
    expect(forbiddenPattern(path)).toBe(pattern);
  });
});

describe('sensitivePattern', () => {
  it.each([
    ['infra/main.tf', 'infra/**'],
    ['infra/modules/vpc/main.tf', 'infra/**'],
    ['Infra/main.tf', 'infra/**'],
    ['infra/main.tf', 'infra'],
    ['infra/deep/x.tf', 'infra'],
    ['src/auth.ts', 'src/auth*'],
    ['src/authz/policy.ts', 'src/auth*'],
    ['db/schema.sql', 'db/schema*'],
    ['src/auth.ts', 'src/auth.ts'],
    ['.\\infra\\x.tf', 'infra/**'],
    ['migrations/001.sql', '**/migrations/**'],
    ['services/api/migrations/001.sql', '**/migrations/**'],
    ['src/db/q.sql', 'src/**/*.sql'],
    ['src/q.sql', 'src/**/*.sql'],
    ['.config/secrets.yml', '.config'],
    ['deploy/.hidden/x', 'deploy/**'],
    ['infra/main.tf', './infra'],
    ['infra/main.tf', 'infra/'],
  ])('%s is named by %s', (path, pattern) => {
    expect(sensitivePattern(path, [pattern])).toBe(pattern);
  });

  it.each([
    ['infrastructure/x', 'infra'],
    ['apps/infra/x', 'infra/**'],
    ['lib/src/auth.ts', 'src/auth*'],
    ['src/auth.ts.bak', 'src/auth.ts'],
    ['src/db/q.ts', 'src/**/*.sql'],
    ['migrations.md', '**/migrations/**'],
  ])('%s is not named by %s', (path, pattern) => {
    expect(sensitivePattern(path, [pattern])).toBeUndefined();
  });

  it('refuses only what names nothing in the repository: an absolute path, a drive, a climb, the root itself', () => {
    const kept = ['infra', 'src/auth*', '**/migrations/**', 'src/**/*.sql', './infra', 'a/{b,c}/**', 'infra\\modules'];
    expect(kept.map(repoPatternError)).toEqual(kept.map(() => undefined));
    for (const p of ['/infra/**', '\\infra', 'C:/infra', 'C:\\infra', 'a/../b', 'a\\..\\b', '..', '.', './', '', '/']) expect(repoPatternError(p), p).toBeDefined();
  });

  it('reads `\\` as `/`, as the config check does', () => {
    expect(sensitivePattern('infra/modules/x.tf', ['infra\\modules'])).toBe('infra\\modules');
  });

  it('compiles each pattern once for all the paths it is asked about', () => {
    const match = sensitiveMatcher(['infra', 'db/**']);
    expect(['infra/a', 'db/b', 'src/c'].map(match)).toEqual(['infra', 'db/**', undefined]);
  });
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

  it('the repository sensitive paths given (untrusted work) block; without them the same diff passes', async () => {
    const changed = [file('infra/main.tf'), file('src/a.ts')];
    const r = await checkForbiddenPaths({ ...view(changed), sensitive: { patterns: ['infra/**'], changed: new Set(['infra/main.tf', 'src/a.ts']) } });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('`infra/main.tf`: sensitive path of the repository (`infra/**`)');
    expect(r.summary).not.toContain('src/a.ts');
    expect((await checkForbiddenPaths(view(changed))).ok).toBe(true);
  });

  it('a sensitive path changed before the branch took untrusted content passes: only what changed since is refused', async () => {
    const changed = [file('infra/old.tf'), file('infra/new.tf')];
    const r = await checkForbiddenPaths({ ...view(changed), sensitive: { patterns: ['infra'], changed: new Set(['infra/new.tf']) } });
    expect(r.summary).toContain('infra/new.tf');
    expect(r.summary).not.toContain('infra/old.tf');
  });

  it('a path both forbidden and sensitive is named once, as forbidden', async () => {
    const r = await checkForbiddenPaths({ ...view([file('.github/actions/setup/action.yml')]), sensitive: { patterns: ['.github/**'], changed: new Set(['.github/actions/setup/action.yml']) } });
    expect(r.summary.match(/action\.yml/g)).toHaveLength(1);
    expect(r.summary).toContain('forbidden path');
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
