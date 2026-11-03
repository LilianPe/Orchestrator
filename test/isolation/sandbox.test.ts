import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeSandboxContract } from '../contracts/sandbox.contract.js';
import { cli, enabled, podman, useSandboxes } from './helpers.js';

describe.skipIf(!enabled)(`container sandbox (${cli})`, () => {
  const { provider, request, create, workspace } = useSandboxes('contract');

  /** Interfaces the container sees, from /proc/net/dev (two header lines, then `name: counters`). */
  const interfaces = async (id: string): Promise<string[]> => {
    const r = await provider.exec(id, ['cat', '/proc/net/dev']);
    return r.stdout.split('\n').slice(2).map((l) => l.split(':')[0]!.trim()).filter(Boolean);
  };

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
    const sbx = await create();
    expect(await interfaces(sbx.id)).toEqual(['lo']);
  });

  it('applies --network none at the other levels too: only the egress proxy lets anything out (ORC-213)', async () => {
    const sbx = await create({ network: 'limited' });
    expect(await interfaces(sbx.id)).toEqual(['lo']);
  });

  it('shows no engine socket', async () => {
    const sbx = await create();
    for (const sock of ['/var/run/docker.sock', '/run/docker.sock', '/run/podman/podman.sock']) {
      expect((await provider.exec(sbx.id, ['test', '-e', sock])).code).toBe(1);
    }
  });

  it('mounts the workspace writable, as the daemon uid', async () => {
    const ws = workspace();
    const sbx = await create({ workspacePath: ws });
    const r = await provider.exec(sbx.id, ['touch', 'made-inside']);
    expect(r).toMatchObject({ code: 0 });
    const file = join(ws, 'made-inside');
    expect(existsSync(file)).toBe(true);
    // Docker Desktop on Windows has no uid to compare.
    if (process.getuid) expect(statSync(file).uid).toBe(process.getuid());
  });

  it('leaves no container after destroy', async () => {
    const req = request();
    const sbx = await provider.create(req);
    await provider.destroy(sbx.id);
    expect(await provider.findByAttempt(req.runId)).toBeUndefined();
    await expect(provider.exec(sbx.id, ['true'])).rejects.toThrow();
  });

  it.skipIf(!podman)('runs rootless', () => {
    expect(execFileSync(cli, ['info', '--format', '{{.Host.Security.Rootless}}'], { encoding: 'utf8' }).trim()).toBe('true');
  });
});
