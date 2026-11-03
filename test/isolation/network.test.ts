import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerSandboxProvider } from '../../src/adapters/sandbox/docker-rootless.js';
import { DEFAULT_REQUIREMENTS, type NetworkLevel, type Sandbox } from '../../src/adapters/sandbox/types.js';
import type { EgressEntry } from '../../src/network/proxy.js';

/**
 * ORC-213: the sandbox runs `--network none` and gets out through the egress proxy alone. The proxy
 * runs in a container of its own, on the engine's side: a Unix socket made on a Windows or macOS
 * host does not cross into Docker Desktop's VM, and the daemon is a Linux one anyway.
 */
const enabled = process.env['FACTORY_ISOLATION'] === '1';
const cli = process.env['FACTORY_CONTAINER_CLI'] ?? 'podman';
const image = process.env['FACTORY_RUNNER_IMAGE'] ?? 'docker.io/library/node:24.22.1-bookworm-slim';
const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;

const prefix = `isolation-net-${Date.now()}`;
const runs: Record<string, NetworkLevel> = { [`${prefix}-limited`]: 'limited', [`${prefix}-none`]: 'none' };
const helper = `${prefix}-egress`;
let bundleDir = '';
let workspace = '';
/** The runs' sockets on the engine's side, by run id. */
let sockets: Record<string, string> = {};

const provider = new ContainerSandboxProvider({
  cli,
  image,
  uid,
  gid,
  egress: {
    open: async (runId) => sockets[runId]!,
    close: async () => {},
  },
});

const engine = (args: string[]) => execFileSync(cli, args, { encoding: 'utf8', timeout: 300_000 }).trim();

/** Its exit code and output, inside the sandbox. */
async function run(sbx: Sandbox, script: string): Promise<{ code: number; out: string }> {
  const r = await provider.exec(sbx.id, ['sh', '-c', script]);
  return { code: r.code, out: (r.stdout + r.stderr).trim() };
}

const fetchIn = (url: string, method = 'GET') =>
  `node -e "fetch('${url}',{method:'${method}'}).then(r=>console.log(r.status),e=>{console.log('ERR',e.cause?.code??e.message);process.exit(3)})"`;

/** Node's http module, not fetch: fetch tunnels an http:// URL too, http sends it to the proxy whole. */
const postIn = (url: string) =>
  `node -e "require('http').request('${url}',{method:'POST'},r=>console.log(r.statusCode)).on('error',e=>{console.log('ERR',e.code);process.exit(3)}).end()"`;

const journal = (runId: string): EgressEntry[] => {
  const text = engine(['exec', helper, 'sh', '-c', `cat /run/egress/${runId}.jsonl 2>/dev/null || true`]);
  return text ? text.split('\n').map((l) => JSON.parse(l) as EgressEntry) : [];
};

/** The relay is the container's PID 1: up a moment after the container. */
async function relayUp(sbx: Sandbox): Promise<void> {
  const probe = `node -e "require('net').connect(3128,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"`;
  expect((await run(sbx, `for i in $(seq 50); do ${probe} && exit 0; sleep 0.1; done; exit 1`)).code).toBe(0);
}

