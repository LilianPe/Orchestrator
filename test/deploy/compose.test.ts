import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The deployment as written (ORC-203). A green file here proves the text, not the stack:
 * `test/isolation/compose-stack.test.ts` brings it up, and only the real server proves it rootless.
 */
const root = join(import.meta.dirname, '../..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

interface Service {
  volumes?: string[];
  ports?: string[];
  networks?: string[];
  environment?: Record<string, string | null>;
  privileged?: boolean;
}
const runner = read('docker/runner.Dockerfile');
const compose = parse(read('compose.yaml')) as { services: Record<string, Service>; networks: Record<string, { internal?: boolean }> };
const { factoryd, proxy, postgres, caddy } = compose.services as Record<'factoryd' | 'proxy' | 'postgres' | 'caddy', Service>;
const ENGINE = /docker\.sock|podman\.sock|ENGINE_SOCKET/;

/** `source:target[:mode]`, whose parts may hold `${VAR:?a message: with colons}`. */
const parts = (v: string) => v.match(/(?:\$\{[^}]*\}|[^:])+/g)!;
const FACTORY_DIR = /^\$\{FACTORY_DIR(:\?[^}]*)?\}/;
const sameSide = (p: string) => p.replace(FACTORY_DIR, '${FACTORY_DIR}');

