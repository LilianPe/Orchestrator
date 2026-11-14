import { z } from 'zod';
import { normalizePypiName } from '../checks/deps.js';
import type { Verdict } from './levels.js';

/** The kinds of counted reads, as the proxy journals them and the stores keep them. */
export const READ_KINDS = ['npm', 'pypi', 'release'] as const;

/**
 * A read that moves a counter anyone can read (ORC-370): an npm tarball (the version's downloads), a PyPI file (its
 * project's download stats), a GitHub release asset (its `download_count`, public through the API). A hijacked agent can
 * spell out data in which of them it reads, for an attacker who watches the counters: the proxy counts them per run.
 * `name`: the package, or `owner/repo`; `item`: the version, or the asset (`tag/name`, `asset <id>` through the API).
 */
export interface CountedRead {
  kind: (typeof READ_KINDS)[number];
  name: string;
  item: string;
}

/** The caps of a run's counted reads, from `egress` in factory.yml (ORC-370): a repository cannot lift them. */
export const readCapsSchema = z.strictObject({ versionsPerPackage: z.number().int().positive(), assetsPerRepo: z.number().int().positive() });
export type ReadCaps = z.infer<typeof readCapsSchema>;

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
/** The hosts whose reads can be counted: any other request is not looked at. */
export const COUNTED_HOSTS: ReadonlySet<string> = new Set([...NPM_HOSTS, 'files.pythonhosted.org', 'github.com', 'api.github.com']);
/** A downloaded distribution: its `.metadata` alone (PEP 658), which pip reads of many versions while it resolves, is no download. */
const PYPI_FILE = /^(.+?)(\.whl|\.tar\.gz|\.tar\.bz2|\.tgz|\.zip|\.egg)$/;

/**
 * A request's path as its host resolves it, the query aside: dot-segments resolved (`%2e` too), backslashes as slashes
 * (WHATWG's URL parser), doubled slashes collapsed, then decoded. A spelling the host serves must not escape the count.
 */
const resolved = (path: string): string => {
  const p = (URL.parse(`https://h${path.startsWith('/') ? '' : '/'}${path}`)?.pathname ?? path.split('?')[0]!).replace(/\/{2,}/g, '/');
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
};

/** The counted read a request of a listed host is, if it is one; its query never counts (the counters do not see it). */
export function countedRead(host: string, path: string): CountedRead | undefined {
  if (!COUNTED_HOSTS.has(host)) return undefined;
  const p = resolved(path);
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
    return name && version ? { kind: 'pypi', name: normalizePypiName(name), item: version } : undefined;
  }
  if (host === 'github.com') {
    const m = /^\/([^/]+)\/([^/]+)\/releases\/(?:download\/(.+)|(latest)\/download)\/([^/]+)$/.exec(p);
    return m ? { kind: 'release', name: `${m[1]}/${m[2]}`.toLowerCase(), item: `${m[3] ?? m[4]}/${m[5]}` } : undefined;
  }
  if (host === 'api.github.com') {
    // By its repository's name, or its id: `ReadCounter` counts one asset under the first of the two it was read by (ORC-396).
    // ponytail: the repository's id is not resolved, so its other assets have a cap under each spelling, and an asset read by
    // its `github.com` URL (tag and name) is another item than by the API (its id): telling them apart takes a read of GitHub.
    const m = /^\/repos\/([^/]+)\/([^/]+)\/releases\/assets\/(\d+)$/.exec(p);
    if (m) return { kind: 'release', name: `${m[1]}/${m[2]}`.toLowerCase(), item: `asset ${m[3]}` };
    const id = /^\/repositories\/(\d+)\/releases\/assets\/(\d+)$/.exec(p);
    return id ? { kind: 'release', name: `repository ${id[1]}`, item: `asset ${id[2]}` } : undefined;
  }
  return undefined;
}

const KIND = { npm: 'npm package', pypi: 'PyPI project', release: 'repository' } as const;

/** A run's counted reads (ORC-370): the distinct versions of each package, the release assets of each repository, and the reads of each, capped. */
export class ReadCounter {
  /** By package or repository, the reads of each version or asset. */
  private readonly seen = new Map<string, Map<string, number>>();
  /**
   * By asset id, the repository it was first counted under (ORC-396). An id is GitHub's, unique across repositories: read
   * again by its repository's id after its name, or the other way round, it is the same asset, which no read of the API
   * needs to tell. A pair that GitHub would refuse only merges two counts, never splits one.
   */
  private readonly assets = new Map<string, string>();

  constructor(private readonly caps: ReadCaps) {}

