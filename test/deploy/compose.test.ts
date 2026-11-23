import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runDoctor, type WorkflowReport } from '../../src/cli/doctor.js';
import { GITHUB_APP_PERMISSIONS } from '../../src/cli/init.js';

/**
 * The deployment as written (ORC-203). A green file here proves the text, not the stack:
 * `test/isolation/compose-stack.test.ts` brings it up, and only the real server proves it rootless.
 */
const root = join(import.meta.dirname, '../..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

interface Service {
  profiles?: string[];
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
    // Exposed, factoryd refuses to start without secrets_key (ORC-398): its env: reference gets a slot.
    expect(factoryd.environment!).toHaveProperty('FACTORY_SECRETS_KEY');
    expect(proxy.environment!['FACTORY_AGENT_UPSTREAM']).toBe('factoryd');
    expect(proxy.environment!['FACTORY_AGENT_PORT']).toBe(factoryd.environment!['FACTORY_AGENT_PORT']);
  });

  it('turns the sandboxes on: without FACTORY_CONTAINER_CLI a run goes on the host', () => {
    expect(factoryd.environment!['FACTORY_CONTAINER_CLI']).toBe('docker');
    expect(factoryd.environment!['FACTORY_RUNNER_IMAGE']).toMatch(/^\$\{FACTORY_RUNNER_IMAGE:\?/);
  });

  it('hands factoryd the capture image when the server has one, and asks for none (ORC-404)', () => {
    // Unset here, unset in the container: the visual proof is then unavailable, said at the start and by `factory doctor`.
    expect(factoryd.environment).toHaveProperty('FACTORY_BROWSER_IMAGE', null);
  });

  it("leaves TLS to the host's reverse proxy: caddy only under the `tls` profile, off by default (ORC-221)", () => {
    expect(caddy.profiles).toEqual(['tls']);
    for (const s of [factoryd, proxy, postgres]) expect(s.profiles).toBeUndefined();
    // Compose interpolates a service off its profile too: a `:?` there would stop a plain `up` without caddy's variables.
    expect(JSON.stringify(caddy)).not.toMatch(/\$\{[^}]*:\?/);
  });

  it("answers the runners' agent API 404 under the public name: they reach it through the proxy service (ORC-221)", () => {
    expect(read('docker/Caddyfile')).toMatch(/@agent path \/agent \/agent\/\*\s+respond @agent 404\s+reverse_proxy factoryd:4100/);
  });

  it("publishes factoryd on the host's loopback alone, for its reverse proxy, and caddy under its profile (ORC-221)", () => {
    expect(factoryd.ports).toEqual(['127.0.0.1:${FACTORY_LOOPBACK_PORT:-4100}:4100']);
    expect(caddy.ports!.length).toBeGreaterThan(0);
    for (const s of [proxy, postgres]) expect(s.ports).toBeUndefined();
    expect(postgres.networks).toEqual(['back']);
    expect(compose.networks['back']!.internal).toBe(true);
    expect(caddy.networks ?? ['default']).not.toContain('back');
    // The proxy parses what the runners send: a flaw there must not reach the base.
    expect(proxy.networks ?? ['default']).not.toContain('back');
  });

  it('asks no GH_TOKEN: the daemon reads and publishes by its GitHub App alone (ORC-181)', () => {
    expect(read('compose.yaml')).not.toContain('GH_TOKEN');
    expect(read('docker/entrypoint.sh')).not.toMatch(/\bgh\b|GH_TOKEN/);
  });

  // ORC-399: factoryd listens beyond its loopback, so its dashboard is reached through a GitHub sign-in; no shared password.
  it("passes the App's OAuth client of the dashboard's GitHub sign-in through as it is, and no UI password", () => {
    // Passed as is: factory.yml may name them (`client_secret: env:GH_APP_CLIENT_SECRET`); factoryd refuses to start without a client.
    expect(factoryd.environment!['GH_APP_CLIENT_ID']).toBeNull();
    expect(factoryd.environment!['GH_APP_CLIENT_SECRET']).toBeNull();
    expect(factoryd.environment!).not.toHaveProperty('FACTORY_UI_PASSWORD');
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

  it('runs no agent in the daemon image, which has no gh (ORC-181) and gains the engine CLI', () => {
    expect(daemon).not.toContain('claude-code');
    expect(daemon).not.toMatch(/\bgh\b|cli\.github\.com/);
    expect(daemon).toMatch(/docker-\$\{?DOCKER_CLI_VERSION\}?\.tgz/);
  });

  it('builds the capture image on the runner image, with a pinned Playwright, its headless Chromium alone, and the label the daemon checks (ORC-404)', () => {
    const browser = read('docker/browser.Dockerfile');
    expect(browser).toMatch(/^ARG RUNNER_IMAGE\nFROM \$\{RUNNER_IMAGE\}$/m);
    expect(browser).toMatch(/^ARG PLAYWRIGHT_VERSION=\d+\.\d+\.\d+$/m);
    expect(browser).toMatch(/npm install -g "playwright@\$\{PLAYWRIGHT_VERSION\}"/);
    expect(browser).toMatch(/playwright install --with-deps --only-shell chromium/);
    expect(browser).toMatch(/^LABEL factory\.browser="playwright-\$\{PLAYWRIGHT_VERSION\}"$/m);
    // Out of the run's HOME, as the shooter finds it.
    expect(browser).toMatch(/^ENV PLAYWRIGHT_BROWSERS_PATH=\/opt\//m);
    expect(browser).not.toMatch(/^\s*(ARG|ENV)\s+\S*(TOKEN|SECRET|PASSWORD|API_KEY)/im);
  });

  it('builds and checks the capture image in the isolation job, on the runner image it built (ORC-404)', () => {
    const job = (parse(read('.github/workflows/ci.yml')) as { jobs: Record<string, { steps: { name?: string; run?: string; env?: Record<string, string> }[] }> }).jobs['isolation']!;
    const step = job.steps.find((x) => x.name === 'Check the capture image')!;
    expect(step.run).toMatch(/podman build -f docker\/browser\.Dockerfile --build-arg RUNNER_IMAGE=localhost\/factory-runner:ci -t localhost\/factory-browser:ci docker/);
    expect(step.run).toContain('test/isolation/visual-proof.test.ts');
    expect(step.env).toMatchObject({ FACTORY_BROWSER_IMAGE: 'localhost/factory-browser:ci' });
    expect(job.steps.indexOf(step)).toBeGreaterThan(job.steps.findIndex((x) => x.name === 'Check the runner image'));
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

/** ORC-377: with no timeout-minutes, a wedged engine or a hung test holds the runner for GitHub's 6 h. */
describe('the time limits of the CI jobs (ORC-377)', () => {
  type Step = { if?: string; run?: string };
  type Jobs = Record<string, { 'timeout-minutes'?: number; steps: Step[] }>;
  const jobs = (parse(read('.github/workflows/ci.yml')) as { jobs: Jobs }).jobs;

  it("bounds every job, well below GitHub's default of 360 min", () => {
    const secretJobs = (parse(read('.github/workflows/main-secrets.yml')) as { jobs: Jobs }).jobs;
    for (const [name, job] of [...Object.entries(jobs), ...Object.entries(secretJobs)]) {
      expect(job['timeout-minutes'], name).toBeGreaterThan(0);
      expect(job['timeout-minutes'], name).toBeLessThanOrEqual(60);
    }
  });

  it("stops chaos after its test's own timeout, which names the seed that replays it", () => {
    const testMinutes = Number(/\{ timeout: (\d+) \* 60_000 \}/.exec(read('test/chaos/chaos.test.ts'))?.[1]);
    expect(jobs['chaos']!['timeout-minutes']).toBeGreaterThan(testMinutes);
  });

  it("prints the engine's state, each command bounded, when the isolation job fails or is cancelled", () => {
    const steps = jobs['isolation']!.steps;
    const state = steps.findIndex((s) => s.if === 'failure() || cancelled()');
    expect(state).toBeGreaterThan(steps.findIndex((s) => s.run === 'npm run test:isolation'));
    expect(steps[state]!.run).toMatch(/^timeout -k \d+ \d+ podman ps -a /m);
    expect(steps[state]!.run).toMatch(/^timeout -k \d+ \d+ podman info /m);
  });
});

/**
 * ORC-475: this repository is the first run's pilot, so its own CI must pass `factory doctor`. What reads a secret runs
 * in `main-secrets.yml`, on main alone; `ci.yml`, which every PR runs, reads none and has a read-only token.
 */
describe('the workflows doctor reads on the pilot repository (ORC-475)', () => {
  type Step = { name?: string; run?: string; if?: string; env?: Record<string, string> };
  interface Job {
    name?: string;
    if?: string;
    environment?: string;
    permissions?: unknown;
    env?: Record<string, string>;
    steps: Step[];
  }
  type Workflow = { on: Record<string, unknown>; permissions?: unknown; jobs: Record<string, Job> };
  const ciText = read('.github/workflows/ci.yml');
  const secretsText = read('.github/workflows/main-secrets.yml');
  const ci = parse(ciText) as Workflow;
  const secrets = parse(secretsText) as Workflow;

  it("produces the 4 checks the ruleset main requires on every pull request, under their names (gh api …/rulesets)", () => {
    expect(Object.keys(ci.on)).toContain('pull_request');
    for (const check of ['test', 'properties', 'integration', 'chaos']) {
      const job = ci.jobs[check];
      expect(job, check).toBeDefined();
      // A check is named after its job's `name`, else its id.
      expect(job!.name, check).toBeUndefined();
      expect([undefined, "github.event_name != 'schedule'"], check).toContain(job!.if);
    }
  });

  it('reads no secret in ci.yml, whose GITHUB_TOKEN can only read, and runs the isolation suite on PRs without one', () => {
    expect(ci.permissions).toEqual({ contents: 'read' });
    for (const [name, job] of Object.entries(ci.jobs)) {
      expect(job.permissions, name).toBeUndefined();
      expect(job.environment, name).toBeUndefined();
    }
    expect(ci.jobs['isolation']!.if).toBeUndefined();
    expect(ci.jobs['isolation']!.steps.map((s) => s.run)).toContain('npm run test:isolation');
  });

  it('runs main-secrets.yml on main alone, never on a pull request, with a read-only GITHUB_TOKEN', () => {
    expect(secrets.on).toEqual({ push: { branches: ['main'] }, schedule: [{ cron: expect.any(String) }], workflow_dispatch: null });
    expect(secrets.permissions).toEqual({ contents: 'read' });
    // A manual run can name any branch: its code never gets a secret.
    for (const [name, job] of Object.entries(secrets.jobs)) {
      expect(job.if, name).toMatch(/^github\.ref == 'refs\/heads\/main'( &&|$)/);
      expect(job.permissions, name).toBeUndefined();
    }
  });

  it('still runs isolation n° 11 with the Claude login, the token given to its step alone, on every push to main', () => {
    const job = secrets.jobs['isolation-claude']!;
    const test = job.steps.find((s) => s.run === 'npx vitest run --project isolation test/isolation/claude-settings.test.ts')!;
    expect(test).toBeDefined();
    expect(test.env).toMatchObject({ FACTORY_ISOLATION: '1', CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}' });
    expect(job.steps.filter((s) => JSON.stringify(s.env ?? {}).includes('secrets.'))).toEqual([test]);
    // The claude ci.yml installed before ORC-475, pinned as docker/runner.Dockerfile pins it.
    const install = job.steps.find((s) => s.run?.includes('npm install -g @anthropic-ai/claude-code@'))!;
    expect(install.run).toContain(`npm install -g @anthropic-ai/claude-code@${/claude-code@(\d+\.\d+\.\d+)/.exec(runner)?.[1]}\n`);
    expect(job.steps.indexOf(install)).toBeLessThan(job.steps.indexOf(test));
  });

  it('still runs isolation n° 12 and 13 on the real GitHub, under the environment limited to main', () => {
    const job = secrets.jobs['isolation-github']!;
    expect(job.environment).toBe('isolation-github');
    expect(job.if).toContain("vars.FACTORY_ISO_GH_APP_ID != ''");
    const test = job.steps.find((s) => s.run?.includes('isolation-12-ci-secrets.test.ts'))!;
    expect(test.run).toContain('test/isolation/isolation-13-run-token.test.ts');
    expect(test.env).toMatchObject({ FACTORY_ISO_GH_APP_KEY: '${{ secrets.FACTORY_ISO_GH_APP_KEY }}' });
    expect(ci.jobs['isolation-github']).toBeUndefined();
  });

  it('is accepted by doctor, every workflow of the repository, with no environment, as online (gh api …/environments)', async () => {
    const lines: string[] = [];
    const code = await runDoctor({
      checkout: root,
      github: 'acme/app',
      api: {
        // Every file, as GitHub lists them: a third workflow is judged too.
        listWorkflows: async () =>
          readdirSync(join(root, '.github/workflows'))
            .sort()
            .map((f) => ({ path: `.github/workflows/${f}`, content: read(`.github/workflows/${f}`) })),
        listEnvironments: async () => [],
        branchProtection: async () => ({ branch: 'main', classic: false, rules: ['pull_request', 'required_status_checks'], pullRequestRulesets: [{ id: 1, bypass: 'never' }] }),
        installation: async () => ({ id: 42, permissions: GITHUB_APP_PERMISSIONS }),
      },
      host: { verdict: 'accepted', reasons: [] },
      json: true,
      out: (line) => lines.push(line),
    });
    const report = JSON.parse(lines.join('\n')) as { accepted: boolean; workflows: WorkflowReport[] };
    // ci.yml reaches the factory's branches (pull_request) with no environment: accepted, it reads no secret and its token cannot write.
    expect(report.workflows.map(({ path, verdict, factoryBranches }) => ({ path, verdict, factoryBranches }))).toEqual([
      { path: '.github/workflows/ci.yml', verdict: 'accepted', factoryBranches: true },
      { path: '.github/workflows/main-secrets.yml', verdict: 'accepted', factoryBranches: false },
    ]);
    expect({ code, accepted: report.accepted }).toEqual({ code: 0, accepted: true });
  });
});