describe('compose.yaml (ORC-203)', () => {
  it('declares the four services of the doc, and no other', () => {
    expect(Object.keys(compose.services).sort()).toEqual(['caddy', 'factoryd', 'postgres', 'proxy']);
  });

  it('gives the engine socket to factoryd alone', () => {
    expect(factoryd.volumes!.filter((v) => ENGINE.test(v))).toHaveLength(1);
    for (const s of [proxy, postgres, caddy]) expect((s.volumes ?? []).filter((v) => ENGINE.test(v))).toEqual([]);
  });

  it('fixes the sandboxes, so verify never runs in factoryd and has nothing to fall back on (ORC-151)', () => {
    expect(factoryd.environment!['FACTORY_CONTAINER_CLI']).toBe('docker');
    expect(factoryd.environment!).not.toHaveProperty('FACTORY_ALLOW_HOST_VERIFY');
    // The engine resolves the clone's mount on the host: it lives under the home, mounted at the same path.
    expect(factoryd.environment!['FACTORY_HOME']).toBe('${FACTORY_DIR}/data');
    expect(factoryd.volumes!.map(parts).some(([source, target]) => sameSide(source!) === '${FACTORY_DIR}/data' && target === '${FACTORY_DIR}/data')).toBe(true);
  });

  it('runs nothing privileged', () => {
    for (const s of Object.values(compose.services)) expect(s.privileged).toBeUndefined();
  });

  it('mounts what a runner mounts at the same path on both sides: the engine resolves it on the host', () => {
    for (const s of [factoryd, proxy]) {
      for (const v of s.volumes!.filter((x) => !ENGINE.test(x))) {
        const [source, target] = parts(v);
        expect(sameSide(source!), v).toBe(sameSide(target!));
        expect(source, v).toMatch(FACTORY_DIR);
      }
    }
  });

  it("keeps the proxy's authority out of factoryd, and the daemon's data out of the proxy", () => {
    expect(factoryd.volumes!.filter((v) => v.includes('egress-ca'))).toEqual([]);
    expect(proxy.volumes!.filter((v) => v.includes('egress-ca'))).toHaveLength(1);
    for (const v of proxy.volumes!) expect(parts(v)[1], v).toMatch(/\/data\/network$|\/egress-ca$/);
  });

  it('hands the proxy no secret', () => {
    const names = Object.keys(proxy.environment ?? {});
    expect(names.filter((k) => /TOKEN|KEY|SECRET|PASSWORD|DATABASE/.test(k))).toEqual([]);
  });

  it('points factoryd at the proxy service, and the proxy back at the agent API', () => {
    expect(factoryd.environment!['FACTORY_EGRESS_CONTROL']).toMatch(/\/data\/network\/control\.sock$/);
    expect(proxy.environment!['FACTORY_EGRESS_CONTROL']).toBe(factoryd.environment!['FACTORY_EGRESS_CONTROL']);
    expect(factoryd.environment!['FACTORY_AGENT_HOST']).toBe('0.0.0.0');
    expect(proxy.environment!['FACTORY_AGENT_UPSTREAM']).toBe('factoryd');
    expect(proxy.environment!['FACTORY_AGENT_PORT']).toBe(factoryd.environment!['FACTORY_AGENT_PORT']);
  });

  it('turns the sandboxes on: without FACTORY_CONTAINER_CLI a run goes on the host', () => {
    expect(factoryd.environment!['FACTORY_CONTAINER_CLI']).toBe('docker');
    expect(factoryd.environment!['FACTORY_RUNNER_IMAGE']).toMatch(/^\$\{FACTORY_RUNNER_IMAGE:\?/);
  });

  it('publishes caddy alone, and keeps postgres on an internal network', () => {
    expect(caddy.ports!.length).toBeGreaterThan(0);
    for (const s of [factoryd, proxy, postgres]) expect(s.ports).toBeUndefined();
    expect(postgres.networks).toEqual(['back']);
    expect(compose.networks['back']!.internal).toBe(true);
    expect(caddy.networks ?? ['default']).not.toContain('back');
    // The proxy parses what the runners send: a flaw there must not reach the base.
    expect(proxy.networks ?? ['default']).not.toContain('back');
  });

  it('keeps GH_TOKEN for factoryd until ORC-181', () => {
    expect(factoryd.environment!['GH_TOKEN']).toMatch(/^\$\{GH_TOKEN:\?/);
  });

  it('reads the store from postgres', () => {
    expect(factoryd.environment!['FACTORY_DATABASE_URL']).toMatch(/@postgres:5432\/factory$/);
  });
});

describe('the images (ORC-203)', () => {
  const daemon = read('Dockerfile');

  it('pins pnpm and uv in the runner image, at the versions the sealed setup was measured on', () => {
    expect(runner).toMatch(/\bpnpm@10\.20\.\d+/);
    expect(runner).toMatch(/\buv==0\.13\.\d+/);
    expect(runner).toMatch(/\bpython3\b/);
  });

  it('takes no secret at build time', () => {
    for (const f of [runner, daemon]) expect(f).not.toMatch(/^\s*(ARG|ENV)\s+\S*(TOKEN|SECRET|PASSWORD|API_KEY)/im);
    // FACTORY_DIR may be the checkout: the authority's key must not reach `COPY . .`.
    expect(read('.dockerignore').split(/\r?\n/)).toEqual(expect.arrayContaining(['.env', '.env.*', 'install', 'egress-ca']));
  });

  it('runs no agent in the daemon image, which keeps gh until ORC-181 and gains the engine CLI', () => {
    expect(daemon).not.toContain('claude-code');
    expect(daemon).toMatch(/install -y[^\n]* gh\b/);
    expect(daemon).toMatch(/docker-\$\{?DOCKER_CLI_VERSION\}?\.tgz/);
  });

  it('labels each attempt with the commit of the build', () => {
    expect(daemon).toMatch(/ARG FACTORY_COMMIT/);
    expect(daemon).toMatch(/ENV [^\n]*FACTORY_COMMIT=\$FACTORY_COMMIT/);
    expect(read('compose.yaml')).toMatch(/FACTORY_COMMIT: \$\{FACTORY_COMMIT:-\}/);
  });
});

/** ORC-369: a 504 from GitHub's releases turned the isolation job red, unrelated to the diff. */
describe('the gitleaks archive of the isolation job (ORC-369)', () => {
  type Step = { uses?: string; with?: Record<string, string>; run?: string };
  const job = (parse(read('.github/workflows/ci.yml')) as { jobs: Record<string, { env: Record<string, string>; steps: Step[] }> }).jobs['isolation']!;
  const [, version, sha256] = /gitleaks_([\d.]+)_linux_x64\.tar\.gz[\s\S]*?\b([0-9a-f]{64}) {2}\/tmp\/gitleaks\.tgz/.exec(runner) ?? [];

  it('caches the archive the runner image pins, keyed on its version and checksum', () => {
    expect(job.env).toMatchObject({ GITLEAKS_VERSION: version, GITLEAKS_SHA256: sha256 });
    const restore = job.steps.find((s) => s.uses?.startsWith('actions/cache/restore@'));
    expect(restore?.with?.['key']).toMatch(/\$\{\{ env\.GITLEAKS_VERSION \}\}.*\$\{\{ env\.GITLEAKS_SHA256 \}\}/);
    // On a miss: downloaded with retries and checked, before both builds of it, the runner image's and verify-hostile's.
    const download = job.steps.find((s) => s.run?.includes('releases/download'));
    expect(download?.run).toMatch(/curl [^\n]*--retry \d+/);
    expect(download?.run).toMatch(/sha256sum -c/);
    expect(job.steps.indexOf(download!)).toBeLessThan(job.steps.findIndex((s) => s.run?.includes('podman build')));
  });

  it('takes the archive from the build context when it is there, its checksum checked either way', () => {
    const install = /^RUN --mount=type=bind,target=\/context[\s\S]*?rm \/tmp\/gitleaks\.tgz$/m.exec(runner)?.[0].replace(/\s*\\\n\s*/g, ' ');
    // The copy, else the download, and then, for either one, the checksum.
    expect(install).toMatch(/ cp \/context\/(\S+) \/tmp\/gitleaks\.tgz 2>\/dev\/null \|\| node -e "fetch\('https:\/\/github\.com\/[^']*\/\1'\)[^"]*" && echo "\S+ {2}\/tmp\/gitleaks\.tgz" \| sha256sum -c - && /);
    // The copied file and the release's tag and file: one version, the cache's.
    expect(install?.match(/\d+\.\d+\.\d+/g)).toEqual(Array(3).fill(version));
    expect(install).toContain(`echo "${sha256}  /tmp/gitleaks.tgz"`);
  });
});
