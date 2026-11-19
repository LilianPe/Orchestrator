import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../adapters/graphql-pages.js';
import { pyprojectDependencies } from '../checks/deps.js';
import type { MaturityPoint } from '../store/types.js';

/** What init detected for the repository's `.factory/config.yml`: its install, its checks by name, what starts the application. */
export interface DetectedChecks {
  setup: string[];
  commands: Record<string, string>;
  preview?: string;
}

/** The front-end frameworks, by the package that names them; the first found names the stack. */
const FRONT_ENDS: readonly [string, string][] = [
  ['next', 'Next.js'],
  ['react', 'React'],
  ['vue', 'Vue'],
  ['svelte', 'Svelte'],
  ['@angular/core', 'Angular'],
];

/** Where a front end keeps what it renders, checked in this order: `visual_paths` names those the repository has. */
const VISUAL_DIRS = ['src/components', 'components', 'app', 'src/app', 'pages', 'src/pages', 'web/src'];

/** The packages that mean a Postgres, in Node's dependencies and Python's. */
const POSTGRES_PACKAGES = ['pg', 'postgres', '@prisma/client', 'drizzle-orm', 'psycopg', 'psycopg2', 'psycopg2-binary', 'asyncpg'];

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/** What the walk never enters: dependencies, builds and dot directories are not the repository's code. */
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'coverage', '__pycache__', 'venv']);

const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/;
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|^test_.*\.py|_test\.py)$/;
/** A walk stops past this many entries: init stays quick on a large repository, and says so. */
const WALK_LIMIT = 20_000;

const MAIN_UNCHECKED = 'not checked yet: the dry run (ORC-408) runs setup, build and tests on main';

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isRecord(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The names of every dependency of the repository's package.json and pyproject.toml. */
function dependencies(repo: string): Set<string> {
  const pkg = readJson(join(repo, 'package.json'));
  const node = ['dependencies', 'devDependencies'].flatMap((k) => (pkg && isRecord(pkg[k]) ? Object.keys(pkg[k]) : []));
  const pyproject = existsSync(join(repo, 'pyproject.toml')) ? readFileSync(join(repo, 'pyproject.toml'), 'utf8') : '';
  const python = pyprojectDependencies(pyproject);
  return new Set([...node, ...python]);
}

function stack(repo: string, deps: Set<string>): string {
  const parts: string[] = [];
  if (existsSync(join(repo, 'package.json'))) {
    const pm = existsSync(join(repo, 'package-lock.json')) ? 'npm' : existsSync(join(repo, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(repo, 'yarn.lock')) ? 'yarn' : 'no lockfile';
    parts.push(`Node (${pm})`);
  }
  if (existsSync(join(repo, 'pyproject.toml'))) parts.push(existsSync(join(repo, 'uv.lock')) ? 'Python (uv)' : 'Python (no uv.lock)');
  if (!parts.length) return 'none detected (no package.json, no pyproject.toml)';
  const front = FRONT_ENDS.find(([pkg]) => deps.has(pkg));
  return [...parts, ...(front ? [front[1]] : [])].join(', ');
}

function commands({ setup, commands, preview }: DetectedChecks): string {
  const lines = [...(setup.length ? [`setup: ${setup.join(' && ')}`] : []), ...Object.entries(commands).map(([name, cmd]) => `${name}: ${cmd}`), ...(preview ? [`preview: ${preview}`] : [])];
  return lines.length ? lines.join('\n') : 'none found: verify would have no check to run';
}

function services(repo: string, deps: Set<string>): string {
  const compose = COMPOSE_FILES.find((f) => existsSync(join(repo, f)) && /image:\s*["']?postgres\b/.test(readFileSync(join(repo, f), 'utf8')));
  if (compose) return `postgres (${compose})`;
  const pkg = POSTGRES_PACKAGES.find((p) => deps.has(p));
  return pkg ? `postgres (dependency ${pkg})` : 'none';
}

function visualPaths(repo: string, deps: Set<string>): string {
  if (!FRONT_ENDS.some(([pkg]) => deps.has(pkg))) return 'none: no front-end framework detected';
  const dirs = VISUAL_DIRS.filter((d) => existsSync(join(repo, d)));
  return dirs.length ? dirs.map((d) => `${d}/**`).join(', ') : 'none: a front end, but none of its usual directories';
}

/** The entries of `dir` the walk enters: none when it cannot be read; neither dot entries nor `SKIPPED`. */
function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.') && !SKIPPED.has(e.name));
  } catch {
    return [];
  }
}

/** Walks `dir` for a file `file` matches, or a directory `stop` matches; `budget` counts the entries seen across walks. */
function finds(dir: string, budget: { left: number }, file: RegExp, stop: (name: string) => boolean = () => false): boolean {
  for (const e of entries(dir)) {
    if (--budget.left < 0) return false;
    if (e.isDirectory() ? stop(e.name) || finds(join(dir, e.name), budget, file, stop) : file.test(e.name)) return true;
  }
  return false;
}

const hasTest = (dir: string, budget: { left: number }) => finds(dir, budget, TEST_FILE, (name) => name === '__tests__');
const hasSource = (dir: string, budget: { left: number }) => finds(dir, budget, SOURCE);
const subdirs = (dir: string): string[] => entries(dir).filter((e) => e.isDirectory()).map((e) => e.name);

const TEST_DIRS = ['test', 'tests'];

/**
 * The source directories with no test file: those under `src/`, or at the root without one. An area is tested by a test file
 * in it, or in `tests/<area>` (`test/<area>`). Tests a root `tests/` holds loose are named: they cannot be matched to an area.
 */
function untested(repo: string): string {
  const budget = { left: WALK_LIMIT };
  const root = existsSync(join(repo, 'src')) ? 'src' : '';
  const areas = subdirs(join(repo, root))
    .filter((d) => root || !TEST_DIRS.includes(d))
    .filter((d) => hasSource(join(repo, root, d), budget))
    .map((d) => ({ name: d, path: root ? `${root}/${d}` : d }));
  if (!areas.length) return 'no source directory found';
  const bare = areas.filter((a) => !hasTest(join(repo, a.path), budget) && !TEST_DIRS.some((t) => hasTest(join(repo, t, a.name), budget)));
  const loose = TEST_DIRS.find((t) => entries(join(repo, t)).some((e) => e.isFile() && TEST_FILE.test(e.name)));
  const value = bare.length ? bare.map((a) => a.path).join(', ') : 'none: every source directory has a test file';
  const notes = [...(loose ? [`${loose}/ holds tests not sorted by directory: check those by hand`] : []), ...(budget.left < 0 ? [`stopped after ${WALK_LIMIT} entries: partial`] : [])];
  return [value, ...notes].join('; ');
}

/**
 * The maturity report of a repository (ORC-410), point by point, each a card a person approves on the dashboard: read from
 * its files only, never by running its code (`main` is the dry run's).
 */
export function maturityReport(repo: string, detected: DetectedChecks): MaturityPoint[] {
  const deps = dependencies(repo);
  return [
    { key: 'stack', title: 'Stack', value: stack(repo, deps) },
    { key: 'commands', title: 'Commands', value: commands(detected) },
    { key: 'main', title: 'main green or red', value: MAIN_UNCHECKED },
    { key: 'services', title: 'Services', value: services(repo, deps) },
    { key: 'visual_paths', title: 'Visual paths', value: visualPaths(repo, deps) },
    { key: 'untested', title: 'Areas without tests', value: untested(repo) },
  ];
}
