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
