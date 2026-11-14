import { beforeEach, describe, expect, it } from 'vitest';
import { LIMITED } from './levels.js';
import { COUNTED_HOSTS, countedRead, declaredReads, READ_CAPS, READ_NAMES_MAX, READ_REPEATS_MAX, ReadCounter, unusualReads } from './reads.js';

describe('countedRead (ORC-370)', () => {
  it('names an npm tarball by its package and version, scoped or not, on either registry host', () => {
    expect(countedRead('registry.npmjs.org', '/lodash/-/lodash-4.17.21.tgz')).toEqual({ kind: 'npm', name: 'lodash', item: '4.17.21' });
    expect(countedRead('registry.npmjs.org', '/@types/node/-/node-24.0.1.tgz?x=1')).toEqual({ kind: 'npm', name: '@types/node', item: '24.0.1' });
    expect(countedRead('registry.npmjs.org', '/@types%2fnode/-/node-24.0.1.tgz')).toEqual({ kind: 'npm', name: '@types/node', item: '24.0.1' });
    expect(countedRead('registry.yarnpkg.com', '/lodash/-/lodash-4.17.21.tgz')).toEqual({ kind: 'npm', name: 'lodash', item: '4.17.21' });
    // A file that does not name its package: counted whole.
    expect(countedRead('registry.npmjs.org', '/lodash/-/other-1.0.0.tgz')).toEqual({ kind: 'npm', name: 'lodash', item: 'other-1.0.0.tgz' });
  });

  it('names a read by its path as the host resolves it: dot-segments and doubled slashes do not hide it', () => {
    for (const path of ['/x/../lodash/-/lodash-3.0.0.tgz', '/lodash/./-/lodash-3.0.0.tgz', '//lodash/-/lodash-3.0.0.tgz', '/lodash/-/%2e/lodash-3.0.0.tgz']) {
      expect(countedRead('registry.npmjs.org', path), path).toEqual({ kind: 'npm', name: 'lodash', item: '3.0.0' });
    }
    expect(countedRead('github.com', '/owner/repo/./releases/download/v1/a.zip')).toEqual({ kind: 'release', name: 'owner/repo', item: 'v1/a.zip' });
    expect(countedRead('files.pythonhosted.org', '//packages/aa/requests-1.0.tar.gz')).toEqual({ kind: 'pypi', name: 'requests', item: '1.0' });
  });

  it('names an asset read through the API by the id of its repository too', () => {
    expect(countedRead('api.github.com', '/repositories/123/releases/assets/789')).toEqual({ kind: 'release', name: 'repository 123', item: 'asset 789' });
  });

  it('counts reads of hosts the limited level reaches: a host counted off that list would be dead code, a registry on it uncounted a hole to look at', () => {
    for (const host of COUNTED_HOSTS) expect(LIMITED, host).toContain(host);
  });

  it('leaves out what moves no public counter: a packument, a version manifest, a search', () => {
    for (const path of ['/lodash', '/lodash/4.17.21', '/@types%2fnode', '/-/v1/search?text=x']) expect(countedRead('registry.npmjs.org', path), path).toBeUndefined();
    expect(countedRead('docs.npmjs.com', '/lodash/-/lodash-4.17.21.tgz')).toBeUndefined();
  });

  it('names a PyPI file by its normalised project and version, a wheel or an sdist; its metadata alone is not counted', () => {
    expect(countedRead('files.pythonhosted.org', '/packages/ab/cd/ef/Requests-2.32.3-py3-none-any.whl')).toEqual({ kind: 'pypi', name: 'requests', item: '2.32.3' });
    expect(countedRead('files.pythonhosted.org', '/packages/ab/cd/ef/zope_interface-7.0.tar.gz')).toEqual({ kind: 'pypi', name: 'zope-interface', item: '7.0' });
    expect(countedRead('files.pythonhosted.org', '/packages/ab/cd/ef/numpy-2.1.0-cp312-cp312-manylinux_2_17_x86_64.whl')).toEqual({ kind: 'pypi', name: 'numpy', item: '2.1.0' });
    // pip reads the metadata of many versions while it resolves: no download.
    expect(countedRead('files.pythonhosted.org', '/packages/ab/cd/ef/requests-2.32.3-py3-none-any.whl.metadata')).toBeUndefined();
    expect(countedRead('pypi.org', '/simple/requests/')).toBeUndefined();
  });

  it('names a GitHub release asset by its repository, its tag and its name, or its id through the API', () => {
    expect(countedRead('github.com', '/Owner/Repo/releases/download/v1.2.0/tool-linux-x64.tar.gz')).toEqual({ kind: 'release', name: 'owner/repo', item: 'v1.2.0/tool-linux-x64.tar.gz' });
    expect(countedRead('github.com', '/owner/repo/releases/latest/download/tool.zip')).toEqual({ kind: 'release', name: 'owner/repo', item: 'latest/tool.zip' });
    expect(countedRead('api.github.com', '/repos/owner/repo/releases/assets/123456')).toEqual({ kind: 'release', name: 'owner/repo', item: 'asset 123456' });
    for (const path of ['/owner/repo/releases', '/owner/repo/releases/tag/v1', '/owner/repo/archive/refs/tags/v1.tar.gz']) expect(countedRead('github.com', path), path).toBeUndefined();
    expect(countedRead('api.github.com', '/repos/owner/repo/releases/123')).toBeUndefined();
  });
});

