import { execFileSync } from 'node:child_process';
import { request } from 'node:https';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cli, PUBLIC_IMAGE } from './helpers.js';

/**
 * The recipe of ORC-203 (docs/recette.md, critère 8): the whole stack on a real engine, under a project
 * name and ports of its own, then one runner created from inside `factoryd`, as the daemon creates them.
 * Skipped without FACTORY_COMPOSE=1, so no CI job runs it yet: it asks for an engine that can publish
 * ports and the two images already built, with FACTORY_RUNNER_IMAGE naming the runner's.
 *
 * No real `claude` runs here, and no ticket: the runner is driven by the sandbox provider directly.
 * It says the stack is rootless only where it checks it, that is without FACTORY_ALLOW_ROOTFUL_ENGINE.
 */
const enabled = process.env['FACTORY_COMPOSE'] === '1';
const runnerImage = process.env['FACTORY_RUNNER_IMAGE'] ?? '';
const rootfulAllowed = process.env['FACTORY_ALLOW_ROOTFUL_ENGINE'] === '1';
const parent = process.env['FACTORY_COMPOSE_DIR'] ?? '/tmp';
const base = `factory-recette-${Date.now()}`;
const dir = `${parent}/${base}`;
const HTTPS_PORT = process.env['FACTORY_HTTPS_PORT'] ?? '18443';
const PASSWORD = 'recette-ui-password';

const env = {
  ...process.env,
  FACTORY_DIR: dir,
  FACTORY_ENGINE_SOCKET: process.env['FACTORY_ENGINE_SOCKET'] ?? '/var/run/docker.sock',
  FACTORY_RUNNER_IMAGE: runnerImage,
  FACTORY_PUBLIC_HOST: 'localhost',
  FACTORY_HTTP_PORT: process.env['FACTORY_HTTP_PORT'] ?? '18080',
  FACTORY_HTTPS_PORT: HTTPS_PORT,
  FACTORY_UI_PASSWORD: PASSWORD,
  POSTGRES_PASSWORD: 'recettepostgres',
  ANTHROPIC_API_KEY: 'sk-recette-unused',
  GH_TOKEN: 'recette-unused',
};

const compose = (...args: string[]) =>
  execFileSync(cli, ['compose', '-p', 'factory-recette', ...args], { env, encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] });

/** As root in a throwaway container: the data's owner is an engine's uid, not this process's. */
const asEngineRoot = (script: string) =>
  execFileSync(cli, ['run', '--rm', '--mount', `type=bind,source=${parent},target=/base`, PUBLIC_IMAGE, 'sh', '-c', script], { encoding: 'utf8', timeout: 120_000 });

