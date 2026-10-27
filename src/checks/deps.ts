import { posix } from 'node:path';
import type { Ecosystem, PackageRegistry, RegistryLookup } from './registry.js';
import { parseToml, type TomlTable, type TomlValue } from './toml.js';

/**
 * `factory/dependances`: blocks a change that adds a package missing from its registry, or one
 * outside the repository's allow-list (models invent packages).
 *
 * Input is the before/after content of each changed manifest, not a unified diff: a hunk of
 * `package.json` or `pyproject.toml` does not say which section it is in, while both versions of
 * the file are at hand in a clone at the verified sha (`git show <base>:<path>`). "Added" is per
 * ecosystem: a name declared in some manifest after the change and in none before it (for a git,
 * URL or path source: that name with that source). A version bump, a move between sections or
 * files, or a removal adds nothing. Lockfiles are not read: they also list transitive packages, and
 * an install from a lockfile that a manifest does not reference does not add a direct dependency.
 *
 * Fail-closed: a manifest that cannot be read, a registry that does not answer, a source that is
 * not the registry (git, URL, a path outside the repository), an added installer directive the
 * check cannot follow (another index, an include it does not read, dependencies computed at build
 * time) and a changed install configuration file it does not read all block, each with its reason.
 * A local source (workspace, path inside the repository) is code of the repository: listed as
 * added, not blocking.
 */
export const DEPENDENCY_CHECK = 'factory/dependances';

export interface ManifestChange {
  path: string;
  /** `null`: the file is new. */
  before: string | null;
  /** `null`: the file is deleted. */
  after: string | null;
}

/**
 * Names allowed per ecosystem: npm as written (`@scope/name`), PyPI compared after PEP 503
 * normalisation. No list, or no list for an ecosystem, allows nothing there: the repository
 * configuration can only tighten the check, never turn it off.
 */
export interface AllowList {
  npm?: string[];
  pypi?: string[];
}

export type DependencySource = 'registry' | 'local' | 'remote';

export interface AddedDependency {
  ecosystem: Ecosystem;
  /** Registry name: npm as written (an alias `npm:<target>` gives the target), PyPI normalised. */
  name: string;
  /** Name as the manifest declares it. */
  declared: string;
  /** Version range or source, as written. */
  spec: string;
  source: DependencySource;
  /** First manifest that declares it. */
  manifest: string;
}

export type FindingReason =
  | 'not_found'
  | 'not_allowed'
  | 'registry_unknown'
  | 'non_registry_source'
  | 'invalid_name'
  | 'unreadable_manifest'
  | 'unchecked_directive'
  | 'unsupported_manifest';

export interface DependencyFinding {
  reason: FindingReason;
  manifest: string;
  ecosystem?: Ecosystem;
  name?: string;
  message: string;
}

/** `check`, `ok` and `summary` are the shape of every factory check result (`CheckResult`, ORC-158). */
export interface DependencyCheckResult {
  check: typeof DEPENDENCY_CHECK;
  ok: boolean;
  /** Check run output summary, in French: what passed, or what blocks. */
  summary: string;
  /** Every finding blocks. */
  findings: DependencyFinding[];
  /** Every added dependency, blocking or not, for the security journal (ORC-223). */
  added: AddedDependency[];
}

/** `unsupported`: a file that steers installs but that the check does not read; changing it blocks. */
export type ManifestKind = 'package.json' | 'pyproject.toml' | 'requirements' | 'unsupported';

const UNSUPPORTED_FILES = new Set([
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'pip.conf',
  'pip.ini',
  'uv.toml',
  'poetry.toml',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pnpmfile.cjs',
  'pnpm-workspace.yaml',
]);

const toPosix = (path: string): string => path.replace(/\\/g, '/');

/**
 * The files the check reads, by name: `package.json`, `pyproject.toml`, and as requirements files
 * `*requirements*`, `constraints*` and `requirements/*` ending in `.txt` or `.in`; and those it does
 * not read but blocks on when they change (`setup.py`, `Pipfile`, `.npmrc`, `uv.toml`…).
 */
