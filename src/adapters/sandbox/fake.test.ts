import { describe, expect, it } from 'vitest';
import { describeSandboxContract, EXEC_PROBE } from '../../../test/contracts/sandbox.contract.js';
import { FakeSandboxProvider } from './fake.js';
import { DEFAULT_REQUIREMENTS } from './types.js';

describeSandboxContract('FakeSandboxProvider', () => {
  const provider = new FakeSandboxProvider();
  // The fake runs nothing: it answers what a real sandbox does.
  provider.execResult = () => EXEC_PROBE.result;
  return {
    provider,
    request: { runId: 'r1', ticketId: 'REL-1', workspacePath: '/w', network: 'none', requirements: DEFAULT_REQUIREMENTS, mounts: [] },
    active: async () => provider.active().map((s) => s.id),
  };
});

describe('FakeSandboxProvider', () => {
  it('creates sandboxes with the requested network level and tracks the active ones', async () => {
    const p = new FakeSandboxProvider();
    const a = await p.create({ runId: 'r1', ticketId: 'REL-1', workspacePath: '/w', network: 'none', requirements: DEFAULT_REQUIREMENTS, mounts: [] });
    const b = await p.create({ runId: 'r2', ticketId: 'REL-1', workspacePath: '/w', network: 'limited', requirements: DEFAULT_REQUIREMENTS, mounts: [] });
    expect(a).toEqual({ id: 'sbx-1', network: 'none', level: 'L3' });
    expect(b.id).toBe('sbx-2');
    expect(p.created.map((r) => r.runId)).toEqual(['r1', 'r2']);
    expect(p.active()).toEqual([a, b]);
    await p.destroy(a.id);
    expect(p.active()).toEqual([b]);
    expect(p.destroyed).toEqual(['sbx-1']);
  });

  it("provides the container backend's services, as many as a test sets, and refuses another (ORC-282)", async () => {
    const p = new FakeSandboxProvider();
    expect(p.services).toEqual(['postgres']);
    const req = { runId: 'r1', ticketId: 'REL-1', workspacePath: '/w', network: 'none' as const, mounts: [] };
    await expect(p.create({ ...req, requirements: { ...DEFAULT_REQUIREMENTS, services: ['postgres', 'redis'] } })).rejects.toThrow('no services (redis)');
    p.services = [];
    await expect(p.create({ ...req, requirements: { ...DEFAULT_REQUIREMENTS, services: ['postgres'] } })).rejects.toThrow('no services (postgres)');
    expect(p.active()).toEqual([]);
  });

  it('destroying an unknown or already destroyed sandbox is a no-op', async () => {
    const p = new FakeSandboxProvider();
    const a = await p.create({ runId: 'r1', ticketId: 'REL-1', workspacePath: '/w', network: 'full', requirements: DEFAULT_REQUIREMENTS, mounts: [] });
    await p.destroy(a.id);
    await p.destroy(a.id);
    await p.destroy('nope');
    expect(p.destroyed).toEqual(['sbx-1']);
  });
});
