import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerSandboxProvider } from '../../src/adapters/sandbox/docker-rootless.js';
import { DEFAULT_REQUIREMENTS, type SandboxRequest } from '../../src/adapters/sandbox/types.js';
import { describeSandboxContract } from '../contracts/sandbox.contract.js';

const enabled = process.env['FACTORY_ISOLATION'] === '1';
const cli = process.env['FACTORY_CONTAINER_CLI'] ?? 'podman';
// A public image, so the CI need not build docker/runner.Dockerfile: the checks only need sh and coreutils.
const image = process.env['FACTORY_RUNNER_IMAGE'] ?? 'docker.io/library/node:24.22.1-bookworm-slim';
const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;

const provider = new ContainerSandboxProvider({ cli, image, uid, gid });
/** Every run of this file is under it, so afterAll removes what it made and nothing else. */
const prefix = `isolation-${Date.now()}`;
let made = 0;
let workspace = '';

const request = (over: Partial<SandboxRequest> = {}): SandboxRequest => ({
  runId: `${prefix}-${++made}`,
  ticketId: 'ISO-1',
  workspacePath: workspace,
  network: 'none',
  requirements: DEFAULT_REQUIREMENTS,
  mounts: [],
  ...over,
});

/** Interfaces the container sees, from /proc/net/dev (two header lines, then `name: counters`). */
async function interfaces(id: string): Promise<string[]> {
  const r = await provider.exec(id, ['cat', '/proc/net/dev']);
  return r.stdout.split('\n').slice(2).map((l) => l.split(':')[0]!.trim()).filter(Boolean);
}

describe.skipIf(!enabled)(`container sandbox (${cli})`, () => {
  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'factory-iso-'));
    execFileSync(cli, ['pull', '-q', image], { stdio: 'ignore', timeout: 300_000 });
  }, 300_000);

  afterAll(async () => {
    const ours = (await provider.list()).filter((x) => x.runId.startsWith(prefix));
    await Promise.all(ours.map((x) => provider.destroy(x.sandbox.id)));
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }, 120_000);

  describeSandboxContract(`ContainerSandboxProvider (${cli})`, () => {
    // Each case its own prefix: active() sees only the containers of that case.
    const base = request();
    return {
      provider,
      request: base,
      active: async () =>
        (await provider.list()).filter((x) => x.runId === base.runId || x.runId.startsWith(`${base.runId}-`)).map((x) => x.sandbox.id),
    };
  });

  it('applies --network none: loopback only', async () => {
    const sbx = await provider.create(request());
    expect(await interfaces(sbx.id)).toEqual(['lo']);
  });

  it('opens the bridge for the other levels (provisional until ORC-213)', async () => {
    const sbx = await provider.create(request({ network: 'claude-api' }));
    expect((await interfaces(sbx.id)).filter((i) => i !== 'lo')).not.toEqual([]);
  });

  it('shows no engine socket', async () => {
    const sbx = await provider.create(request());
    for (const sock of ['/var/run/docker.sock', '/run/docker.sock', '/run/podman/podman.sock']) {
      expect((await provider.exec(sbx.id, ['test', '-e', sock])).code).toBe(1);
    }
  });

  it('mounts the workspace writable, as the daemon uid', async () => {
    const sbx = await provider.create(request());
    const r = await provider.exec(sbx.id, ['touch', 'made-inside']);
    expect(r).toMatchObject({ code: 0 });
    const file = join(workspace, 'made-inside');
    expect(existsSync(file)).toBe(true);
    // Docker Desktop on Windows has no uid to compare.
    if (process.getuid) expect(statSync(file).uid).toBe(uid);
  });

  it('leaves no container after destroy', async () => {
    const req = request();
    const sbx = await provider.create(req);
    await provider.destroy(sbx.id);
    expect(await provider.findByAttempt(req.runId)).toBeUndefined();
    await expect(provider.exec(sbx.id, ['true'])).rejects.toThrow();
  });

  it.skipIf(!cli.includes('podman'))('runs rootless', () => {
    expect(execFileSync(cli, ['info', '--format', '{{.Host.Security.Rootless}}'], { encoding: 'utf8' }).trim()).toBe('true');
  });
});