/** Runs in `factoryd`, with its uid, its CLI and its socket: what the daemon does at a run's start, then what the run does. */
const RUNNER_SCRIPT = String.raw`
import { readlinkSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const root = readlinkSync('/proc/1/cwd');
const load = (p) => import(join(root, 'dist/src', p));
const { ContainerSandboxProvider } = await load('adapters/sandbox/docker-rootless.js');
const { DEFAULT_REQUIREMENTS } = await load('adapters/sandbox/types.js');
const { EgressClient } = await load('network/proxy-service.js');
const home = process.env.FACTORY_HOME;
const egress = new EgressClient(process.env.FACTORY_EGRESS_CONTROL, console.error);
const provider = new ContainerSandboxProvider({ cli: 'docker', image: process.env.FACTORY_RUNNER_IMAGE, uid: process.getuid(), gid: process.getgid(), instance: 'recette', egress });
const runId = 'recette-run';
const ws = join(home, 'workspaces/recette');
mkdirSync(ws, { recursive: true });
const sbx = await provider.create({
  runId, ticketId: 'REC-1', workspacePath: ws, network: 'limited', requirements: DEFAULT_REQUIREMENTS,
  mounts: ['bin', 'package.json', 'node_modules', 'dist'].map((p) => ({ host: join(root, p), target: '/factory/app/' + p, readOnly: true })),
});
const out = { root };
try {
  const sh = async (script) => { const r = await provider.exec(sbx.id, ['sh', '-c', script]); return { code: r.code, out: (r.stdout + r.stderr).trim() }; };
  out.mounts = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .Mounts}}', sbx.id], { encoding: 'utf8' })).map((m) => m.Source + ' -> ' + m.Destination);
  out.networkMode = execFileSync('docker', ['inspect', '--format', '{{.HostConfig.NetworkMode}}', sbx.id], { encoding: 'utf8' }).trim();
  out.uid = await sh('id -u');
  out.socket = await sh('ls /var/run/docker.sock /run/docker.sock');
  out.versions = await sh('pnpm --version && uv --version && python3 --version && git --version && claude --version');
  out.agent = await sh('command -v factory-agent');
  out.pnpm = await sh('mkdir -p /work/js && cd /work/js && pnpm add is-odd@3.0.1 2>&1 && test -f node_modules/is-odd/package.json');
  out.uvInstall = await sh('cd /work && uv venv -q .v 2>&1 && uv pip install -q --python .v idna==3.10 2>&1 && .v/bin/python -c "import idna; print(idna.__version__)"');
  const fetch = (url, method) => "node -e \"fetch('" + url + "',{method:'" + method + "'}).then((r)=>console.log(r.status),(e)=>{console.log('failed',e.cause?.message??e.message);process.exit(1)})\"";
  out.refusedHost = await sh(fetch('https://example.com/', 'GET'));
  out.refusedMethod = await sh(fetch('https://registry.npmjs.org/is-odd', 'POST'));
  out.agentApi = await sh(fetch('http://host.docker.internal:4101/agent/issue', 'GET'));
  out.dns = await sh("node -e \"require('dns').lookup('registry.npmjs.org',(e)=>{console.log(e?e.code:'resolved')})\"");
  await sh('touch /work/from-runner');
  out.fileOwner = statSync(join(ws, 'from-runner')).uid === process.getuid();
} finally {
  await provider.destroy(sbx.id);
}
out.gone = execFileSync('docker', ['ps', '-a', '-q', '--filter', 'label=factory.attempt=' + runId], { encoding: 'utf8' }).trim();
out.journal = readFileSync(join(home, 'network', runId + '.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
await egress.closeAll();
console.log('RESULT ' + JSON.stringify(out));
process.exit(0);
`;

interface Result {
  root: string;
  mounts: string[];
  networkMode: string;
  uid: { out: string };
  socket: { code: number };
  versions: { code: number; out: string };
  agent: { code: number };
  pnpm: { code: number; out: string };
  uvInstall: { code: number; out: string };
  refusedHost: { out: string };
  refusedMethod: { out: string };
  agentApi: { out: string };
  dns: { out: string };
  fileOwner: boolean;
  gone: string;
  journal: { host: string; method: string; ok: boolean }[];
}

