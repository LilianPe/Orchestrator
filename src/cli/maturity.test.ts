import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyPythonRepo } from '../../test/helpers/python-repo.js';
import type { DryRun } from '../core/dry-run.js';
import { maturityReport } from './maturity.js';

/** A repository of `files`, by path (directories made as needed). */
function repoOf(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), 'factory-maturity-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  return repo;
}

const valueOf = (repo: string, detected = { setup: [] as string[], commands: {} as Record<string, string> }) =>
  Object.fromEntries(maturityReport(repo, detected).map((p) => [p.key, p.value]));

const REACT_APP = {
  'package.json': JSON.stringify({ scripts: { test: 'vitest run', dev: 'vite' }, dependencies: { react: '^18.0.0', pg: '^8.0.0' } }),
  'package-lock.json': '{}',
  'src/components/Button.tsx': 'export {}',
  'src/components/Button.test.tsx': 'test',
  'src/billing/invoice.ts': 'export {}',
  'src/auth/session.ts': 'export {}',
  'src/auth/__tests__/session.ts': 'test',
};

describe('the maturity report (ORC-410)', () => {
  it('reports each point in order: stack, commands, main, services, visual paths, untested areas', () => {
    const repo = repoOf(REACT_APP);
    const report = maturityReport(repo, { setup: ['npm ci'], commands: { test: 'npm test' }, preview: 'npm run dev' });
    expect(report.map((p) => p.key)).toEqual(['stack', 'commands', 'main', 'services', 'visual_paths', 'untested']);
    expect(Object.fromEntries(report.map((p) => [p.key, p.value]))).toEqual({
      stack: 'Node (npm), React',
      commands: 'setup: npm ci\ntest: npm test\npreview: npm run dev',
      main: 'not checked yet: the dry run (ORC-408) runs setup, build and tests on main',
      services: 'postgres (dependency pg)',
      visual_paths: 'src/components/**',
      untested: 'src/billing',
    });
  });

  it('a Python repository: uv, its commands, no front end, its package without tests', () => {
    const repo = mkdtempSync(join(tmpdir(), 'factory-maturity-'));
    copyPythonRepo(repo);
    const v = valueOf(repo, { setup: ['uv sync --frozen'], commands: { pytest: 'uv run --frozen pytest' } });
    expect(v['stack']).toBe('Python (uv)');
    expect(v['commands']).toBe('setup: uv sync --frozen\npytest: uv run --frozen pytest');
    expect(v['visual_paths']).toBe('none: no front-end framework detected');
    expect(v['untested']).toBe('src/app; tests/ holds tests not sorted by directory: check those by hand');
  });

  it("reads Python's dependencies from their lists only, not any quoted string of pyproject.toml", () => {
    const pyproject = (deps: string) => repoOf({ 'pyproject.toml': `[project]\nname = "postgres"\ndescription = "asyncpg"\n${deps}` });
    expect(valueOf(pyproject('dependencies = ["httpx>=0.27"]\n'))['services']).toBe('none');
    expect(valueOf(pyproject('dependencies = [\n  "httpx>=0.27",\n  "asyncpg>=0.29",\n]\n'))['services']).toBe('postgres (dependency asyncpg)');
    expect(valueOf(pyproject('dependencies = []\n[project.optional-dependencies]\ndb = ["psycopg[binary]"]\n'))['services']).toBe('postgres (dependency psycopg)');
    expect(valueOf(pyproject('dependencies = []\n[dependency-groups]\ndev = ["pytest", "psycopg2-binary==2.9"]\n'))['services']).toBe('postgres (dependency psycopg2-binary)');
  });

  it('says what it did not find rather than leaving a point out', () => {
    const v = valueOf(repoOf({ 'README.md': '# x' }));
    expect(v).toEqual({
      stack: 'none detected (no package.json, no pyproject.toml)',
      commands: 'none found: verify would have no check to run',
      main: 'not checked yet: the dry run (ORC-408) runs setup, build and tests on main',
      services: 'none',
      visual_paths: 'none: no front-end framework detected',
      untested: 'no source directory found',
    });
  });

  it('pnpm, Next and a Postgres in docker compose; tests in a tests/ directory named after the area count', () => {
    const v = valueOf(
      repoOf({
        'package.json': JSON.stringify({ dependencies: { next: '15.0.0' } }),
        'pnpm-lock.yaml': '',
        'docker-compose.yml': 'services:\n  db:\n    image: postgres:17-alpine\n',
        'app/page.tsx': 'export {}',
        'src/lib/a.ts': 'export {}',
        'src/api/b.ts': 'export {}',
        'tests/api/b.test.ts': 'test',
        'node_modules/x/index.js': '',
      }),
    );
    expect(v['stack']).toBe('Node (pnpm), Next.js');
    expect(v['services']).toBe('postgres (docker-compose.yml)');
    expect(v['visual_paths']).toBe('app/**');
    expect(v['untested']).toBe('src/lib');
  });

  it('every area tested', () => {
    expect(valueOf(repoOf({ 'src/a/x.ts': '', 'src/a/x.spec.ts': '' }))['untested']).toBe('none: every source directory has a test file');
  });

  it("Node's peer and optional dependencies count as its dependencies", () => {
    const pkg = (deps: Record<string, unknown>) => repoOf({ 'package.json': JSON.stringify(deps) });
    expect(valueOf(pkg({ peerDependencies: { react: '^18.0.0' } }))['stack']).toBe('Node (no lockfile), React');
    expect(valueOf(pkg({ optionalDependencies: { pg: '^8.0.0' } }))['services']).toBe('postgres (dependency pg)');
  });
});

