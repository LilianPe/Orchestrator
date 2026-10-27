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
 * ecosystem: a name declared in some manifest after the change and in none before it. A version
 * bump, a move between sections or files, or a removal adds nothing. Lockfiles are not read: they
 * also list transitive packages, and an install from a lockfile that a manifest does not reference
 * does not add a direct dependency.
 *
 * Fail-closed: a manifest that cannot be read, a registry that does not answer and a source that
 * is not the registry (git, URL) block, each with its reason. A local source (workspace, path) is
 * code of the repository: listed as added, not blocking.
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
  | 'unreadable_manifest';

export interface DependencyFinding {
  reason: FindingReason;
  manifest: string;
  ecosystem?: Ecosystem;
  name?: string;
  message: string;
}

export interface DependencyCheckResult {
  check: typeof DEPENDENCY_CHECK;
  ok: boolean;
  /** Every finding blocks. */
  findings: DependencyFinding[];
  /** Every added dependency, blocking or not, for the security journal (ORC-223). */
  added: AddedDependency[];
}

export type ManifestKind = 'package.json' | 'pyproject.toml' | 'requirements';

/** The manifests the check reads, by file name: `package.json`, `pyproject.toml`, `requirements*.txt` and `requirements/*.txt`. */
export function manifestKind(path: string): ManifestKind | undefined {
  const p = path.replace(/\\/g, '/');
  const base = posix.basename(p);
  if (base === 'package.json') return 'package.json';
  if (base === 'pyproject.toml') return 'pyproject.toml';
  if (base.endsWith('.txt') && (base.startsWith('requirements') || posix.basename(posix.dirname(p)) === 'requirements')) return 'requirements';
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

class ManifestError extends Error {}

// ---------------------------------------------------------------- npm

const NPM_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

function npmDeclared(declared: string, spec: string): Declared {
  const s = spec.trim();
  const base = { ecosystem: 'npm' as const, declared, spec };
  if (s.startsWith('npm:')) {
    const target = s.slice(4);
    const at = target.indexOf('@', 1);
    return { ...base, name: at === -1 ? target : target.slice(0, at), source: 'registry' };
  }
  if (/^(workspace|file|link|portal):/.test(s) || /^(\.{1,2}\/|\/|~\/)/.test(s)) return { ...base, name: declared, source: 'local' };
  // git, tarball URL, hosted shortcuts and the `user/repo` shorthand (a version range never contains `/`).
  if (/^[a-z+]+:/i.test(s) || s.includes('/')) return { ...base, name: declared, source: 'remote' };
  return { ...base, name: declared, source: 'registry' };
}

function readPackageJson(text: string): Declared[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ManifestError(`JSON invalide (${(err as Error).message})`);
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new ManifestError("ce n'est pas un objet JSON");
  const out: Declared[] = [];
  for (const section of NPM_SECTIONS) {
    const deps = (json as Record<string, unknown>)[section];
    if (deps === undefined) continue;
    if (typeof deps !== 'object' || deps === null || Array.isArray(deps)) throw new ManifestError(`« ${section} » n'est pas un objet`);
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string') throw new ManifestError(`la version de « ${name} » dans « ${section} » n'est pas une chaîne`);
      out.push(npmDeclared(name, spec));
    }
  }
  return out;
}

// ---------------------------------------------------------------- PyPI

const PEP508 = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*(.*)$/s;
const isLocalPath = (s: string): boolean => /^(\.{1,2}([/\\]|$)|[/\\]|~[/\\]|[A-Za-z]:[/\\]|file:)/.test(s);

function pypiDeclared(declared: string, spec: string, source: DependencySource): Declared {
  return { ecosystem: 'pypi', name: normalizePypiName(declared), declared, spec, source };
}

/** One PEP 508 requirement, or a bare URL or path as `pip` accepts them in a requirements file. */
function readRequirement(text: string, where: string): Declared {
  const req = text.trim();
  if (isLocalPath(req)) return pypiDeclared(req, req, 'local');
  const m = PEP508.exec(req);
  const rest = m?.[2]!.trim() ?? '';
  if (m && rest.startsWith('@')) {
    const url = rest.slice(1).trim().split(/\s|;/)[0] ?? '';
    return pypiDeclared(m[1]!, rest, isLocalPath(url) ? 'local' : 'remote');
  }
  if (m && (rest === '' || /^[<>=!~(;,]/.test(rest))) return pypiDeclared(m[1]!, rest, 'registry');
  if (req.includes('://') || /^git\+/.test(req)) {
    const egg = /[#&]egg=([A-Za-z0-9._-]+)/.exec(req);
    return pypiDeclared(egg?.[1] ?? req, req, 'remote');
  }
  throw new ManifestError(`${where} : exigence illisible « ${req} »`);
}

function readRequirements(text: string): Declared[] {
  const out: Declared[] = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\\\n/g, ' ').split('\n');
  lines.forEach((raw, n) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (line === '') return;
    const where = `ligne ${n + 1}`;
    const editable = /^(?:-e|--editable)(?:\s+|=)(.+)$/.exec(line);
    if (editable) {
      out.push(readRequirement(editable[1]!, where));
      return;
    }
    // Other options: includes and constraints (`-r`, `-c`: their files are manifests of their own),
    // index and install options. None of them adds a package.
    if (line.startsWith('-')) return;
    // Per-requirement options (`--hash=…`) follow the requirement.
    out.push(readRequirement(line.split(/\s+--?[a-z]/i)[0]!, where));
  });
  return out;
}

const asTable = (v: TomlValue | undefined): TomlTable | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v : undefined;
const at = (t: TomlTable | undefined, ...path: string[]): TomlValue | undefined =>
  path.reduce<TomlValue | undefined>((v, k) => asTable(v)?.[k], t);

function requirementList(v: TomlValue | undefined, where: string, out: Declared[], tablesAllowed = false): void {
  if (v === undefined) return;
  if (!Array.isArray(v)) throw new ManifestError(`« ${where} » n'est pas une liste`);
  for (const item of v) {
    if (typeof item === 'string') out.push(readRequirement(item, where));
    // PEP 735: `{ include-group = "…" }` names another group of the same file.
    else if (!(tablesAllowed && asTable(item))) throw new ManifestError(`« ${where} » contient autre chose que des exigences`);
  }
}

function requirementTables(v: TomlValue | undefined, where: string, out: Declared[], tablesAllowed = false): void {
  if (v === undefined) return;
  const t = asTable(v);
  if (!t) throw new ManifestError(`« ${where} » n'est pas une table`);
  for (const [k, list] of Object.entries(t)) requirementList(list, `${where}.${k}`, out, tablesAllowed);
}

function poetrySource(spec: TomlValue): { spec: string; source: DependencySource } {
  const tables = (Array.isArray(spec) ? spec : [spec]).map(asTable).filter((t) => t !== undefined);
  if (typeof spec === 'string') return { spec, source: 'registry' };
  if (tables.length === 0) throw new ManifestError('dépendance Poetry illisible');
  if (tables.some((t) => 'git' in t || 'url' in t)) return { spec: JSON.stringify(spec), source: 'remote' };
  if (tables.every((t) => 'path' in t)) return { spec: JSON.stringify(spec), source: 'local' };
  return { spec: JSON.stringify(spec), source: 'registry' };
}

function poetryTable(v: TomlValue | undefined, where: string, out: Declared[]): void {
  if (v === undefined) return;
  const t = asTable(v);
  if (!t) throw new ManifestError(`« ${where} » n'est pas une table`);
  for (const [name, spec] of Object.entries(t)) {
    if (name.toLowerCase() === 'python') continue;
    const s = poetrySource(spec);
    out.push(pypiDeclared(name, s.spec, s.source));
  }
}

function readPyproject(text: string): Declared[] {
  let doc: TomlTable;
  try {
    doc = parseToml(text);
  } catch (err) {
    throw new ManifestError(`TOML illisible (${(err as Error).message})`);
  }
  const out: Declared[] = [];
  requirementList(at(doc, 'project', 'dependencies'), 'project.dependencies', out);
  requirementTables(at(doc, 'project', 'optional-dependencies'), 'project.optional-dependencies', out);
  requirementTables(at(doc, 'dependency-groups'), 'dependency-groups', out, true);
  requirementList(at(doc, 'tool', 'uv', 'dev-dependencies'), 'tool.uv.dev-dependencies', out);
  poetryTable(at(doc, 'tool', 'poetry', 'dependencies'), 'tool.poetry.dependencies', out);
  poetryTable(at(doc, 'tool', 'poetry', 'dev-dependencies'), 'tool.poetry.dev-dependencies', out);
  const groups = at(doc, 'tool', 'poetry', 'group');
  for (const [g, group] of Object.entries(asTable(groups) ?? {})) {
    poetryTable(at(asTable(group), 'dependencies'), `tool.poetry.group.${g}.dependencies`, out);
  }
  // uv takes a declared requirement from elsewhere than PyPI when `tool.uv.sources` says so.
  const sources = asTable(at(doc, 'tool', 'uv', 'sources')) ?? {};
  const bySource = new Map(Object.entries(sources).map(([k, v]) => [normalizePypiName(k), asTable(v)]));
  return out.map((d) => {
    const src = d.source === 'registry' ? bySource.get(d.name) : undefined;
    if (!src) return d;
    if ('git' in src || 'url' in src) return { ...d, source: 'remote' as const, spec: JSON.stringify(src) };
    if ('path' in src || 'workspace' in src) return { ...d, source: 'local' as const, spec: JSON.stringify(src) };
    return d;
  });
}

function readManifest(kind: ManifestKind, text: string): Declared[] {
  if (kind === 'package.json') return readPackageJson(text);
  if (kind === 'pyproject.toml') return readPyproject(text);
  return readRequirements(text);
}

// ---------------------------------------------------------------- additions

const keyOf = (d: Pick<Declared, 'ecosystem' | 'name' | 'source'>): string =>
  d.source === 'registry' ? `${d.ecosystem}:${d.name}` : `${d.ecosystem}:${d.source}:${d.name}`;

export interface Additions {
  added: AddedDependency[];
  unreadable: { manifest: string; error: string }[];
}

/**
 * The dependencies the changes add. Files that are not manifests are ignored. A manifest that
 * cannot be read after the change is `unreadable`; one that cannot be read before it counts as
 * empty, so all it declares after is checked.
 */
export function addedDependencies(changes: ManifestChange[]): Additions {
  const before = new Set<string>();
  const after: (Declared & { manifest: string })[] = [];
  const unreadable: Additions['unreadable'] = [];
  for (const change of changes) {
    const kind = manifestKind(change.path);
    if (!kind) continue;
    if (change.before !== null) {
      try {
        for (const d of readManifest(kind, change.before)) before.add(keyOf(d));
      } catch (err) {
        if (!(err instanceof ManifestError)) throw err;
      }
    }
    if (change.after !== null) {
      try {
        for (const d of readManifest(kind, change.after)) after.push({ ...d, manifest: change.path });
      } catch (err) {
        if (!(err instanceof ManifestError)) throw err;
        unreadable.push({ manifest: change.path, error: err.message });
      }
    }
  }
  const seen = new Set<string>();
  const added: AddedDependency[] = [];
  for (const d of after) {
    const key = keyOf(d);
    if (before.has(key) || seen.has(key)) continue;
    seen.add(key);
    added.push({ ecosystem: d.ecosystem, name: d.name, declared: d.declared, spec: d.spec, source: d.source, manifest: d.manifest });
  }
  return { added, unreadable };
}

// ---------------------------------------------------------------- check

export interface DependencyCheckInput {
  changes: ManifestChange[];
  registry: PackageRegistry;
  /** `undefined`: the repository declares no allow-list, so no added package is allowed. */
  allowList?: AllowList;
}

const LABEL: Record<Ecosystem, string> = { npm: 'npm', pypi: 'PyPI' };

export async function checkDependencies(input: DependencyCheckInput): Promise<DependencyCheckResult> {
  const { added, unreadable } = addedDependencies(input.changes);
  const findings: DependencyFinding[] = unreadable.map(({ manifest, error }) => ({
    reason: 'unreadable_manifest',
    manifest,
    message: `${manifest} : manifeste illisible, ses dépendances ne peuvent pas être contrôlées : ${error}`,
  }));
  const allowed: Record<Ecosystem, Set<string> | undefined> = {
    npm: input.allowList?.npm && new Set(input.allowList.npm.map((n) => n.trim())),
    pypi: input.allowList?.pypi && new Set(input.allowList.pypi.map((n) => normalizePypiName(n.trim()))),
  };

  const lookups = new Map<string, Promise<RegistryLookup>>();
  const lookup = (ecosystem: Ecosystem, name: string): Promise<RegistryLookup> => {
    const key = `${ecosystem}:${name}`;
    let p = lookups.get(key);
    if (!p) {
      p = input.registry.lookup(ecosystem, name).catch(
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
      if (d.ecosystem === 'npm' && !isValidNpmName(d.name)) {
        return [{ ...base, reason: 'invalid_name', message: `${label} : nom de paquet npm invalide.` }];
      }
      if (d.source === 'remote') {
        out.push({ ...base, reason: 'non_registry_source', message: `${label} : source hors du registre (${d.spec}), son existence ne peut pas être contrôlée.` });
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
  return { check: DEPENDENCY_CHECK, ok: findings.length === 0, findings, added };
}
