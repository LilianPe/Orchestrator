import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sandbox } from '../../src/adapters/sandbox/types.js';
import { EgressProxy, type EgressEntry } from '../../src/network/proxy.js';
import { cli, enabled, useSandboxes } from './helpers.js';

/**
 * ORC-447: a Yarn 4 repository, `packageManager: yarn@4.x`, installs its dependencies in the sandbox through the egress
 * proxy, Yarn fetched by Corepack with its own HTTP client. The Yarn 4 test of network.test.ts installs Yarn with npm, so it
 * stays green whether Corepack trusts the factory authority or not.
 *
 * The real `EgressProxy` in this process at `limited`, the real registries upstream: Corepack must trust the authority the
 * proxy decrypts with (`NODE_EXTRA_CA_CERTS`) and fetch Yarn from the npm registry (`COREPACK_NPM_REGISTRY`, ORC-219), its
 * default `repo.yarnpkg.com` being on no list. Linux only, as useEgress: a host socket does not cross into a VM's engine.
 */
describe.skipIf(!enabled || process.platform !== 'linux')(`Corepack fetches Yarn 4 through the egress proxy (${cli})`, () => {
  let dir = '';
  let proxy: EgressProxy;
  const { create, request, sh } = useSandboxes('corepack', {
    egress: {
      open: (runId, policy) => proxy.open(runId, policy),
      close: (runId) => proxy.close(runId),
      isOpen: (runId) => proxy.isOpen(runId),
      get caCertPath() {
        return proxy.caCertPath;
      },
    },
  });
  const { runId } = request();
  let sbx: Sandbox;

  const run = async (script: string) => {
    const r = await sh(sbx.id, script);
    return { code: r.code, out: `${r.stdout}${r.stderr}`.trim() };
  };
  const journal = (): EgressEntry[] => {
    const path = proxy.journalPath(runId);
    const text = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
    return text ? text.split('\n').map((l) => JSON.parse(l) as EgressEntry) : [];
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'factory-corepack-'));
    proxy = new EgressProxy({ dir: join(dir, 'network'), caDir: join(dir, 'ca') });
    sbx = await create({ runId, network: 'limited' });
    // The relay is the container's PID 1: up a moment after the container.
    const probe = `node -e "require('net').connect(3128,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"`;
    expect((await run(`for i in $(seq 50); do ${probe} && exit 0; sleep 0.1; done; exit 1`)).code).toBe(0);
  }, 300_000);

  afterAll(async () => {
    await proxy?.closeAll();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it('limited: `corepack yarn install` fetches Yarn 4.5.0 and the dependencies through the proxy, nothing else getting out', async () => {
    // The public image's Node 24 bundles Corepack: its absence is a failure here, not a skip.
    expect((await run('command -v corepack')).code).toBe(0);
    // Fresh HOME and COREPACK_HOME: no Yarn and no package in a cache, both come through the proxy.
    const manifest = JSON.stringify({ name: 'p', version: '1.0.0', packageManager: 'yarn@4.5.0', dependencies: { 'is-number': '7.0.0' } });
    const env = 'HOME=$(mktemp -d) COREPACK_HOME=$(mktemp -d) COREPACK_ENABLE_DOWNLOAD_PROMPT=0';
    const r = await run(
      `cd $(mktemp -d) && echo '${manifest}' > package.json && touch yarn.lock && export ${env} && corepack yarn --version && corepack yarn install && node -r ./.pnp.cjs -p "'is-number@'+require('is-number/package.json').version"`,
    );
    expect(r).toMatchObject({ code: 0, out: expect.stringMatching(/^4\.5\.0$/m) as string });
    expect(r.out).toContain('is-number@7.0.0');

    const entries = journal();
    // Yarn itself, by Corepack, from the npm registry; the dependency's tarball, by Yarn, from its registry.
    expect(entries).toContainEqual(expect.objectContaining({ method: 'GET', host: 'registry.npmjs.org', path: '/@yarnpkg/cli-dist/-/cli-dist-4.5.0.tgz', ok: true }));
    expect(entries).toContainEqual(expect.objectContaining({ method: 'GET', host: 'registry.yarnpkg.com', path: '/is-number/-/is-number-7.0.0.tgz', ok: true }));
    // Corepack's default host was never needed: the list was not widened for it.
    expect(entries.filter((e) => e.host === 'repo.yarnpkg.com')).toEqual([]);
    // The proxy stays the only way out: no name resolves in the sandbox.
    expect((await run('getent hosts registry.npmjs.org')).code).not.toBe(0);
  });
});