describe('the maturity report: what it must not mistake (ORC-410)', () => {
  it('an ORM that also speaks SQLite or MySQL is no Postgres alone; its driver is', () => {
    const pkg = (deps: Record<string, string>) => repoOf({ 'package.json': JSON.stringify({ dependencies: deps }) });
    expect(valueOf(pkg({ 'drizzle-orm': '1', 'better-sqlite3': '1' }))['services']).toBe('none');
    expect(valueOf(pkg({ '@prisma/client': '1' }))['services']).toBe('none');
    expect(valueOf(pkg({ 'drizzle-orm': '1', postgres: '3' }))['services']).toBe('postgres (dependency postgres)');
  });

  it("Django's tests.py tests its area", () => {
    expect(valueOf(repoOf({ 'shop/models.py': '', 'shop/tests.py': '' }))['untested']).toBe('none: every source directory has a test file');
  });

  it('a directory of tests is no area without tests, under src/ or at the root', () => {
    expect(valueOf(repoOf({ 'src/a/x.ts': '', 'src/a/x.test.ts': '', 'src/__tests__/util.ts': '', 'src/test/helpers.ts': '' }))['untested']).toBe('none: every source directory has a test file');
    expect(valueOf(repoOf({ 'lib/x.ts': '', 'lib/x.test.ts': '', '__tests__/util.ts': '', 'e2e/fixtures.ts': '', 'cypress/support.ts': '', 'spec/helper.py': '' }))['untested']).toBe('none: every source directory has a test file');
  });

  it("files of code with no directory of code are the area: src/'s own, or the root's", () => {
    expect(valueOf(repoOf({ 'src/index.ts': '', 'src/util.ts': '' }))['untested']).toBe('src/ (its own files)');
    expect(valueOf(repoOf({ 'src/index.ts': '', 'src/index.test.ts': '' }))['untested']).toBe('none: every source directory has a test file');
    expect(valueOf(repoOf({ 'pyproject.toml': '[project]\nname = "x"\n', 'app.py': '', 'models.py': '' }))['untested']).toBe('./ (its own files)');
    expect(valueOf(repoOf({ 'app.py': '', 'test_app.py': '' }))['untested']).toBe('none: every source directory has a test file');
  });

  it('files of code with no directory of code are tested by any test file of the repository', () => {
    const none = 'none: every source directory has a test file';
    expect(valueOf(repoOf({ 'src/index.ts': '', '__tests__/index.test.ts': '' }))['untested']).toBe(none);
    expect(valueOf(repoOf({ 'src/index.ts': '', 'spec/index.spec.ts': '' }))['untested']).toBe(none);
    expect(valueOf(repoOf({ 'src/index.ts': '', 'tests/index.test.ts': '' }))['untested']).toBe(none);
    expect(valueOf(repoOf({ 'src/index.ts': '', 'src/__tests__/index.test.ts': '' }))['untested']).toBe(none);
    expect(valueOf(repoOf({ 'src/index.ts': '', 'src/test/index.test.ts': '' }))['untested']).toBe(none);
    expect(valueOf(repoOf({ 'src/index.ts': '', 'test/index.test.ts': '' }))['untested']).toBe(none);
    expect(valueOf(repoOf({ 'app.py': '', 'tests/test_app.py': '' }))['untested']).toBe(none);
    expect(valueOf(repoOf({ 'src/index.ts': '', 'docs/index.md': '', 'scripts/build.sh': '' }))['untested']).toBe('src/ (its own files)');
  });

  it('a Postgres image under a registry, an owner or a variant name is a Postgres; an image named after it is not', () => {
    const compose = (image: string) => repoOf({ 'compose.yaml': `services:\n  db:\n    image: ${image}\n` });
    for (const image of ['pgvector/pgvector:pg16', 'postgis/postgis:16-3.4', 'docker.io/library/postgres:16', 'bitnami/postgresql:16', 'timescale/timescaledb:latest-pg16', '"postgres"', 'postgres@sha256:abc'])
      expect(valueOf(compose(image))['services'], image).toBe('postgres (compose.yaml)');
    for (const image of ['prometheuscommunity/postgres-exporter:v0.15', 'postgres-backup:1', 'redis:7']) expect(valueOf(compose(image))['services'], image).toBe('none');
  });

  it('a Postgres image as the default of a variable, or the timescaledb-ha variant, is a Postgres; a variable alone is not (ORC-454)', () => {
    const compose = (image: string) => repoOf({ 'compose.yaml': `services:\n  db:\n    image: ${image}\n` });
    for (const image of ['${PG_IMAGE:-postgres:16}', '"${PG_IMAGE-postgis/postgis:16-3.4}"', 'timescale/timescaledb-ha:pg16', '${REGISTRY}/postgres:16', '${REGISTRY:-docker.io}/library/postgres:16'])
      expect(valueOf(compose(image))['services'], image).toBe('postgres (compose.yaml)');
    for (const image of ['${PG_IMAGE}', '${PG_IMAGE:?set it}', '${REDIS:-redis:7}']) expect(valueOf(compose(image))['services'], image).toBe('none');
  });

  it("Cypress's specs test their area (ORC-454)", () => {
    expect(valueOf(repoOf({ 'src/login/form.ts': '', 'src/login/form.cy.ts': '', 'src/cart/cart.tsx': '', 'src/cart/cart.cy.jsx': '' }))['untested']).toBe('none: every source directory has a test file');
  });
});