describe('ReadCounter (ORC-370)', () => {
  const npm = (item: string, name = 'lodash') => ({ kind: 'npm' as const, name, item });

  it('lets a package through up to its cap of distinct versions, a version read again included, and refuses the next', () => {
    const c = new ReadCounter({ versionsPerPackage: 3, assetsPerRepo: 1 });
    for (const v of ['1', '2', '3', '1', '3']) expect(c.admit(npm(v)), v).toEqual({ ok: true });
    expect(c.admit(npm('4'))).toEqual({ ok: false, reason: expect.stringMatching(/suspicious: more than 3 distinct versions of npm package lodash in this run/) as string });
    // Refused, it is not counted: a version already read still goes.
    expect(c.admit(npm('2'))).toEqual({ ok: true });
    // Each package has its own count, npm and PyPI apart.
    expect(c.admit(npm('4', 'debug'))).toEqual({ ok: true });
    expect(c.admit({ kind: 'pypi', name: 'lodash', item: '4' })).toEqual({ ok: true });
  });

  it('caps the reads of one version too: each download moves its counter, so repeats could spell out data', () => {
    const c = new ReadCounter({ versionsPerPackage: 3, assetsPerRepo: 1 });
    for (let i = 0; i < READ_REPEATS_MAX; i++) expect(c.admit(npm('1'))).toEqual({ ok: true });
    expect(c.admit(npm('1'))).toEqual({ ok: false, reason: `suspicious: npm package lodash 1 read more than ${READ_REPEATS_MAX} times in this run` });
    expect(c.admit(npm('2'))).toEqual({ ok: true });
  });

  it('caps the release assets of a repository, whatever their tag', () => {
    const c = new ReadCounter({ versionsPerPackage: 3, assetsPerRepo: 2 });
    const asset = (item: string) => ({ kind: 'release' as const, name: 'owner/repo', item });
    expect(c.admit(asset('v1/a'))).toEqual({ ok: true });
    expect(c.admit(asset('v2/a'))).toEqual({ ok: true });
    expect(c.admit(asset('v3/a'))).toMatchObject({ ok: false, reason: expect.stringMatching(/more than 2 release assets of owner\/repo/) as string });
  });

  it('counts an asset read by its repository\'s name, then by its repository\'s id, as one asset: its reads and its place under the cap (ORC-396)', () => {
    const c = new ReadCounter({ versionsPerPackage: 3, assetsPerRepo: 2 });
    const byName = countedRead('api.github.com', '/repos/Owner/Repo/releases/assets/789')!;
    const byId = countedRead('api.github.com', '/repositories/123/releases/assets/789')!;
    for (let i = 0; i < READ_REPEATS_MAX; i++) expect(c.admit(i % 2 ? byId : byName), String(i)).toEqual({ ok: true });
    expect(c.admit(byId)).toMatchObject({ ok: false, reason: expect.stringMatching(/asset 789 read more than/) as string });
    // One place under the cap of owner/repo: one more of its assets goes through, the next is refused.
    expect(c.admit({ kind: 'release', name: 'owner/repo', item: 'v1/a.zip' })).toEqual({ ok: true });
    expect(c.admit({ ...byName, item: 'asset 790' })).toMatchObject({ ok: false });
  });

  it('defaults to caps a lockfile install stays under', () => {
    expect(READ_CAPS.versionsPerPackage).toBeGreaterThanOrEqual(8);
    expect(READ_CAPS.assetsPerRepo).toBeGreaterThanOrEqual(3);
  });

  it('bounds the packages it follows: past them, a new one is refused, so a run cannot grow the memory of the proxy', () => {
    const c = new ReadCounter(READ_CAPS);
    for (let i = 0; i < READ_NAMES_MAX; i++) c.admit(npm('1', `p${i}`));
    expect(c.admit(npm('1', 'one-more'))).toMatchObject({ ok: false, reason: expect.stringMatching(/suspicious: more than .* packages/) as string });
    expect(c.admit(npm('1', 'p0'))).toEqual({ ok: true });
  });
});