export function manifestKind(path: string): ManifestKind | undefined {
  const p = toPosix(path);
  const base = posix.basename(p);
  if (base === 'package.json') return 'package.json';
  if (base === 'pyproject.toml') return 'pyproject.toml';
  if (/\.(txt|in)$/.test(base) && (base.includes('requirements') || base.startsWith('constraints') || posix.basename(posix.dirname(p)) === 'requirements')) {
    return 'requirements';
  }
  if (UNSUPPORTED_FILES.has(base)) return 'unsupported';
  return undefined;
}

/** PEP 503. */
export const normalizePypiName = (name: string): string => name.replace(/[-_.]+/g, '-').toLowerCase();

const NPM_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;
export const isValidNpmName = (name: string): boolean => name.length > 0 && name.length <= 214 && NPM_NAME.test(name);

interface Declared {
  ecosystem: Ecosystem;
  name: string;
  declared: string;
  spec: string;
  source: DependencySource;
}

/** What one manifest declares: dependencies, and installer directives the check cannot follow. */
interface Manifest {
  path: string;
  deps: Declared[];
  directives: string[];
}

class ManifestError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A path relative to the manifest that stays inside the repository is local: its code is in the
 * diff. Any other path (absolute, home, drive, escaping the repository) or a URL is not: remote.
 */
function pathSource(manifest: string, path: string): DependencySource {
  const p = toPosix(path.trim());
  if (/^(\/|~|[A-Za-z]:)/.test(p) || /^[a-z][a-z0-9+.-]+:/i.test(p)) return 'remote';
  const resolved = posix.normalize(posix.join(posix.dirname(toPosix(manifest)), p));
  return resolved === '..' || resolved.startsWith('../') ? 'remote' : 'local';
}

/** Source of a path, or of a `file:` (npm also `link:`, `portal:`) URL: `file:///abs` and `file://host/…` are absolute. */
function fileSource(manifest: string, s: string): DependencySource {
  const m = /^(?:file|link|portal):(\/\/[^/]*)?(.*)$/i.exec(s);
  if (!m) return pathSource(manifest, s);
  return m[1] !== undefined && m[1] !== '//' ? 'remote' : pathSource(manifest, m[2]!);
}

// ---------------------------------------------------------------- npm

const NPM_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

function npmDeclared(manifest: string, declared: string, spec: string): Declared {
  const s = spec.trim();
  const base = { ecosystem: 'npm' as const, name: declared, declared, spec };
  if (s.startsWith('npm:')) {
    const target = s.slice(4);
    const at = target.indexOf('@', 1);
    return { ...base, name: at === -1 ? target : target.slice(0, at), source: 'registry' };
  }
  if (s.startsWith('workspace:')) return { ...base, source: 'local' };
  if (/^(?:file|link|portal):/i.test(s) || /^(\.{1,2}(\/|$)|\/|~\/)/.test(s)) return { ...base, source: fileSource(manifest, s) };
  // git, tarball URL, hosted shortcuts, other protocols and the `user/repo` shorthand (a version range never contains `/`).
  if (/^[a-z+]+:/i.test(s) || s.includes('/')) return { ...base, source: 'remote' };
  return { ...base, source: 'registry' };
}

