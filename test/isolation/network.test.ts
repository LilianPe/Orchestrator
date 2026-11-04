import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NetworkLevel, Sandbox } from '../../src/adapters/sandbox/types.js';
import { EgressProxy, type EgressEntry } from '../../src/network/proxy.js';
import { cli, enabled, image, useSandboxes } from './helpers.js';

/**
 * ORC-213: the sandbox runs `--network none` and gets out through the egress proxy alone.
 *
 * On Linux (the CI, the server) the proxy runs in this process, as in the daemon: its socket, made by
 * this user, bind-mounted into the sandbox, which runs as this user (`--userns=keep-id` under Podman).
 * Elsewhere (Docker Desktop on Windows or macOS) a host Unix socket does not cross into the engine's
 * VM: the proxy runs in a helper container, its socket shared from that container's volume. Under
 * rootless Podman that helper would not do: its socket belongs to a sub-uid of the user namespace,
 * which the sandbox's keep-id user cannot open.
 */
const inProcess = process.platform === 'linux';
const helper = `isolation-egress-${Date.now()}`;
const levels: NetworkLevel[] = ['limited', 'none'];
let bundleDir = '';
/** The proxy the provider opens runs on: the real one in this process, or the helper's sockets. */
let impl: Pick<EgressProxy, 'open' | 'close' | 'isOpen' | 'caCertPath'>;
let readJournal: (runId: string) => string = () => '';
/** A new daemon's proxy on the same dirs, the first one not closed: as after a kill -9, its socket bound anew (ORC-220). */
let rebind: () => Promise<void> = async () => {};
let agentServer: Server | undefined;

const engine = (args: string[]) => execFileSync(cli, args, { encoding: 'utf8', timeout: 300_000 }).trim();