describe('declaredReads and unusualReads (ORC-370)', () => {
  // The lockfiles as the ticket's base commit holds them, by path (ORC-396): the reader `declaredReads` is handed.
  let files: Record<string, string> = {};
  beforeEach(() => (files = {}));
  const show = async (file: string) => files[file];

  it('reads the versions of package-lock.json, an alias by its real package', async () => {
    files['package-lock.json'] = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/lodash': { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
        'node_modules/a/node_modules/@types/node': { version: '24.0.1' },
        'node_modules/old-lodash': { name: 'lodash', version: '3.0.0', resolved: 'https://registry.npmjs.org/lodash/-/lodash-3.0.0.tgz' },
        'packages/local': { version: '0.0.0' },
      },
    });
    const unusualRead = unusualReads(await declaredReads(show));
    expect(unusualRead({ kind: 'npm', name: 'lodash', item: '4.17.21' })).toBe(false);
    expect(unusualRead({ kind: 'npm', name: 'lodash', item: '3.0.0' })).toBe(false);
    expect(unusualRead({ kind: 'npm', name: '@types/node', item: '24.0.1' })).toBe(false);
    expect(unusualRead({ kind: 'npm', name: 'lodash', item: '4.17.20' })).toBe(true);
    // No Python lockfile: no PyPI read is judged. A release asset is, always.
    expect(unusualRead({ kind: 'pypi', name: 'requests', item: '1' })).toBe(false);
    expect(unusualRead({ kind: 'release', name: 'owner/repo', item: 'v1/a' })).toBe(true);
  });

  it('reads the URLs of yarn.lock and uv.lock, the pins of requirements.txt and the packages of poetry.lock', async () => {
    files['yarn.lock'] = 'lodash@^4:\n  version "4.17.21"\n  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#abc"\n';
    files['uv.lock'] = '[[package]]\nname = "tool"\nsdist = { url = "https://github.com/owner/repo/releases/download/v1/tool.tar.gz" }\n';
    files['requirements.txt'] = '# pinned\nRequests==2.32.3 ; python_version >= "3.9"\nflask>=3\n';
    files['poetry.lock'] = '[[package]]\nname = "zope.interface"\nversion = "7.0"\n';
    const unusualRead = unusualReads(await declaredReads(show));
    expect(unusualRead({ kind: 'npm', name: 'lodash', item: '4.17.21' })).toBe(false);
    expect(unusualRead({ kind: 'npm', name: 'lodash', item: '1.0.0' })).toBe(true);
    expect(unusualRead({ kind: 'release', name: 'owner/repo', item: 'v1/tool.tar.gz' })).toBe(false);
    expect(unusualRead({ kind: 'pypi', name: 'requests', item: '2.32.3' })).toBe(false);
    expect(unusualRead({ kind: 'pypi', name: 'zope-interface', item: '7.0' })).toBe(false);
    expect(unusualRead({ kind: 'pypi', name: 'flask', item: '3.0.0' })).toBe(true);
  });

  it('judges nothing of an ecosystem the repository has no lockfile for, and survives a lockfile it cannot read', async () => {
    files['package-lock.json'] = '{ not json';
    const unusualRead = unusualReads(await declaredReads(show));
    expect(unusualRead({ kind: 'npm', name: 'lodash', item: '1' })).toBe(false);
  });

  it('declares nothing of a lockfile too large for the read of the base commit (ORC-396)', async () => {
    // What `showAtFork` gives of a blob past its cap, in place of its content.
    files['package-lock.json'] = '\0too large: 0123abcd';
    files['yarn.lock'] = '\0too large: 4567ef\nlodash@^4:\n  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"\n';
    expect(await declaredReads(show)).toEqual({ judged: [], reads: [] });
  });

  it('reads the resolutions of a Yarn 2+ lockfile, and keeps what a package-lock declares around a malformed entry', async () => {
    files['yarn.lock'] = '"lodash@npm:^4":\n  version: 4.17.21\n  resolution: "lodash@npm:4.17.21"\n\n"@types/node@npm:^24":\n  resolution: "@types/node@npm:24.0.1"\n';
    files['package-lock.json'] = JSON.stringify({ packages: { 'node_modules/x': null, 'node_modules/debug': { version: '4.0.0' } }, dependencies: { y: 'not an object' } });
    const unusualRead = unusualReads(await declaredReads(show));
    expect(unusualRead({ kind: 'npm', name: 'lodash', item: '4.17.21' })).toBe(false);
    expect(unusualRead({ kind: 'npm', name: '@types/node', item: '24.0.1' })).toBe(false);
    expect(unusualRead({ kind: 'npm', name: 'debug', item: '4.0.0' })).toBe(false);
    expect(unusualRead({ kind: 'npm', name: 'debug', item: '4.0.1' })).toBe(true);
  });

  it('judges an ecosystem only by a lockfile that declares its whole tree: requirements.txt pins only the direct dependencies, an empty lockfile nothing', async () => {
    files['requirements.txt'] = 'requests==2.32.3\n';
    files['yarn.lock'] = '# empty\n';
    const unusualRead = unusualReads(await declaredReads(show));
    expect(unusualRead({ kind: 'pypi', name: 'urllib3', item: '2.0.0' })).toBe(false);
    expect(unusualRead({ kind: 'npm', name: 'lodash', item: '1' })).toBe(false);
  });
});