  /** Lets the read through, counted, or refuses it past its cap: a refused read is not counted. */
  admit(read: CountedRead): Verdict {
    const asset = read.kind === 'release' && read.item.startsWith('asset ') ? read.item : undefined;
    const key = (asset && this.assets.get(asset)) ?? `${read.kind}:${read.name}`;
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
    if (asset) this.assets.set(asset, key);
    return { ok: true };
  }
}

/**
 * What a run's repository declares it reads (ORC-370), from its lockfiles at the root of the ticket's base commit: `judged`, the
 * ecosystems it has a lockfile for, whose other reads are unusual; `reads`, the reads declared, as `readKey` spells them.
 */
export interface DeclaredReads {
  judged: CountedRead['kind'][];
  reads: string[];
}

export const readKey = (r: CountedRead) => `${r.kind}:${r.name}@${r.item}`;

/** The file of a run's declaration in its run dir (`<runs>/<runId>/`), the daemon's, never mounted in the sandbox. */
export const DECLARED_READS = 'declared-reads.json';

/**
 * The files of the repository's root read, and what each declares; one that cannot be read declares nothing. `whole`: it
 * locks the whole tree, so its ecosystem is judged once it declares a read; requirements.txt pins the direct dependencies alone.
 */
const LOCKFILES: [file: string, kind: CountedRead['kind'], read: (text: string) => CountedRead[], whole: boolean][] = [
  ['package-lock.json', 'npm', npmLock, true],
  ['npm-shrinkwrap.json', 'npm', npmLock, true],
  ['yarn.lock', 'npm', yarnLock, true],
  ['uv.lock', 'pypi', urls, true],
  ['poetry.lock', 'pypi', poetryLock, true],
  ['requirements.txt', 'pypi', requirements, false],
];

/**
 * What the lockfiles declare, each read by `show` at the ticket's base commit (ORC-396), never in the worktree: an earlier
 * attempt may have declared there what it means to read. `show` gives a file past its cap as `\0too large: …`.
 */
export async function declaredReads(show: (file: string) => Promise<string | undefined>): Promise<DeclaredReads> {
  const judged = new Set<CountedRead['kind']>();
  const reads = new Set<string>();
  // Read side by side, kept in this order: a read that fails, or a file past its cap, declares nothing.
  const texts = await Promise.all(LOCKFILES.map(([file]) => show(file).catch(() => undefined)));
  for (const [i, [, kind, read, whole]] of LOCKFILES.entries()) {
    const text = texts[i];
    if (text === undefined || text.startsWith('\0too large')) continue;
    let found: CountedRead[];
    try {
      found = read(text);
    } catch {
      continue;
    }
    if (whole && found.length) judged.add(kind);
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

/** Yarn 1's URLs, Yarn 2+'s `resolution: "<name>@npm:<version>"`. */
function yarnLock(text: string): CountedRead[] {
  return [...urls(text), ...[...text.matchAll(/resolution: "((?:@[^@"/]+\/)?[^@"]+)@npm:([^"]+)"/g)].map((m) => ({ kind: 'npm' as const, name: m[1]!, item: m[2]! }))];
}

/** An entry of a lockfile's JSON, an object or nothing: a malformed one is left out, not the whole file. */
const entry = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** package-lock.json, v1 to v3: each installed package's version, under its real name (an alias's `name`); v1's tree only without v2's `packages`. */
function npmLock(text: string): CountedRead[] {
  const lock = entry(JSON.parse(text));
  const out: CountedRead[] = [];
  for (const [path, v] of Object.entries(entry(lock['packages']))) {
    const p = entry(v);
    const name = str(p['name']) ?? (path.includes('node_modules/') ? path.split('node_modules/').pop() : undefined);
    const version = str(p['version']);
    if (name && version) out.push({ kind: 'npm', name, item: version });
  }
  const v1 = (deps: unknown) => {
    for (const [name, d] of Object.entries(entry(deps))) {
      const dep = entry(d);
      const version = str(dep['version']);
      if (version) out.push({ kind: 'npm', name, item: version });
      v1(dep['dependencies']);
    }
  };
  if (!out.length) v1(lock['dependencies']);
  return out;
}

/** Each `[[package]]`'s name and version. */
function poetryLock(text: string): CountedRead[] {
  return [...text.matchAll(/^name = "([^"]+)"\s*\nversion = "([^"]+)"/gm)].map((m) => ({ kind: 'pypi' as const, name: normalizePypiName(m[1]!), item: m[2]! }));
}

/** The pins (`name==version`), any marker after them aside. */
function requirements(text: string): CountedRead[] {
  return [...text.matchAll(/^\s*([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])?\s*===?\s*([\w.!+-]+)/gm)].map((m) => ({ kind: 'pypi' as const, name: normalizePypiName(m[1]!), item: m[2]! }));
}
