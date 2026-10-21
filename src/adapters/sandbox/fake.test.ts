import { describe, expect, it } from 'vitest';
import { FakeSandboxProvider } from './fake.js';

describe('FakeSandboxProvider', () => {
  it('creates sandboxes with the requested network level and tracks the active ones', async () => {
    const p = new FakeSandboxProvider();
    const a = await p.create({ runId: 'r1', ticketId: 'REL-1', workspacePath: '/w', network: 'none' });
    const b = await p.create({ runId: 'r2', ticketId: 'REL-1', workspacePath: '/w', network: 'limited' });
    expect(a).toEqual({ id: 'sbx-1', network: 'none' });
    expect(b.id).toBe('sbx-2');
    expect(p.created.map((r) => r.runId)).toEqual(['r1', 'r2']);
    expect(p.active()).toEqual([a, b]);
    await p.destroy(a.id);
    expect(p.active()).toEqual([b]);
    expect(p.destroyed).toEqual(['sbx-1']);
  });

  it('destroying an unknown or already destroyed sandbox is a no-op', async () => {
    const p = new FakeSandboxProvider();
    const a = await p.create({ runId: 'r1', ticketId: 'REL-1', workspacePath: '/w', network: 'full' });
    await p.destroy(a.id);
    await p.destroy(a.id);
    await p.destroy('nope');
    expect(p.destroyed).toEqual(['sbx-1']);
  });
});
