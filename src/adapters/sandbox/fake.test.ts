import { describe, expect, it } from 'vitest';
import { describeSandboxContract } from '../../../test/contracts/sandbox.contract.js';
import { FakeSandboxProvider } from './fake.js';
import { DEFAULT_REQUIREMENTS } from './types.js';

describeSandboxContract('FakeSandboxProvider', () => {
  const provider = new FakeSandboxProvider();
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

  it('destroying an unknown or already destroyed sandbox is a no-op', async () => {
    const p = new FakeSandboxProvider();
    const a = await p.create({ runId: 'r1', ticketId: 'REL-1', workspacePath: '/w', network: 'full', requirements: DEFAULT_REQUIREMENTS, mounts: [] });
    await p.destroy(a.id);
    await p.destroy(a.id);
    await p.destroy('nope');
    expect(p.destroyed).toEqual(['sbx-1']);
  });
});