describe('the maturity report on what it reads only in part (ORC-454)', () => {
  it('a malformed entry of package.json is said on Stack, Services and Visual paths, the dependencies read before it kept', () => {
    const v = valueOf(repoOf({ 'package.json': JSON.stringify({ dependencies: { react: '^18.0.0', pg: 8 } }), 'package-lock.json': '{}' }));
    expect(v['stack']).toBe('Node (npm), React; package.json not fully read (the version of "pg" in "dependencies" is not a string): Stack, Services and Visual paths may miss some of its dependencies');
    expect(v['services']).toBe('none; package.json not fully read (see Stack): a dependency may be missing');
    expect(v['visual_paths']).toBe('none: a front end, but none of its usual directories; package.json not fully read (see Stack): a dependency may be missing');
  });

  it('a Postgres a compose file runs needs no dependency: Services says nothing of the manifest not fully read', () => {
    const v = valueOf(repoOf({ 'package.json': '{', 'compose.yaml': 'services:\n  db:\n    image: postgres:16\n' }));
    expect(v['services']).toBe('postgres (compose.yaml)');
    expect(v['visual_paths']).toBe('none: no front-end framework detected; package.json not fully read (see Stack): a dependency may be missing');
  });

  it('a package.json that does not parse, a pyproject.toml either: each said, neither read as no dependency', () => {
    const v = valueOf(repoOf({ 'package.json': '{ "dependencies": ', 'pyproject.toml': '[project\n', 'uv.lock': '' }));
    expect(v['stack']).toMatch(/^Node \(no lockfile\), Python \(uv\); package\.json not fully read \(invalid JSON .*\); pyproject\.toml not fully read \(unreadable TOML .*\): Stack, Services and Visual paths may miss some of their dependencies$/);
  });

  it('a reader that fails otherwise than on a malformed entry is said too, never stops the report', () => {
    const deep = '{"overrides":' + '{"a":'.repeat(20_000) + '"1"' + '}'.repeat(20_001);
    expect(valueOf(repoOf({ 'package.json': deep }))['stack']).toMatch(/^Node \(no lockfile\); package\.json not fully read \(.+\): Stack, Services and Visual paths may miss some of its dependencies$/);
  });

  it('a package.json that cannot be read (a directory) is said on the cards, never stops the report; pyproject.toml still read', () => {
    const v = valueOf(repoOf({ 'package.json/index.js': '', 'pyproject.toml': '[project]\ndependencies = ["psycopg>=3"]\n' }));
    expect(v['stack']).toBe('Node (no lockfile), Python (no uv.lock); package.json not fully read (cannot be read: not a regular file): Stack, Services and Visual paths may miss some of its dependencies');
    expect(v['services']).toBe('postgres (dependency psycopg); package.json not fully read (see Stack): a dependency may be missing');
  });

  it('a compose file that cannot be read (a directory) is said on the Services card, never stops the report; the next compose file still read', () => {
    expect(valueOf(repoOf({ 'docker-compose.yml/x': '' }))['services']).toBe('none; docker-compose.yml not read (cannot be read: not a regular file): a Postgres it runs may be missing');
    expect(valueOf(repoOf({ 'docker-compose.yml/x': '', 'compose.yaml': 'services:\n  db:\n    image: postgres:16\n' }))['services']).toBe('postgres (compose.yaml)');
  });

  it('a compose file or a manifest that is a named pipe is said on the cards, never read: the report does not hang', () => {
    const repo = repoOf({});
    for (const file of ['docker-compose.yml', 'package.json']) execFileSync('mkfifo', [join(repo, file)]);
    const v = valueOf(repo);
    expect(v['services']).toBe('none; docker-compose.yml not read (cannot be read: not a regular file): a Postgres it runs may be missing; package.json not fully read (see Stack): a dependency may be missing');
    expect(v['stack']).toBe('Node (no lockfile); package.json not fully read (cannot be read: not a regular file): Stack, Services and Visual paths may miss some of its dependencies');
  });

  it('well-formed manifests add nothing to the cards', () => {
    const v = valueOf(repoOf({ 'package.json': JSON.stringify({ dependencies: { vue: '3' } }), 'package-lock.json': '{}' }));
    expect([v['stack'], v['services'], v['visual_paths']]).toEqual(['Node (npm), Vue', 'none', 'none: a front end, but none of its usual directories']);
  });
});

