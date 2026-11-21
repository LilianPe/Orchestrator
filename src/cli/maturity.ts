import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { manifestDependencies } from '../checks/deps.js';
import { mainCardValue, type DryRun } from '../core/dry-run.js';
import { MAIN_CARD } from '../core/maturity.js';
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

/** The drivers that mean a Postgres, in Node's dependencies and Python's: not an ORM, which speaks SQLite or MySQL as well. */
const POSTGRES_PACKAGES = ['pg', 'postgres', 'psycopg', 'psycopg2', 'psycopg2-binary', 'asyncpg'];

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/** The images of a Postgres, by their name without registry, owner, tag or digest: the official one and its common variants. */
const POSTGRES_IMAGES = new Set(['postgres', 'postgresql', 'postgis', 'pgvector', 'timescaledb', 'timescaledb-ha']);

/** The image an `image:` names, each variable replaced by its default (`${VAR:-postgres:16}`), or by nothing without one. */
const imageOf = (written: string): string => written.replace(/\$\{\w+(?::?-([^}]*))?\}/g, (_, fallback: string | undefined) => fallback ?? '');

/** Whether a compose file runs a Postgres: an `image:` whose name, its registry and owner, tag and digest put aside, is one. */
const runsPostgres = (compose: string): boolean =>
  [...compose.matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gm)].some((m) => POSTGRES_IMAGES.has(imageOf(m[1]!).split('/').pop()!.split(/[:@]/)[0]!));

/** What the walk never enters: dependencies, builds and dot directories are not the repository's code. */
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'coverage', '__pycache__', 'venv']);

const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/;
const TEST_FILE = /(?:\.(?:test|spec|cy)\.[cm]?[jt]sx?|^test_.*\.py|_test\.py|^tests\.py)$/;
/** A walk stops past this many entries: init stays quick on a large repository, and says so. */
const WALK_LIMIT = 20_000;

/** The names of every dependency of the repository's package.json and pyproject.toml, and the manifests not read in full, with why (ORC-454). */
interface Manifests {
  deps: Set<string>;
  problems: { file: string; problem?: string }[];
}

/**
 * The text of a file the cards read, or why it cannot be read (no read permission; not a regular file, such as a directory or
 * a named pipe, whose read would block init): a problem of the cards, never a failure of init (ORC-454).
 */
function readText(path: string): { text: string } | { problem: string } {
  try {
    if (!statSync(path).isFile()) return { problem: 'cannot be read: not a regular file' };
    return { text: readFileSync(path, 'utf8') };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { problem: `cannot be read: ${code ?? (err instanceof Error ? err.message : String(err))}` };
  }
}

function readManifest(repo: string, file: 'package.json' | 'pyproject.toml'): { file: string; names: string[]; problem?: string } {
  const read = readText(join(repo, file));
  return 'problem' in read ? { file, names: [], problem: read.problem } : { file, ...manifestDependencies(file, read.text) };
}

function dependencies(repo: string): Manifests {
  const read = (['package.json', 'pyproject.toml'] as const)
    .filter((file) => existsSync(join(repo, file)))
    .map((file) => readManifest(repo, file));
  return { deps: new Set(read.flatMap((r) => r.names)), problems: read.filter((r) => r.problem !== undefined) };
}

