import { describe, expect, it } from 'vitest';
import { describeSandboxContract, EXEC_PROBE } from '../../../test/contracts/sandbox.contract.js';
import { FakeSandboxProvider } from './fake.js';
import { SandboxRouter, type SandboxBackend } from './router.js';
import { DEFAULT_REQUIREMENTS, type SandboxRequest } from './types.js';

const L3 = { level: 'L3', browser: false, services: [] } as const;
const request: SandboxRequest = { runId: 'r1', ticketId: 'REL-1', workspacePath: '/w', network: 'none', requirements: DEFAULT_REQUIREMENTS, mounts: [] };

function backend(name: string, capabilities: SandboxBackend['capabilities'] = L3): SandboxBackend & { provider: FakeSandboxProvider } {
  const provider = new FakeSandboxProvider();
  provider.execResult = () => EXEC_PROBE.result;
  return { name, provider, capabilities };
}

describeSandboxContract('SandboxRouter over a fake backend', () => {
  const only = backend('fake');
  return {
    provider: new SandboxRouter([only]),
    request,
    active: async () => only.provider.active().map((s) => s.id),
    unsatisfiable: { requirements: { minLevel: 'L5', browser: true, services: ['postgres'] }, unmet: /L5.*browser.*postgres/ },
  };
});

describe('SandboxRouter', () => {
  it('creates on the first backend that satisfies every requirement', async () => {
    const weak = backend('weak');
    const strong = backend('strong', { level: 'L4', browser: true, services: ['postgres', 'redis'] });
    const router = new SandboxRouter([weak, strong]);
    await router.create({ ...request, requirements: { minLevel: 'L3', browser: true, services: ['postgres'] } });
    expect(weak.provider.created).toEqual([]);
    expect(strong.provider.created).toHaveLength(1);
    await router.create({ ...request, runId: 'r2' });
    expect(weak.provider.created).toHaveLength(1);
  });

  it("sends exec and destroy of a sandbox's services to the backend that made them (ORC-309)", async () => {
    const other = backend('other');
    const pg = backend('pg', { level: 'L3', browser: false, services: ['postgres'] });
    const router = new SandboxRouter([other, pg]);
    const box = await router.create({ ...request, requirements: { ...DEFAULT_REQUIREMENTS, services: ['postgres'] } });
    expect(box.services).toBe('svc-1');
    expect(await router.exec('svc-1', ['pg_dumpall'])).toEqual(EXEC_PROBE.result);
    await router.destroy('svc-1');
    expect(pg.provider.activeServices()).toEqual([]);
  });

  it("a replayed create gives the sandbox's services back, as its backend has them (ORC-309)", async () => {
    const pg = backend('pg', { level: 'L3', browser: false, services: ['postgres'] });
    const req = { ...request, runId: 'r1-setup', servicesOf: 'r1', requirements: { ...DEFAULT_REQUIREMENTS, services: ['postgres'] } };
    await pg.provider.create(req);
    const router = new SandboxRouter([pg]);
    expect((await router.create(req)).services).toBe('svc-1');
    expect(await router.exec('svc-1', ['pg_dumpall'])).toEqual(EXEC_PROBE.result);
  });

  it('provides the services of its backends, each once (ORC-282)', () => {
    const router = new SandboxRouter([backend('weak'), backend('pg', { ...L3, services: ['postgres'] }), backend('both', { ...L3, services: ['redis', 'postgres'] })]);
    expect(router.services).toEqual(['postgres', 'redis']);
  });

  it('refuses instead of falling back to a weaker backend, naming what is missing', async () => {
    const weak = backend('weak');
    const router = new SandboxRouter([weak]);
    await expect(router.create({ ...request, requirements: { ...DEFAULT_REQUIREMENTS, minLevel: 'L4' } })).rejects.toThrow(/weak lacks level >= L4/);
    await expect(router.create({ ...request, requirements: { ...DEFAULT_REQUIREMENTS, services: ['redis'] } })).rejects.toThrow(/service redis/);
    expect(weak.provider.created).toEqual([]);
  });

  it('a replayed create returns the sandbox of the run from whichever backend holds it', async () => {
    const first = backend('first');
    const second = backend('second');
    const held = await second.provider.create(request);
    const router = new SandboxRouter([first, second]);
    expect(await router.create(request)).toEqual(held);
    expect(first.provider.created).toEqual([]);
    expect(await router.exec(held.id, ['true'])).toEqual(EXEC_PROBE.result);
  });

  it('a replayed create refuses the sandbox of the run at another network, or on a backend short of the requirements', async () => {
    const weak = backend('weak');
    const strong = backend('strong', { level: 'L4', browser: true, services: [] });
    await weak.provider.create(request);
    const router = new SandboxRouter([weak, strong]);
    await expect(router.create({ ...request, network: 'full' })).rejects.toThrow(/r1 has network none, asked full/);
    await expect(router.create({ ...request, requirements: { ...DEFAULT_REQUIREMENTS, minLevel: 'L4' } })).rejects.toThrow(/r1 .*weak lacks level >= L4/);
    await expect(router.create({ ...request, requirements: { ...DEFAULT_REQUIREMENTS, browser: true } })).rejects.toThrow(/r1 .*weak lacks browser/);
    expect(strong.provider.created).toEqual([]);
  });

  it('dispatches exec, spawnCommand and destroy to the backend that made the sandbox', async () => {
    const a = backend('a');
    const b = backend('b', { level: 'L3', browser: true, services: [] });
    const router = new SandboxRouter([a, b]);
    const sbx = await router.create({ ...request, requirements: { ...DEFAULT_REQUIREMENTS, browser: true } });
    await router.exec(sbx.id, ['ls']);
    expect(router.spawnCommand(sbx.id, ['claude'])).toEqual({ command: ['claude'], env: {} });
    expect(b.provider.execs.map((e) => e.argv)).toEqual([['ls']]);
    expect(a.provider.execs).toEqual([]);
    await router.destroy(sbx.id);
    expect(b.provider.destroyed).toEqual([sbx.id]);
  });

  it('after a restart, list and findByAttempt find the owner of sandboxes made before', async () => {
    const a = backend('a');
    const b = backend('b');
    const before = await b.provider.create(request);
    const other = await b.provider.create({ ...request, runId: 'r2' });

    const listed = new SandboxRouter([a, b]);
    expect(await listed.list()).toEqual([
      { runId: 'r1', sandbox: before },
      { runId: 'r2', sandbox: other },
    ]);
    await listed.destroy(before.id);
    expect(b.provider.destroyed).toEqual([before.id]);

    const found = new SandboxRouter([a, b]);
    expect(await found.findByAttempt('r2')).toEqual(other);
    expect(found.spawnCommand(other.id, ['x'])).toEqual({ command: ['x'], env: {} });
  });

  it('knows no id it did not make, list or find: destroy ignores it, exec rejects, spawnCommand throws', async () => {
    const b = backend('b');
    const sbx = await b.provider.create(request);
    const router = new SandboxRouter([b]);
    await router.destroy(sbx.id);
    expect(b.provider.destroyed).toEqual([]);
    await expect(router.exec(sbx.id, ['true'])).rejects.toThrow(/unknown sandbox/);
    expect(() => router.spawnCommand(sbx.id, ['true'])).toThrow(/unknown sandbox/);
  });
});