describe.skipIf(!enabled)(`the compose stack (${cli})`, () => {
  let result: Result;

  const https = (path: string, password?: string) =>
    new Promise<{ status: number; body: string }>((ok, ko) => {
      const req = request(
        { host: '127.0.0.1', servername: 'localhost', port: Number(HTTPS_PORT), path, rejectUnauthorized: false, headers: { host: 'localhost', ...(password ? { authorization: `Basic ${Buffer.from(`x:${password}`).toString('base64')}` } : {}) } },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => ok({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', ko);
      req.end();
    });

  beforeAll(async () => {
    if (!runnerImage) throw new Error('FACTORY_RUNNER_IMAGE names the runner image to test.');
    asEngineRoot(
      `cd /base && mkdir -p ${base}/data/network ${base}/repos ${base}/install ${base}/egress-ca && ` +
        `printf 'host: 0.0.0.0\\nport: 4100\\nrelay: { kind: none }\\nprojects: []\\nlimits: {}\\n' > ${base}/data/config.yaml && ` +
        `printf 'concurrency: 1\\n' > ${base}/data/factory.yml && chown -R 1000:1000 ${base}`,
    );
    compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '180');
    for (let i = 0; ; i++) {
      const up = await https('/api/state', PASSWORD).catch(() => undefined);
      if (up?.status === 200) break;
      if (i === 60) throw new Error(`factoryd n'a pas répondu par caddy :\n${compose('logs', '--tail', '40')}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    const output = compose('exec', '-T', 'factoryd', 'node', '--input-type=module', '-e', RUNNER_SCRIPT);
    const line = output.split('\n').find((l) => l.startsWith('RESULT '));
    if (!line) throw new Error(`le runner n'a rien rendu :\n${output}`);
    result = JSON.parse(line.slice('RESULT '.length)) as Result;
  }, 600_000);

  afterAll(() => {
    try {
      compose('down', '-v', '--timeout', '30');
    } finally {
      asEngineRoot(`rm -rf /base/${base}`);
    }
  }, 300_000);

  it('starts the four services', () => {
    const running = compose('ps', '--status', 'running', '--services').split('\n').filter(Boolean).sort();
    expect(running).toEqual(['caddy', 'factoryd', 'postgres', 'proxy']);
  });

  it.skipIf(rootfulAllowed)('runs them on a rootless engine', () => {
    expect(execFileSync(cli, ['info', '--format', '{{.SecurityOptions}}'], { encoding: 'utf8' })).toContain('rootless');
  });

  it.runIf(rootfulAllowed)('refuses this engine when it is not rootless and nothing allows it', () => {
    expect(() => compose('run', '--rm', '--no-deps', '-T', '-e', 'FACTORY_ALLOW_ROOTFUL_ENGINE=', 'factoryd', 'true')).toThrow(/rootless/);
  });

  it('answers in TLS through caddy, behind the password, on the store of postgres', async () => {
    expect((await https('/api/state')).status).toBe(401);
    const state = JSON.parse((await https('/api/state', PASSWORD)).body) as { capacity: { dev: { total: number } } };
    expect(state.capacity.dev.total).toBe(1);
    expect(compose('logs', 'factoryd')).toContain('store : Postgres');
  });

  it('publishes neither factoryd, the proxy nor postgres', () => {
    for (const s of ['factoryd', 'proxy', 'postgres']) {
      expect(compose('ps', '--format', '{{.Publishers}}', s).replace(/\s/g, ''), s).not.toMatch(/PublishedPort":[1-9]|:[1-9]\d*->/);
    }
  });

  it('keeps the authority out of factoryd', () => {
    expect(compose('exec', '-T', 'factoryd', 'sh', '-c', `test -e "${dir}/egress-ca/ca.key" && echo present || echo absent`).trim()).toBe('absent');
    expect(compose('exec', '-T', 'proxy', 'sh', '-c', `test -e "${dir}/egress-ca/ca.key" && echo present || echo absent`).trim()).toBe('present');
  });

  it('runs factoryd from the copy the engine can mount', () => {
    expect(result.root.startsWith(`${dir}/install/`)).toBe(true);
  });

  it('mounts no engine socket in a runner, and no network', () => {
    expect(result.mounts.length).toBeGreaterThan(0);
    expect(result.mounts.filter((m) => /docker\.sock|podman\.sock/.test(m))).toEqual([]);
    expect(result.socket.code).not.toBe(0);
    expect(result.networkMode).toBe('none');
    expect(result.dns.out).toBe('EAI_AGAIN');
  });

  it("creates the runner with the daemon's uid, and its files stay the daemon's", () => {
    expect(result.uid.out).toBe('1000');
    expect(result.fileOwner).toBe(true);
  });

  it('gives a runner node, pnpm, python, uv, git and claude', () => {
    expect(result.versions.code, result.versions.out).toBe(0);
    expect(result.agent.code).toBe(0);
  });

  it('installs with pnpm and uv through the proxy, and journals it', () => {
    expect(result.pnpm.code, result.pnpm.out).toBe(0);
    expect(result.uvInstall.code, result.uvInstall.out).toBe(0);
    expect(result.uvInstall.out).toContain('3.10');
    const hosts = result.journal.filter((e) => e.ok).map((e) => e.host);
    expect(hosts).toContain('registry.npmjs.org');
    expect(hosts).toContain('pypi.org');
  });

  it('refuses what the level refuses', () => {
    expect(result.refusedHost.out).not.toBe('200');
    expect(result.refusedMethod.out).toMatch(/^4\d\d$/);
    expect(result.journal.some((e) => e.host === 'example.com' && !e.ok)).toBe(true);
    expect(result.journal.some((e) => e.host === 'registry.npmjs.org' && e.method === 'POST' && !e.ok)).toBe(true);
  });

  it('reaches the agent API of factoryd through the proxy, without a run token refused', () => {
    expect(result.agentApi.out).toBe('401');
  });

  it('destroys the runner', () => {
    expect(result.gone).toBe('');
  });
});