function stack(repo: string, { deps, problems }: Manifests): string {
  const parts: string[] = [];
  if (existsSync(join(repo, 'package.json'))) {
    const pm = existsSync(join(repo, 'package-lock.json')) ? 'npm' : existsSync(join(repo, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(repo, 'yarn.lock')) ? 'yarn' : 'no lockfile';
    parts.push(`Node (${pm})`);
  }
  if (existsSync(join(repo, 'pyproject.toml'))) parts.push(existsSync(join(repo, 'uv.lock')) ? 'Python (uv)' : 'Python (no uv.lock)');
  if (!parts.length) return 'none detected (no package.json, no pyproject.toml)';
  const front = FRONT_ENDS.find(([pkg]) => deps.has(pkg));
  const found = [...parts, ...(front ? [front[1]] : [])].join(', ');
  return problems.length ? `${found}; ${problems.map((p) => `${p.file} not fully read (${p.problem})`).join('; ')}: Stack, Services and Visual paths may miss some of ${problems.length > 1 ? 'their' : 'its'} dependencies` : found;
}

function commands({ setup, commands, preview }: DetectedChecks): string {
  const lines = [...(setup.length ? [`setup: ${setup.join(' && ')}`] : []), ...Object.entries(commands).map(([name, cmd]) => `${name}: ${cmd}`), ...(preview ? [`preview: ${preview}`] : [])];
  return lines.length ? lines.join('\n') : 'none found: verify would have no check to run';
}

/** A card read from the dependencies, with the manifests not read in full named (ORC-454). */
const withUnread = (value: string, { problems }: Manifests) =>
  problems.length ? `${value}; ${problems.map((p) => p.file).join(' and ')} not fully read (see Stack): a dependency may be missing` : value;

/** A compose file that cannot be read is read as running no Postgres, and named on the card (ORC-454). */
function services(repo: string, manifests: Manifests): string {
  const unread: string[] = [];
  for (const file of COMPOSE_FILES.filter((f) => existsSync(join(repo, f)))) {
    const read = readText(join(repo, file));
    if ('problem' in read) unread.push(`${file} not read (${read.problem}): a Postgres it runs may be missing`);
    else if (runsPostgres(read.text)) return `postgres (${file})`;
  }
  const pkg = POSTGRES_PACKAGES.find((p) => manifests.deps.has(p));
  return withUnread([pkg ? `postgres (dependency ${pkg})` : 'none', ...unread].join('; '), manifests);
}

function visualPaths(repo: string, manifests: Manifests): string {
  const front = FRONT_ENDS.some(([pkg]) => manifests.deps.has(pkg));
  const dirs = front ? VISUAL_DIRS.filter((d) => existsSync(join(repo, d))) : [];
  const value = !front
    ? 'none: no front-end framework detected'
    : dirs.length ? dirs.map((d) => `${d}/**`).join(', ') : 'none: a front end, but none of its usual directories';
  return withUnread(value, manifests);
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
/** Directories that hold tests and their helpers, never an area to test: `TEST_DIRS`, and those of Jest, specs and end-to-end runners. */
const TEST_AREAS = new Set([...TEST_DIRS, '__tests__', 'spec', 'e2e', 'cypress']);

/**
 * The source directories with no test file: those under `src/`, or at the root without one. An area is tested by a test file
 * in it, or in `tests/<area>` (`test/<area>`). Without a source directory, the files of code `src/` (or the root) holds itself
 * are the one area, tested by any test file of the repository. Beside source directories, tests a root `tests/` holds loose
 * are named: they cannot be matched to an area.
 */
function untested(repo: string): string {
  const budget = { left: WALK_LIMIT };
  const root = existsSync(join(repo, 'src')) ? 'src' : '';
  const areas = subdirs(join(repo, root))
    .filter((d) => !TEST_AREAS.has(d))
    .filter((d) => hasSource(join(repo, root, d), budget))
    .map((d) => ({ name: d, path: root ? `${root}/${d}` : d }));
  const own = areas.length ? [] : entries(join(repo, root)).filter((e) => e.isFile() && SOURCE.test(e.name));
  if (!areas.length && !own.length) return 'no source directory found';
  const bare = areas.length
    ? areas.filter((a) => !hasTest(join(repo, a.path), budget) && !TEST_DIRS.some((t) => hasTest(join(repo, t, a.name), budget))).map((a) => a.path)
    : hasTest(repo, budget) ? [] : [`${root || '.'}/ (its own files)`];
  const loose = areas.length ? TEST_DIRS.find((t) => entries(join(repo, t)).some((e) => e.isFile() && TEST_FILE.test(e.name))) : undefined;
  const value = bare.length ? bare.join(', ') : 'none: every source directory has a test file';
  const notes = [...(loose ? [`${loose}/ holds tests not sorted by directory: check those by hand`] : []), ...(budget.left < 0 ? [`stopped after ${WALK_LIMIT} entries: partial`] : [])];
  return [value, ...notes].join('; ');
}

/** The report of one repository, its `main` from its last dry run when the store has one. */
export type MaturityReport = (lastDryRun?: DryRun) => MaturityPoint[];

/**
 * The maturity report of a repository (ORC-410), point by point, each a card a person approves on the dashboard: read from
 * its files only, never by running its code (`main` is the last dry run's, `lastDryRun`, when one is stored).
 */
export function maturityReport(repo: string, detected: DetectedChecks, lastDryRun?: DryRun): MaturityPoint[] {
  const manifests = dependencies(repo);
  return [
    { key: 'stack', title: 'Stack', value: stack(repo, manifests) },
    { key: 'commands', title: 'Commands', value: commands(detected) },
    { key: MAIN_CARD, title: 'main green or red', value: mainCardValue(lastDryRun) },
    { key: 'services', title: 'Services', value: services(repo, manifests) },
    { key: 'visual_paths', title: 'Visual paths', value: visualPaths(repo, manifests) },
    { key: 'untested', title: 'Areas without tests', value: untested(repo) },
  ];
}