describe('the main card from the last dry run (ORC-410, ORC-408)', () => {
  const run = (o: Partial<DryRun>): DryRun => ({
    id: 'dry-1',
    projectId: 'acme',
    sha: '0123456789abcdef0123',
    target: 'main',
    ok: true,
    fingerprint: { setup: 's', image: 'i', lockfiles: {}, config: null, hash: 'h' },
    breaks: [],
    commands: ['npm test'],
    startedAt: Date.UTC(2026, 10, 20, 14, 0),
    endedAt: Date.UTC(2026, 10, 20, 14, 3),
    ...o,
  });
  const mainOf = (dry: DryRun) => maturityReport(repoOf({ 'README.md': '# x' }), { setup: [], commands: {} }, dry).find((p) => p.key === 'main')!.value;

  it('green: the commit and when it ended', () => {
    expect(mainOf(run({}))).toBe('green: the dry run of 0123456789ab on 2026-11-20 14:03 UTC (npm test)');
  });

  it('red with no break recorded says so', () => {
    expect(mainOf(run({ ok: false }))).toBe('red: the dry run of 0123456789ab on 2026-11-20 14:03 UTC: no break recorded\nfix it on main, then factory dry-run acme');
  });

  it('red: what breaks, each kind and command once, and how to run it again', () => {
    const output = '';
    const red = run({
      ok: false,
      breaks: [
        { kind: 'dependency', step: 'setup', command: 'npm ci', detail: 'E404', output },
        { kind: 'failure', step: 'command', command: 'npm test', detail: '2 failed', output },
        { kind: 'failure', step: 'command', command: 'npm test', detail: 'again', output },
      ],
    });
    expect(mainOf(red)).toBe(
      'red: the dry run of 0123456789ab on 2026-11-20 14:03 UTC: dependency in `npm ci`, failure in `npm test`\nfix it on main, then factory dry-run acme',
    );
  });
});