/** Package an override targets: `a>b@1` (pnpm), `**\/a/b` (yarn), `a@1` → `b`, `b`, `a`. */
function overrideTarget(key: string): string {
  const segments = (key.split('>').pop() ?? key).trim().replace(/^\*\*\//, '').split('/');
  const last = segments.length > 1 && segments.at(-2)!.startsWith('@') ? segments.slice(-2).join('/') : segments.at(-1)!;
  return last.replace(/(.)@.*$/, '$1');
}

/**
 * npm `overrides`, yarn `resolutions`, pnpm `pnpm.overrides`: they can swap any package of the tree
 * for another one (`npm:` alias) or for a git, URL or path source. A plain version range keeps the
 * package the tree already resolves, and `$name` reuses a direct dependency's range: nothing added.
 */
function npmOverrides(m: Manifest, v: unknown, where: string, parent?: string): void {
  if (v === undefined) return;
  if (!isRecord(v)) throw new ManifestError(`« ${where} » n'est pas un objet`);
  for (const [key, spec] of Object.entries(v)) {
    const path = key === '.' ? (parent ?? key) : parent ? `${parent} > ${key}` : key;
    if (isRecord(spec)) {
      npmOverrides(m, spec, where, path);
      continue;
    }
    if (typeof spec !== 'string') throw new ManifestError(`« ${where} » : la valeur de « ${path} » n'est pas une chaîne`);
    if (spec.startsWith('$')) continue;
    const d = npmDeclared(m.path, overrideTarget(path), spec);
    if (d.source === 'registry' && !spec.trim().startsWith('npm:')) continue;
    m.deps.push({ ...d, declared: `${where} ${path}` });
  }
}

function readPackageJson(m: Manifest, text: string): void {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ManifestError(`JSON invalide (${(err as Error).message})`);
  }
  if (!isRecord(json)) throw new ManifestError("ce n'est pas un objet JSON");
  for (const section of NPM_SECTIONS) {
    const deps = json[section];
    if (deps === undefined) continue;
    if (!isRecord(deps)) throw new ManifestError(`« ${section} » n'est pas un objet`);
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string') throw new ManifestError(`la version de « ${name} » dans « ${section} » n'est pas une chaîne`);
      m.deps.push(npmDeclared(m.path, name, spec));
    }
  }
  npmOverrides(m, json.overrides, 'overrides');
  npmOverrides(m, json.resolutions, 'resolutions');
  if (isRecord(json.pnpm)) npmOverrides(m, json.pnpm.overrides, 'pnpm.overrides');
}

// ---------------------------------------------------------------- PyPI

const PEP508 = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*(.*)$/s;
const isPathSpec = (s: string): boolean => /^(\.{1,2}([/\\]|$)|[/\\]|~|[A-Za-z]:[/\\]|file:)/i.test(s);

function pypiDeclared(declared: string, spec: string, source: DependencySource): Declared {
  return { ecosystem: 'pypi', name: normalizePypiName(declared), declared, spec, source };
}

/** One PEP 508 requirement, or a bare URL or path as `pip` accepts them in a requirements file. */
function readRequirement(m: Manifest, text: string, where: string): Declared {
  const req = text.trim();
  // A path is not a package name: kept as written.
  if (isPathSpec(req)) return { ...pypiDeclared(req, req, fileSource(m.path, req)), name: req };
  const pep = PEP508.exec(req);
  const rest = pep?.[2]!.trim() ?? '';
  if (pep && rest.startsWith('@')) {
    const url = rest.slice(1).trim().split(/\s|;/)[0] ?? '';
    return pypiDeclared(pep[1]!, rest, isPathSpec(url) ? fileSource(m.path, url) : 'remote');
  }
  if (pep && (rest === '' || /^[<>=!~(;,]/.test(rest))) return pypiDeclared(pep[1]!, rest, 'registry');
  if (req.includes('://') || /^git\+/.test(req)) {
    const egg = /[#&]egg=([A-Za-z0-9._-]+)/.exec(req);
    return egg ? pypiDeclared(egg[1]!, req, 'remote') : { ...pypiDeclared(req, req, 'remote'), name: req };
  }
  throw new ManifestError(`${where} : exigence illisible « ${req} »`);
}

const SHORT_OPTIONS: Record<string, string> = { '-r': '--requirement', '-c': '--constraint', '-e': '--editable', '-i': '--index-url', '-f': '--find-links' };
/** Options that change neither which packages are installed nor where they come from. */
const HARMLESS_OPTIONS = new Set(['--pre', '--prefer-binary', '--require-hashes', '--no-binary', '--only-binary', '--no-index', '--use-feature']);

/** `-r file`, `-rfile`, `--requirement=file` → `['--requirement', 'file']`. */
function splitOption(line: string): [string, string] {
  if (line.startsWith('--')) {
    const m = /^(--[^\s=]+)\s*=?\s*(.*)$/.exec(line)!;
    return [m[1]!, m[2]!];
  }
  const short = line.slice(0, 2);
  return [SHORT_OPTIONS[short] ?? short, line.slice(2).replace(/^\s*=?\s*/, '')];
}

/** An include the check reads anyway: a requirements file of the repository, checked when it changes. */
const isReadInclude = (manifest: string, file: string): boolean =>
  pathSource(manifest, file) === 'local' && manifestKind(posix.join(posix.dirname(toPosix(manifest)), toPosix(file))) === 'requirements';

function readRequirements(m: Manifest, text: string): void {
  const lines = text.replace(/\r\n/g, '\n').replace(/\\\n/g, ' ').split('\n');
  lines.forEach((raw, n) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (line === '') return;
    const where = `ligne ${n + 1}`;
    if (!line.startsWith('-')) {
      // Per-requirement options (`--hash=…`) follow the requirement.
      m.deps.push(readRequirement(m, line.split(/\s+--?[a-z]/i)[0]!, where));
      return;
    }
    const [option, value] = splitOption(line);
    if (option === '--editable') m.deps.push(readRequirement(m, value, where));
    else if (HARMLESS_OPTIONS.has(option)) return;
    else if ((option === '--requirement' || option === '--constraint') && isReadInclude(m.path, value)) return;
    // Index and find-links options, includes of files the check does not read, anything else.
    else m.directives.push(`${option} ${value}`.trim());
  });
}

const asTable = (v: TomlValue | undefined): TomlTable | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v : undefined;
const at = (t: TomlTable | undefined, dotted: string): TomlValue | undefined =>
  dotted.split('.').reduce<TomlValue | undefined>((v, k) => asTable(v)?.[k], t);

function requirementList(m: Manifest, v: TomlValue | undefined, where: string, tablesAllowed = false): void {
  if (v === undefined) return;
  if (!Array.isArray(v)) throw new ManifestError(`« ${where} » n'est pas une liste`);
  for (const item of v) {
    if (typeof item === 'string') m.deps.push(readRequirement(m, item, where));
    // PEP 735: `{ include-group = "…" }` names another group of the same file.
    else if (!(tablesAllowed && asTable(item))) throw new ManifestError(`« ${where} » contient autre chose que des exigences`);
  }
}

function requirementTables(m: Manifest, v: TomlValue | undefined, where: string, tablesAllowed = false): void {
  if (v === undefined) return;
  const t = asTable(v);
  if (!t) throw new ManifestError(`« ${where} » n'est pas une table`);
  for (const [k, list] of Object.entries(t)) requirementList(m, list, `${where}.${k}`, tablesAllowed);
}

/**
 * Source of a Poetry dependency table or uv source, alone or as a list (one per marker): remote as
 * soon as one names a git repository, a URL, another index or a path outside the repository; local
 * when all name a path or workspace; the registry otherwise.
 */
function tablesSource(manifest: string, spec: TomlValue, remoteKeys: readonly string[]): DependencySource {
  const tables = (Array.isArray(spec) ? spec : [spec]).map(asTable);
  if (tables.length === 0 || tables.some((t) => t === undefined)) throw new ManifestError('source de dépendance illisible');
  const ts = tables as TomlTable[];
  const outside = (t: TomlTable): boolean => 'path' in t && (typeof t.path !== 'string' || pathSource(manifest, t.path) === 'remote');
  if (ts.some((t) => remoteKeys.some((k) => k in t) || outside(t))) return 'remote';
  return ts.every((t) => 'path' in t || 'workspace' in t) ? 'local' : 'registry';
}

const POETRY_REMOTE = ['git', 'url', 'source'] as const;
const UV_REMOTE = ['git', 'url', 'index'] as const;

function poetryTable(m: Manifest, v: TomlValue | undefined, where: string): void {
  if (v === undefined) return;
  const t = asTable(v);
  if (!t) throw new ManifestError(`« ${where} » n'est pas une table`);
  for (const [name, spec] of Object.entries(t)) {
    if (name.toLowerCase() === 'python') continue;
    if (typeof spec === 'string') m.deps.push(pypiDeclared(name, spec, 'registry'));
    else m.deps.push(pypiDeclared(name, JSON.stringify(spec), tablesSource(m.path, spec, POETRY_REMOTE)));
  }
}

const PYPROJECT_LISTS = [
  'build-system.requires',
  'project.dependencies',
  'tool.uv.dev-dependencies',
  'tool.uv.constraint-dependencies',
  'tool.uv.override-dependencies',
  'tool.uv.build-constraint-dependencies',
];
const PYPROJECT_TABLES = ['project.optional-dependencies', 'tool.pdm.dev-dependencies'];
/** Package indexes other than PyPI: any such setting blocks when it is added or changed. */
const PYPROJECT_INDEXES = ['tool.uv.index', 'tool.uv.index-url', 'tool.uv.extra-index-url', 'tool.uv.find-links', 'tool.uv.pip', 'tool.poetry.source', 'tool.pdm.source'];

function readPyproject(m: Manifest, text: string): void {
  let doc: TomlTable;
  try {
    doc = parseToml(text);
  } catch (err) {
    throw new ManifestError(`TOML illisible (${(err as Error).message})`);
  }
  for (const where of PYPROJECT_LISTS) requirementList(m, at(doc, where), where);
  for (const where of PYPROJECT_TABLES) requirementTables(m, at(doc, where), where);
  requirementTables(m, at(doc, 'dependency-groups'), 'dependency-groups', true);
  for (const [env, t] of Object.entries(asTable(at(doc, 'tool.hatch.envs')) ?? {})) {
    for (const k of ['dependencies', 'extra-dependencies']) requirementList(m, at(asTable(t), k), `tool.hatch.envs.${env}.${k}`);
  }
  poetryTable(m, at(doc, 'tool.poetry.dependencies'), 'tool.poetry.dependencies');
  poetryTable(m, at(doc, 'tool.poetry.dev-dependencies'), 'tool.poetry.dev-dependencies');
  for (const [g, group] of Object.entries(asTable(at(doc, 'tool.poetry.group')) ?? {})) {
    poetryTable(m, at(asTable(group), 'dependencies'), `tool.poetry.group.${g}.dependencies`);
  }
  // Dependencies computed at build time (setuptools `dynamic`, Hatch hooks) are not in the file.
  const dynamic = at(doc, 'project.dynamic');
  for (const field of Array.isArray(dynamic) ? dynamic : []) {
    if (field === 'dependencies' || field === 'optional-dependencies') m.directives.push(`project.dynamic: ${field}`);
  }
  for (const where of PYPROJECT_INDEXES) {
    const v = at(doc, where);
    if (v !== undefined) m.directives.push(`${where} = ${JSON.stringify(v)}`);
  }
  // uv takes a declared requirement from elsewhere than PyPI when `tool.uv.sources` says so.
  const sources = new Map(Object.entries(asTable(at(doc, 'tool.uv.sources')) ?? {}).map(([k, v]) => [normalizePypiName(k), v]));
  m.deps = m.deps.map((d) => {
    const src = d.source === 'registry' ? sources.get(d.name) : undefined;
    if (src === undefined) return d;
    const source = tablesSource(m.path, src, UV_REMOTE);
    return source === 'registry' ? d : { ...d, source, spec: JSON.stringify(src) };
  });
}

const READERS: Record<Exclude<ManifestKind, 'unsupported'>, (m: Manifest, text: string) => void> = {
  'package.json': readPackageJson,
  'pyproject.toml': readPyproject,
  requirements: readRequirements,
};

// ---------------------------------------------------------------- additions

/** A git, URL or path source is compared with its spec: pointing an existing name elsewhere adds it. */
const keyOf = (d: Declared): string =>
  d.source === 'registry' ? `${d.ecosystem}:${d.name}` : `${d.ecosystem}:${d.source}:${d.name}:${d.spec}`;
const directiveKey = (ecosystem: Ecosystem, directive: string): string => `${ecosystem}:directive:${directive}`;

export interface AddedDirective {
  ecosystem: Ecosystem;
  directive: string;
  manifest: string;
}

export interface Additions {
  added: AddedDependency[];
  /** Installer directives the changes add and that the check cannot follow. */
  directives: AddedDirective[];
  unreadable: { manifest: string; error: string }[];
  /** Changed files that steer installs and that the check does not read. */
  unsupported: string[];
}

/**
 * The dependencies and directives the changes add. Files that are not manifests are ignored. A
 * manifest that cannot be read after the change is `unreadable`; one that cannot be read before it
 * counts as empty, so all it declares after is checked.
 */
export function addedDependencies(changes: ManifestChange[]): Additions {
  const seen = new Set<string>();
  const deps: AddedDependency[] = [];
  const directives: AddedDirective[] = [];
  const unreadable: Additions['unreadable'] = [];
  const unsupported: string[] = [];
  for (const change of changes) {
    const kind = manifestKind(change.path);
    if (!kind) continue;
    if (kind === 'unsupported') {
      if (change.after !== null && change.after !== change.before) unsupported.push(change.path);
      continue;
    }
    const ecosystem: Ecosystem = kind === 'package.json' ? 'npm' : 'pypi';
    const read = (text: string): Manifest => {
      const m: Manifest = { path: change.path, deps: [], directives: [] };
      READERS[kind](m, text);
      return m;
    };
    if (change.before !== null) {
      try {
        const m = read(change.before);
        for (const d of m.deps) seen.add(keyOf(d));
        for (const directive of m.directives) seen.add(directiveKey(ecosystem, directive));
      } catch (err) {
        if (!(err instanceof ManifestError)) throw err;
      }
    }
    if (change.after !== null) {
      try {
        const m = read(change.after);
        for (const d of m.deps) deps.push({ ...d, manifest: change.path });
        for (const directive of m.directives) directives.push({ ecosystem, directive, manifest: change.path });
      } catch (err) {
        if (!(err instanceof ManifestError)) throw err;
        unreadable.push({ manifest: change.path, error: err.message });
      }
    }
  }
  // Declared before (in any manifest) or already listed: not added.
  const isNew = (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  return {
    added: deps.filter((d) => isNew(keyOf(d))),
    directives: directives.filter((d) => isNew(directiveKey(d.ecosystem, d.directive))),
    unreadable,
    unsupported,
  };
}

// ---------------------------------------------------------------- check

export interface DependencyCheckInput {
  changes: ManifestChange[];
  registry: PackageRegistry;
  /** `undefined`: the repository declares no allow-list, so no added package is allowed. */
  allowList?: AllowList;
}

const LABEL: Record<Ecosystem, string> = { npm: 'npm', pypi: 'PyPI' };
/** Registry requests in flight at once: a change adding hundreds of packages does not open hundreds of connections. */
export const MAX_PARALLEL_LOOKUPS = 8;

/** Runs at most `max` tasks at once, the others in call order. */
function limiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      // The slot passes to the next task, or is freed.
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

function summarize(findings: DependencyFinding[], added: AddedDependency[]): string {
  if (findings.length > 0) return [`${findings.length} constat(s) bloquant(s) :`, ...findings.map((f) => `- ${f.message}`)].join('\n');
  if (added.length === 0) return 'Aucune dépendance ajoutée.';
  return `${added.length} dépendance(s) ajoutée(s), présentes au registre et autorisées, ou locales : ${added.map((d) => d.name).join(', ')}.`;
}

export async function checkDependencies(input: DependencyCheckInput): Promise<DependencyCheckResult> {
  const { added, directives, unreadable, unsupported } = addedDependencies(input.changes);
  const findings: DependencyFinding[] = [
    ...unreadable.map(({ manifest, error }): DependencyFinding => ({
      reason: 'unreadable_manifest',
      manifest,
      message: `${manifest} : manifeste illisible, ses dépendances ne peuvent pas être contrôlées : ${error}`,
    })),
    ...unsupported.map((manifest): DependencyFinding => ({
      reason: 'unsupported_manifest',
      manifest,
      message: `${manifest} : fichier modifié qui oriente l'installation des dépendances et que le contrôle ne lit pas.`,
    })),
    ...directives.map(({ ecosystem, directive, manifest }): DependencyFinding => ({
      reason: 'unchecked_directive',
      manifest,
      ecosystem,
      message: `${manifest} : directive ajoutée que le contrôle ne suit pas (« ${directive} ») : autre index, fichier inclus non lu ou dépendances calculées hors du manifeste.`,
    })),
  ];
  const allowed: Record<Ecosystem, Set<string> | undefined> = {
    npm: input.allowList?.npm && new Set(input.allowList.npm.map((n) => n.trim())),
    pypi: input.allowList?.pypi && new Set(input.allowList.pypi.map((n) => normalizePypiName(n.trim()))),
  };

  const limit = limiter(MAX_PARALLEL_LOOKUPS);
  const lookups = new Map<string, Promise<RegistryLookup>>();
  const lookup = (ecosystem: Ecosystem, name: string): Promise<RegistryLookup> => {
    const key = `${ecosystem}:${name}`;
    let p = lookups.get(key);
    if (!p) {
      p = limit(async () => input.registry.lookup(ecosystem, name)).catch(
        (err: unknown): RegistryLookup => ({ status: 'unknown', reason: err instanceof Error ? err.message : String(err) }),
      );
      lookups.set(key, p);
    }
    return p;
  };

  const perDep = await Promise.all(
    added.map(async (d): Promise<DependencyFinding[]> => {
      if (d.source === 'local') return [];
      const out: DependencyFinding[] = [];
      const base = { manifest: d.manifest, ecosystem: d.ecosystem, name: d.name };
      const label = `${LABEL[d.ecosystem]} « ${d.name} » (${d.manifest})`;
      if (d.source === 'remote') {
        out.push({ ...base, reason: 'non_registry_source', message: `${label} : source hors du registre (${d.spec}), son existence ne peut pas être contrôlée.` });
      } else if (d.ecosystem === 'npm' && !isValidNpmName(d.name)) {
        return [{ ...base, reason: 'invalid_name', message: `${label} : nom de paquet npm invalide.` }];
      } else {
        const res = await lookup(d.ecosystem, d.name);
        if (res.status === 'missing') out.push({ ...base, reason: 'not_found', message: `${label} : paquet absent du registre ${LABEL[d.ecosystem]}.` });
        if (res.status === 'unknown') out.push({ ...base, reason: 'registry_unknown', message: `${label} : le registre n'a pas répondu (${res.reason}), le paquet n'est pas vérifié.` });
      }
      const list = allowed[d.ecosystem];
      if (!list) out.push({ ...base, reason: 'not_allowed', message: `${label} : aucune liste autorisée ${LABEL[d.ecosystem]} pour ce dépôt.` });
      else if (!list.has(d.name)) out.push({ ...base, reason: 'not_allowed', message: `${label} : hors de la liste autorisée du dépôt.` });
      return out;
    }),
  );
  findings.push(...perDep.flat());
  return { check: DEPENDENCY_CHECK, ok: findings.length === 0, summary: summarize(findings, added), findings, added };
}
