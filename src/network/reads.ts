import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Verdict } from './levels.js';

/**
 * A read that moves a counter anyone can read (ORC-370): an npm tarball (the version's downloads), a PyPI file (its
 * project's download stats), a GitHub release asset (its `download_count`, public through the API). A hijacked agent can
 * spell out data in which of them it reads, for an attacker who watches the counters: the proxy counts them per run.
 * `name`: the package, or `owner/repo`; `item`: the version, or the asset (`tag/name`, `asset <id>` through the API).
 */
export interface CountedRead {
  kind: 'npm' | 'pypi' | 'release';
  name: string;
  item: string;
}

/** The caps of a run's counted reads, from `egress` in factory.yml (ORC-370): a repository cannot lift them. */
export interface ReadCaps {
  versionsPerPackage: number;
  assetsPerRepo: number;
}

/**
 * ponytail: a lockfile installs a few versions of one package at most (3 in the factory's own, measured; large
 * monorepos, up to 8 of `semver` or `debug`); a run fetches one asset per tool and platform.
 */
export const READ_CAPS: ReadCaps = { versionsPerPackage: 10, assetsPerRepo: 5 };

/**
 * The reads of one version or asset in a run: each download moves its counter again. An install downloads each tarball
 * once, its cache serving the next; a failed download is tried again a few times.
 */
export const READ_REPEATS_MAX = 5;

/** The packages and repositories a run's counter follows: past them, a new one is refused (the proxy's memory). A big install reads ~3 000. */
export const READ_NAMES_MAX = 20_000;

const NPM_HOSTS = ['registry.npmjs.org', 'registry.yarnpkg.com'];
/** A downloaded distribution: its `.metadata` alone (PEP 658), which pip reads of many versions while it resolves, is no download. */
const PYPI_FILE = /^(.+?)(\.whl|\.tar\.gz|\.tar\.bz2|\.tgz|\.zip|\.egg)$/;

const decoded = (path: string): string => {
  const p = path.split('?')[0]!;
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
};

/** PEP 503: the one spelling of a project's name. */
const pypiName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

/** The counted read a request of a listed host is, if it is one; its query never counts (the counters do not see it). */
export function countedRead(host: string, path: string): CountedRead | undefined {
  const p = decoded(path);
  if (NPM_HOSTS.includes(host)) {
    const m = /^\/((?:@[^/]+\/)?[^/@][^/]*)\/-\/([^/]+\.tgz)$/.exec(p);
    if (!m) return undefined;
    const name = m[1]!;
    const prefix = `${name.split('/').pop()!}-`;
    const file = m[2]!;
    return { kind: 'npm', name, item: file.startsWith(prefix) ? file.slice(prefix.length, -'.tgz'.length) : file };
  }
  if (host === 'files.pythonhosted.org') {
    const file = PYPI_FILE.exec(p.split('/').pop()!);
    if (!file || !p.startsWith('/packages/')) return undefined;
    // A wheel or an egg: name-version-…; an sdist: name-version, the name maybe with dashes of its own.
    const [name, version] = file[2] === '.whl' || file[2] === '.egg' ? file[1]!.split('-') : [file[1]!.replace(/-[^-]*$/, ''), file[1]!.split('-').pop()];
    return name && version ? { kind: 'pypi', name: pypiName(name), item: version } : undefined;
  }
  if (host === 'github.com') {
    const m = /^\/([^/]+)\/([^/]+)\/releases\/(?:download\/(.+)|(latest)\/download)\/([^/]+)$/.exec(p);
    return m ? { kind: 'release', name: `${m[1]}/${m[2]}`.toLowerCase(), item: `${m[3] ?? m[4]}/${m[5]}` } : undefined;
  }
  if (host === 'api.github.com') {
    const m = /^\/repos\/([^/]+)\/([^/]+)\/releases\/assets\/(\d+)$/.exec(p);
    return m ? { kind: 'release', name: `${m[1]}/${m[2]}`.toLowerCase(), item: `asset ${m[3]}` } : undefined;
  }
  return undefined;
}

const KIND = { npm: 'npm package', pypi: 'PyPI project', release: 'repository' } as const;

/** A run's counted reads (ORC-370): the distinct versions of each package, the release assets of each repository, and the reads of each, capped. */
export class ReadCounter {
  /** By package or repository, the reads of each version or asset. */
  private readonly seen = new Map<string, Map<string, number>>();

  constructor(private readonly caps: ReadCaps) {}