describe.skipIf(!enabled)(`egress proxy (${cli})`, () => {
  const { create, request, sh } = useSandboxes('net', {
    egress: {
      open: (runId, policy) => impl.open(runId, policy),
      close: (runId) => impl.close(runId),
      isOpen: (runId) => impl.isOpen(runId),
      get caCertPath() {
        return impl.caCertPath;
      },
    },
  });
  const runIds = Object.fromEntries(levels.map((l) => [l, request().runId])) as Record<NetworkLevel, string>;
  const sbx: Partial<Record<NetworkLevel, Sandbox>> = {};

  const run = async (level: NetworkLevel, script: string) => {
    const r = await sh(sbx[level]!.id, script);
    return { code: r.code, out: `${r.stdout}${r.stderr}`.trim() };
  };
  const fetchIn = (url: string, method = 'GET') =>
    `node -e "fetch('${url}',{method:'${method}'}).then(r=>console.log(r.status),e=>{console.log('ERR',e.cause?.code??e.message);process.exit(3)})"`;
  const journal = (level: NetworkLevel): EgressEntry[] => {
    const text = readJournal(runIds[level]).trim();
    return text ? text.split('\n').map((l) => JSON.parse(l) as EgressEntry) : [];
  };
  /** The relay is the container's PID 1: up a moment after the container. */
  const relayUp = async (level: NetworkLevel) => {
    const probe = `node -e "require('net').connect(3128,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"`;
    expect((await run(level, `for i in $(seq 50); do ${probe} && exit 0; sleep 0.1; done; exit 1`)).code).toBe(0);
  };

  /** The daemon's way: the proxy here, a stand-in agent API on the loopback. */
  async function startInProcess(): Promise<void> {
    bundleDir = mkdtempSync(join(tmpdir(), 'factory-egress-'));
    agentServer = createServer((req, res) => res.end(`agent ${req.method} ${req.url}`));
    await new Promise<void>((ok) => agentServer!.listen(0, '127.0.0.1', ok));
    const to = { host: '127.0.0.1', port: (agentServer.address() as AddressInfo).port };
    const make = () => new EgressProxy({ dir: join(bundleDir, 'network'), caDir: join(bundleDir, 'ca'), agentApi: { host: 'host.docker.internal', port: 4101, to } });
    const proxy = make();
    impl = proxy;
    readJournal = (runId) => (existsSync(proxy.journalPath(runId)) ? readFileSync(proxy.journalPath(runId), 'utf8') : '');
    rebind = async () => {
      const again = make();
      for (const level of levels) await again.open(runIds[level], { level, allow: [] });
    };
  }

  /** Docker Desktop's way: the proxy in a helper container, its sockets in that container's volume. */
  async function startHelper(): Promise<void> {
    bundleDir = mkdtempSync(join(tmpdir(), 'factory-egress-'));
    // The proxy as the daemon runs it, one socket per run handed to the sandbox user, and a stand-in agent API.
    await build({
      stdin: {
        contents: `
          import { chownSync } from 'node:fs';
          import { createServer } from 'node:http';
          import { dirname, relative } from 'node:path';
          import { EgressProxy } from './src/network/proxy.ts';
          const [dir, uid, gid, ...runs] = process.argv.slice(2);
          createServer((req, res) => res.end('agent ' + req.method + ' ' + req.url)).listen(4101, '127.0.0.1');
          const make = () => new EgressProxy({ dir, caDir: dir + '/ca', agentApi: { host: 'host.docker.internal', port: 4101, to: { host: '127.0.0.1', port: 4101 } } });
          const proxy = make();
          (async () => {
            const names = {};
            for (const r of runs) {
              const [id, level] = r.split('=');
              const path = await proxy.open(id, { level, allow: [] });
              // The run's dir is the sandbox's mount (ORC-220).
              for (const p of [dirname(path), path]) chownSync(p, Number(uid), Number(gid));
              names[id] = relative(dir, path);
            }
            console.log(JSON.stringify(names));
          })();
          process.on('SIGUSR1', async () => {
            const again = make();
            for (const r of runs) {
              const [id, level] = r.split('=');
              const path = await again.open(id, { level, allow: [] });
              chownSync(path, Number(uid), Number(gid));
            }
            console.log('rebound');
          });`,
        resolveDir: resolve(import.meta.dirname, '../..'),
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
      image, 'node', '/app/egress.cjs', '/run/egress', String(process.getuid?.() ?? 1000), String(process.getgid?.() ?? 1000),
      ...levels.map((l) => `${runIds[l]}=${l}`),
    ]);
    let names: Record<string, string> = {};
    for (let i = 0; i < 100 && !Object.keys(names).length; i++) {
      const line = engine(['logs', helper]).split('\n').find((l) => l.startsWith('{'));
      if (line) names = JSON.parse(line) as Record<string, string>;
      else await new Promise((r) => setTimeout(r, 100));
    }
    if (!Object.keys(names).length) throw new Error(`egress proxy not up:\n${engine(['logs', helper])}`);
    // The anonymous volume, as the engine names it: a bind of a file in it reaches the socket.
    const volume = engine(['inspect', '--format', '{{range .Mounts}}{{if eq .Destination "/run/egress"}}{{.Source}}{{end}}{{end}}', helper]);
    const sockets = Object.fromEntries(Object.entries(names).map(([id, name]) => [id, `${volume}/${name}`]));
    impl = { open: async (runId) => sockets[runId]!, close: async () => {}, isOpen: () => true, caCertPath: `${volume}/ca/ca.crt` };
    readJournal = (runId) => engine(['exec', helper, 'sh', '-c', `cat /run/egress/${runId}.jsonl 2>/dev/null || true`]);
    rebind = async () => {
      engine(['kill', '-s', 'USR1', helper]);
      for (let i = 0; i < 100 && !engine(['logs', helper]).includes('rebound'); i++) await new Promise((r) => setTimeout(r, 100));
    };
  }

  beforeAll(async () => {
    await (inProcess ? startInProcess() : startHelper());
    for (const level of levels) {
      sbx[level] = await create({ runId: runIds[level], network: level });
      await relayUp(level);
    }
  }, 300_000);

  afterAll(async () => {
    // The sandboxes are useSandboxes'; the helper goes with its anonymous volume.
    if (inProcess) {
      await (impl as EgressProxy | undefined)?.closeAll();
      await new Promise((ok) => (agentServer ? agentServer.close(ok) : ok(undefined)));
    } else execFileSync(cli, ['rm', '-f', '-v', helper], { stdio: 'ignore' });
    if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
  }, 120_000);

  it('limited: an npm registry GET goes through the proxy, decrypted, journaled with its method, path and size', async () => {
    const r = await run('limited', 'HOME=/tmp npm view is-number@7.0.0 version');
    expect(r).toMatchObject({ code: 0, out: expect.stringContaining('7.0.0') as string });
    const hit = journal('limited').find((e) => e.host === 'registry.npmjs.org');
    expect(hit).toMatchObject({ method: 'GET', path: '/is-number', ok: true });
    expect(hit!.down).toBeGreaterThan(0);
  });

  it('limited: an https GET to a docs host passes, journaled with its path; a POST to it is refused', async () => {
    expect(await run('limited', fetchIn('https://nodejs.org/en/about'))).toMatchObject({ code: 0, out: '200' });
    expect(journal('limited')).toContainEqual(expect.objectContaining({ method: 'GET', host: 'nodejs.org', path: '/en/about', ok: true }));
    expect(await run('limited', fetchIn('https://nodejs.org/en/about', 'POST'))).toMatchObject({ out: '403' });
    expect(journal('limited')).toContainEqual(expect.objectContaining({ method: 'POST', host: 'nodejs.org', path: '/en/about', ok: false }));
  });

  it('limited: a host off the lists is refused and journaled', async () => {
    expect((await run('limited', fetchIn('https://example.com/'))).code).toBe(3);
    expect(journal('limited')).toContainEqual(expect.objectContaining({ method: 'CONNECT', host: 'example.com', ok: false }));
  });

  it('limited: a write to GitHub is refused and journaled', async () => {
    expect(await run('limited', fetchIn('https://api.github.com/gists', 'POST'))).toMatchObject({ out: '403' });
    expect(journal('limited')).toContainEqual(expect.objectContaining({ method: 'POST', host: 'api.github.com', path: '/gists', ok: false }));
  });

  it('limited: git fetches from GitHub through the proxy, and cannot push (an image with git)', async () => {
    if ((await run('limited', 'command -v git')).code !== 0) return;
    expect(await run('limited', 'git ls-remote https://github.com/octocat/Hello-World HEAD')).toMatchObject({ code: 0, out: expect.stringMatching(/HEAD/) as string });
    const push = 'cd $(mktemp -d) && git init -q && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m x && git push https://github.com/octocat/Hello-World HEAD:refs/heads/x';
    expect((await run('limited', push)).code).not.toBe(0);
    expect(journal('limited')).toContainEqual(expect.objectContaining({ host: 'github.com', path: '/octocat/Hello-World/info/refs', ok: false }));
  });

  it('limited: the factory MCP, a POST to the agent API, goes through the relay', async () => {
    const mcp = `node -e "fetch('http://host.docker.internal:4101/agent/mcp',{method:'POST',body:'{}'}).then(r=>r.text()).then(t=>console.log(t),e=>{console.log('ERR',e.cause?.code??e.message);process.exit(3)})"`;
    expect(await run('limited', mcp)).toMatchObject({ code: 0, out: 'agent POST /agent/mcp' });
  });

  it('resolves no name, opens no TCP or UDP socket of its own', async () => {
    expect((await run('limited', 'getent hosts registry.npmjs.org')).code).not.toBe(0);
    const tcp = `node -e "require('net').connect(443,'1.1.1.1').on('connect',()=>process.exit(0)).on('error',e=>{console.log(e.code);process.exit(3)})"`;
    expect(await run('limited', tcp)).toMatchObject({ code: 3 });
    const udp = `node -e "require('dgram').createSocket('udp4').send('x',53,'1.1.1.1',e=>{console.log(e?.code);process.exit(e?3:0)})"`;
    expect(await run('limited', udp)).toMatchObject({ code: 3 });
  });

  it('a living container gets out again through the socket a new daemon binds: its mount is the dir, not the socket (ORC-220)', async () => {
    const mcp = `node -e "fetch('http://host.docker.internal:4101/agent/mcp',{method:'POST',body:'{}'}).then(r=>r.text()).then(t=>console.log(t),e=>{console.log('ERR',e.cause?.code??e.message);process.exit(3)})"`;
    await rebind();
    expect(await run('limited', mcp)).toMatchObject({ code: 0, out: 'agent POST /agent/mcp' });
    // The mount is read-only: the agent cannot put a socket of its own in place of the proxy's.
    expect((await run('limited', 'touch /run/factory/egress/x')).code).not.toBe(0);
  });

  it('none: nothing passes, not even the Claude API', async () => {
    expect((await run('none', 'HOME=/tmp npm view is-number@7.0.0 version')).code).not.toBe(0);
    expect((await run('none', fetchIn('https://api.anthropic.com/'))).code).toBe(3);
    const entries = journal('none');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => !e.ok)).toBe(true);
  });
});
