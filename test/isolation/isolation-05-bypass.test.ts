import { beforeAll, describe, expect, it } from 'vitest';
import { parseRepoConfig } from '../../src/config/repo-config.js';
import { agentPolicy } from '../../src/network/levels.js';
import { AGENT_API, egressRunnable, http1, useEgress } from './egress.js';
import { cli } from './helpers.js';

/**
 * Isolation n° 5: getting around the proxy, or the step's network level (ORC-219, against ORC-213). A tool that ignores
 * the proxy has no way out; what the agent sends the proxy (a Host, a TLS name, an absolute URL, a second request on the
 * same tunnel, HTTP/2, an upgrade, another protocol, headers naming a run or a level) changes neither the host reached nor
 * the level; a step narrowed by the factory stays narrowed, the repository's own hosts with it. On a stand-in internet
 * that records what reaches it; each refusal has its control.
 */
const repo = parseRepoConfig('network: { level: custom, allow: [docs.example.org] }\n');

describe.skipIf(!egressRunnable)(`isolation 5: around the proxy and the step's level (${cli})`, () => {
  const egress = useEgress('iso5', { standIn: {} });
  let custom: Awaited<ReturnType<typeof egress.open>>;
  let narrowed: Awaited<ReturnType<typeof egress.open>>;
  let none: Awaited<ReturnType<typeof egress.open>>;
  const reached = (host: string) => egress.seen.filter((s) => s.host === host || s.sni === host);

  beforeAll(async () => {
    const run = agentPolicy(repo);
    expect(run).toEqual({ level: 'limited', allow: ['docs.example.org'] });
    custom = await egress.open(run.level, run.allow);
    // The review's step (ORC-183): narrowed to the Claude API. The repository's hosts are handed over all the same, as a
    // factory that forgot to drop them would: the level alone must close them.
    const review = agentPolicy(repo, 'claude-api');
    expect(review).toEqual({ level: 'claude-api', allow: [] });
    narrowed = await egress.open(review.level, repo.network.allow);
    none = await egress.open('none');
  }, 300_000);

  it('a tool that ignores the proxy, or is pointed at another one, has no way out', async () => {
    const before = egress.seen.length;
    const unset = 'env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u NODE_USE_ENV_PROXY';
    expect(await custom.sh(`cd /work && ${unset} node egress-probe.mjs fetch https://registry.npmjs.org/`)).toMatchObject({ out: expect.stringMatching(/^ERR /) as string });
    for (const proxy of ['http://10.0.2.2:3128', 'http://host.docker.internal:3128', 'http://169.254.169.254:3128']) {
      expect(await custom.sh(`cd /work && HTTPS_PROXY=${proxy} https_proxy=${proxy} node egress-probe.mjs fetch https://registry.npmjs.org/`), proxy).toMatchObject({ out: expect.stringMatching(/^ERR /) as string });
    }
    expect(egress.seen.length).toBe(before);
    // The control: the same fetch, through the proxy.
    expect(await custom.probe('fetch', 'https://registry.npmjs.org/')).toMatch(/^200 /);
  });

  it("goes to the tunnel's host, whatever Host, TLS name or absolute URL the agent sends", async () => {
    expect(await custom.probe('tunnel', 'registry.npmjs.org', JSON.stringify([http1('GET', '/fronted', 'evil.example', { connection: 'close' })]))).toBe('200');
    expect(await custom.probe('tunnel', 'registry.npmjs.org', JSON.stringify([http1('GET', '/sni', 'registry.npmjs.org', { connection: 'close' })]), 'evil.example')).toBe('200');
    expect(await custom.probe('tunnel', 'registry.npmjs.org', JSON.stringify([http1('GET', 'https://evil.example/absolute', 'registry.npmjs.org', { connection: 'close' })]))).toBe('403');
    expect(reached('registry.npmjs.org').map((s) => s.url)).toEqual(expect.arrayContaining(['/fronted', '/sni']));
    expect(egress.seen.filter((s) => `${s.sni} ${s.host} ${s.url}`.includes('evil'))).toEqual([]);
    expect(await custom.journal()).toContainEqual(expect.objectContaining({ host: 'registry.npmjs.org', path: 'https://evil.example/absolute', ok: false }));
  });

  it('checks each request of a tunnel: a write after a read on the same connection is refused', async () => {
    const pair = [http1('GET', '/repos/o/r', 'api.github.com'), http1('POST', '/gists', 'api.github.com', { connection: 'close' })];
    expect(await custom.probe('tunnel', 'api.github.com', JSON.stringify(pair))).toBe('200 403');
    expect(reached('api.github.com').map((s) => `${s.method} ${s.url}`)).toEqual(['GET /repos/o/r']);
  });

  it('lets through neither HTTP/2, nor an upgrade, nor another protocol on the relay', async () => {
    const before = egress.seen.length;
    expect(await custom.probe('tunnel', 'registry.npmjs.org', JSON.stringify([http1('GET', '/', 'registry.npmjs.org')]), 'registry.npmjs.org', 'h2')).toMatch(/^TLS /);
    const upgrade = http1('GET', '/', 'registry.npmjs.org', { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' });
    expect(await custom.probe('tunnel', 'registry.npmjs.org', JSON.stringify([upgrade]))).toBe('NONE');
    // A SOCKS5 greeting, then a TLS ClientHello's first bytes, straight to the relay.
    for (const bytes of ['\u0005\u0001\u0000', '\u0016\u0003\u0001\u0000¥\u0001']) expect(await custom.probe('raw', JSON.stringify(bytes))).not.toMatch(/ 200 /);
    expect(egress.seen.length).toBe(before);
    expect(await custom.journal()).toContainEqual(expect.objectContaining({ host: 'registry.npmjs.org', ok: false, reason: expect.stringMatching(/upgrade refused/) as string }));
  });

  it('ignores what the agent says of its run or its level, and tunnels to port 443 alone', async () => {
    const claims = JSON.stringify('Proxy-Authorization: Basic ZmFjdG9yeTpmdWxs\r\nX-Factory-Run: another-run\r\nX-Factory-Level: full\r\n');
    expect(await custom.probe('connect', 'example.com:443', claims)).toBe('HTTP/1.1 403 Forbidden');
    for (const target of ['registry.npmjs.org:80', 'github.com:22', 'github.com:9418']) expect(await custom.probe('connect', target), target).toBe('HTTP/1.1 403 Forbidden');
  });

  it("the step narrowed to the Claude API reaches neither the lists nor the repository's hosts; the control, the repository's run, does", async () => {
    expect(await custom.probe('fetch', 'https://docs.example.org/guide')).toMatch(/^200 /);
    expect(await custom.probe('fetch', 'https://docs.example.org/guide', 'POST', 'x')).toMatch(/^403 /);
    for (const url of ['https://docs.example.org/guide', 'https://registry.npmjs.org/', 'https://github.com/o/r']) expect(await narrowed.probe('fetch', url), url).toMatch(/^ERR /);
    // Its own: Claude Code's calls and the factory's MCP.
    expect(await narrowed.probe('fetch', 'https://api.anthropic.com/api/claude_code/settings')).toMatch(/^200 /);
    expect(await narrowed.probe('fetch', `${AGENT_API}/agent/mcp`, 'POST', '{}')).toMatch(/^200 /);
    expect(await narrowed.journal()).toContainEqual(expect.objectContaining({ method: 'CONNECT', host: 'docs.example.org', ok: false, reason: 'docs.example.org not allowed at claude-api' }));
  });

  it('at none, not even the Claude API nor the agent API', async () => {
    const before = egress.seen.length;
    expect(await none.probe('fetch', 'https://api.anthropic.com/api/claude_code/settings')).toMatch(/^ERR /);
    expect(await none.probe('fetch', `${AGENT_API}/agent/mcp`, 'POST', '{}')).toMatch(/^(ERR |403 )/);
    expect(egress.seen.length).toBe(before);
  });

  it('a run cannot be reopened at another level while its container lives, and full is never the agent’s', async () => {
    await expect(egress.proxy().open(narrowed.runId, { level: 'limited', allow: [] })).rejects.toThrow(/is open at claude-api/);
    expect(() => agentPolicy(repo, 'full')).toThrow(/reserved for setup/);
    // Still narrowed after the attempt.
    expect(await narrowed.probe('fetch', 'https://registry.npmjs.org/')).toMatch(/^ERR /);
  });
});