  /** Lets the read through, counted, or refuses it past its cap: a refused read is not counted. */
  admit(read: CountedRead): Verdict {
    const key = `${read.kind}:${read.name}`;
    let items = this.seen.get(key);
    const reads = items?.get(read.item) ?? 0;
    if (reads >= READ_REPEATS_MAX) return { ok: false, reason: `suspicious: ${KIND[read.kind]} ${read.name} ${read.item} read more than ${READ_REPEATS_MAX} times in this run` };
    if (!items && this.seen.size >= READ_NAMES_MAX) return { ok: false, reason: `suspicious: more than ${READ_NAMES_MAX} packages and repositories read in this run` };
    const cap = read.kind === 'release' ? this.caps.assetsPerRepo : this.caps.versionsPerPackage;
    if (!reads && (items?.size ?? 0) >= cap) {
      const what = read.kind === 'release' ? `release assets of ${read.name}` : `distinct versions of ${KIND[read.kind]} ${read.name}`;
      return { ok: false, reason: `suspicious: more than ${cap} ${what} in this run` };
    }
    if (!items) this.seen.set(key, (items = new Map()));
    items.set(read.item, reads + 1);
    return { ok: true };
  }
}

/**
 * What a run's repository declares it reads (ORC-370), from its lockfiles at the root when the run starts: `judged`, the
 * ecosystems it has a lockfile for, whose other reads are unusual; `reads`, the reads declared, as `readKey` spells them.
 */
export interface DeclaredReads {
  judged: CountedRead['kind'][];
  reads: string[];
}

export const readKey = (r: CountedRead) => `${r.kind}:${r.name}@${r.item}`;

/** The file of a run's declaration in its run dir (`<runs>/<runId>/`), the daemon's, never mounted in the sandbox. */
export const DECLARED_READS = 'declared-reads.json';

/** The files of the repository's root read, and what each declares; one that cannot be read declares nothing. */
const LOCKFILES: [file: string, kind: CountedRead['kind'], read: (text: string) => CountedRead[]][] = [
  ['package-lock.json', 'npm', npmLock],
  ['npm-shrinkwrap.json', 'npm', npmLock],
  ['yarn.lock', 'npm', urls],
  ['uv.lock', 'pypi', urls],
  ['poetry.lock', 'pypi', poetryLock],
  ['requirements.txt', 'pypi', requirements],
];

export function declaredReads(workspace: string): DeclaredReads {
  const judged = new Set<CountedRead['kind']>();
  const reads = new Set<string>();
  for (const [file, kind, read] of LOCKFILES) {
    let found: CountedRead[];
    try {
      found = read(readFileSync(join(workspace, file), 'utf8'));
    } catch {
      continue;
    }
    judged.add(kind);
    for (const r of found) reads.add(readKey(r));
  }
  return { judged: [...judged], reads: [...reads] };
}

/** Whether a read is absent from the lockfiles: a release asset no lockfile names, a version of an ecosystem the repository locks. */
export function unusualReads(declared: DeclaredReads): (read: CountedRead) => boolean {
  const reads = new Set(declared.reads);
  return (read) => (read.kind === 'release' || declared.judged.includes(read.kind)) && !reads.has(readKey(read));
}

/** Every URL of a lockfile that is a counted read. */
function urls(text: string): CountedRead[] {
  const out: CountedRead[] = [];
  for (const [u] of text.matchAll(/https:\/\/[^\s"'#,}]+/g)) {
    const url = URL.parse(u);
    const r = url && countedRead(url.hostname, url.pathname);
    if (r) out.push(r);
  }
  return out;
}

/** package-lock.json, v1 to v3: each installed package's version, under its real name (an alias's `name`), and its URL. */
function npmLock(text: string): CountedRead[] {
  const lock = JSON.parse(text) as { packages?: Record<string, { name?: string; version?: string; resolved?: string }>; dependencies?: Record<string, unknown> };
  const out = urls(text);
  for (const [path, p] of Object.entries(lock.packages ?? {})) {
    const name = p.name ?? (path.includes('node_modules/') ? path.split('node_modules/').pop() : undefined);
    if (name && p.version) out.push({ kind: 'npm', name, item: p.version });
  }
  const v1 = (deps: Record<string, unknown> | undefined) => {
    for (const [name, d] of Object.entries(deps ?? {})) {
      const dep = d as { version?: string; dependencies?: Record<string, unknown> };
      if (dep.version) out.push({ kind: 'npm', name, item: dep.version });
      v1(dep.dependencies);
    }
  };
  v1(lock.dependencies);
  return out;
}

/** Each `[[package]]`'s name and version. */
function poetryLock(text: string): CountedRead[] {
  return [...text.matchAll(/^name = "([^"]+)"\s*\nversion = "([^"]+)"/gm)].map((m) => ({ kind: 'pypi' as const, name: pypiName(m[1]!), item: m[2]! }));
}

/** The pins (`name==version`), any marker after them aside. */
function requirements(text: string): CountedRead[] {
  return [...text.matchAll(/^\s*([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])?\s*===?\s*([\w.!+-]+)/gm)].map((m) => ({ kind: 'pypi' as const, name: pypiName(m[1]!), item: m[2]! }));
}