describe.skipIf(!enabled)(`egress proxy (${cli})`, () => {
  const sbx: Record<string, Sandbox> = {};

  beforeAll(async () => {
    engine(['pull', '-q', image]);
    bundleDir = mkdtempSync(join(tmpdir(), 'factory-egress-'));
    const root = resolve(import.meta.dirname, '../..');
    // The proxy as the daemon runs it, one socket per run, handed to the sandbox user.
    await build({
      stdin: {
        contents: `
          import { chownSync } from 'node:fs';
          import { basename } from 'node:path';
          import { EgressProxy } from './src/network/proxy.ts';
          const [dir, uid, gid, ...runs] = process.argv.slice(2);
          const proxy = new EgressProxy({ dir });
          (async () => {
            const names = {};
            for (const r of runs) {
              const [id, level] = r.split('=');
              const path = await proxy.open(id, { level, allow: [] });
              chownSync(path, Number(uid), Number(gid));
              names[id] = basename(path);
            }
            console.log(JSON.stringify(names));
          })();`,
        resolveDir: root,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      // CommonJS: yaml, pulled in by the levels, requires node built-ins.
      format: 'cjs',
      target: 'node24',
      outfile: join(bundleDir, 'egress.cjs'),
    });
    engine([
      'run', '-d', '--name', helper, '--label', 'factory.isolation-test=egress',
      '--mount', `type=bind,source=${bundleDir},target=/app,readonly`, '-v', '/run/egress',
      image, 'node', '/app/egress.cjs', '/run/egress', String(uid), String(gid),
      ...Object.entries(runs).map(([id, level]) => `${id}=${level}`),
    ]);
    let names: Record<string, string> = {};
    for (let i = 0; i < 100 && !Object.keys(names).length; i++) {
      const line = engine(['logs', helper]).split('\n').find((l) => l.startsWith('{'));
      if (line) names = JSON.parse(line) as Record<string, string>;
      else await new Promise((r) => setTimeout(r, 100));
    }
    if (!Object.keys(names).length) throw new Error(`egress proxy not up:
${engine(['logs', helper])}`);
    // The anonymous volume, as the engine names it: a bind of a file in it reaches the socket.
    const volume = engine(['inspect', '--format', '{{range .Mounts}}{{if eq .Destination "/run/egress"}}{{.Source}}{{end}}{{end}}', helper]);
    sockets = Object.fromEntries(Object.entries(names).map(([id, name]) => [id, `${volume}/${name}`]));
    workspace = mkdtempSync(join(tmpdir(), 'factory-iso-'));
    for (const [runId, network] of Object.entries(runs)) {
      sbx[network] = await provider.create({ runId, ticketId: 'ISO-1', workspacePath: workspace, network, requirements: DEFAULT_REQUIREMENTS, mounts: [] });
      await relayUp(sbx[network]);
    }
  }, 300_000);

  afterAll(async () => {
    const ours = (await provider.list()).filter((x) => x.runId.startsWith(prefix));
    await Promise.all(ours.map((x) => provider.destroy(x.sandbox.id)));
    // With its anonymous volume.
    execFileSync(cli, ['rm', '-f', '-v', helper], { stdio: 'ignore' });
    for (const d of [bundleDir, workspace]) if (d) rmSync(d, { recursive: true, force: true });
  }, 120_000);

  const limited = () => journal(`${prefix}-limited`);

  it('limited: an npm registry GET goes through the proxy, journaled with its host, method and size', async () => {
    const r = await run(sbx['limited']!, 'HOME=/tmp npm view is-number@7.0.0 version');
    expect(r).toMatchObject({ code: 0, out: expect.stringContaining('7.0.0') as string });
    const hit = limited().find((e) => e.host === 'registry.npmjs.org');
    expect(hit).toMatchObject({ method: 'GET', ok: true });
    expect(hit!.down).toBeGreaterThan(0);
  });

  it('limited: a tunnel to a doc host passes', async () => {
    expect(await run(sbx['limited']!, fetchIn('https://nodejs.org/en'))).toMatchObject({ code: 0, out: '200' });
    expect(limited()).toContainEqual(expect.objectContaining({ method: 'CONNECT', host: 'nodejs.org', ok: true }));
  });

  it('limited: a host off the lists is refused and journaled', async () => {
    expect((await run(sbx['limited']!, fetchIn('https://example.com/'))).code).toBe(3);
    expect(limited()).toContainEqual(expect.objectContaining({ method: 'CONNECT', host: 'example.com', ok: false }));
  });

  it('limited: a write to GitHub is refused and journaled', async () => {
    expect(await run(sbx['limited']!, postIn('http://api.github.com/gists'))).toMatchObject({ out: '403' });
    expect((await run(sbx['limited']!, fetchIn('https://api.github.com/gists', 'POST'))).code).toBe(3);
    expect(limited()).toContainEqual(expect.objectContaining({ method: 'POST', host: 'api.github.com', ok: false }));
    expect(limited()).toContainEqual(expect.objectContaining({ method: 'CONNECT', host: 'api.github.com', ok: false }));
  });

  it('resolves no name, opens no TCP or UDP socket of its own', async () => {
    const s = sbx['limited']!;
    expect((await run(s, 'getent hosts registry.npmjs.org')).code).not.toBe(0);
    const tcp = `node -e "require('net').connect(443,'1.1.1.1').on('connect',()=>process.exit(0)).on('error',e=>{console.log(e.code);process.exit(3)})"`;
    expect(await run(s, tcp)).toMatchObject({ code: 3 });
    const udp = `node -e "require('dgram').createSocket('udp4').send('x',53,'1.1.1.1',e=>{console.log(e?.code);process.exit(e?3:0)})"`;
    expect(await run(s, udp)).toMatchObject({ code: 3 });
  });

  it('none: nothing passes, not even the Claude API', async () => {
    const s = sbx['none']!;
    expect((await run(s, 'HOME=/tmp npm view is-number@7.0.0 version')).code).not.toBe(0);
    expect((await run(s, fetchIn('https://api.anthropic.com/'))).code).toBe(3);
    const entries = journal(`${prefix}-none`);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => !e.ok)).toBe(true);
  });
});
