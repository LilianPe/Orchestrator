import { expect } from 'vitest';
import type { SandboxProvider, SandboxRequest } from '../../src/adapters/sandbox/types.js';
import { describeContract, resolved, type ContractOptions } from './cases.js';

/** What the implementation under test arranged for the suite. Docs: docs/ports/sandbox-provider.md. */
export interface SandboxSubject {
  provider: SandboxProvider;
  /** A request for a run that has no sandbox yet; the cases vary its runId and network. */
  request: SandboxRequest;
  /** The ids of the sandboxes alive right now. */
  active: () => Promise<string[]>;
}

export function describeSandboxContract(name: string, make: () => SandboxSubject | Promise<SandboxSubject>, options?: ContractOptions): void {
  describeContract(`SandboxProvider contract: ${name}`, options, (it) => {
    it('create returns a live sandbox at the requested network level', async () => {
      const s = await make();
      for (const network of ['none', 'claude-api', 'limited', 'full'] as const) {
        const sbx = await s.provider.create({ ...s.request, runId: `${s.request.runId}-${network}`, network });
        expect(sbx.network).toBe(network);
        expect(sbx.id).not.toBe('');
        expect(await s.active()).toContain(sbx.id);
      }
    });

    it('create replayed for the same run returns its sandbox instead of a second one', async () => {
      const s = await make();
      const first = await s.provider.create(s.request);
      const replay = await s.provider.create(s.request);
      expect(replay).toEqual(first);
      expect(await s.active()).toEqual([first.id]);
    });

    it('each run gets its own sandbox', async () => {
      const s = await make();
      const a = await s.provider.create(s.request);
      const b = await s.provider.create({ ...s.request, runId: `${s.request.runId}-other` });
      expect(b.id).not.toBe(a.id);
      expect([...(await s.active())].sort()).toEqual([a.id, b.id].sort());
    });

    it('destroy is idempotent and ignores an unknown id', async () => {
      const s = await make();
      const sbx = await s.provider.create(s.request);
      await resolved(s.provider.destroy(sbx.id));
      await resolved(s.provider.destroy(sbx.id));
      await resolved(s.provider.destroy('contract-no-such-sandbox'));
      expect(await s.active()).toEqual([]);
    });

    it('after destroy, create for the same run gives a new sandbox', async () => {
      const s = await make();
      const first = await s.provider.create(s.request);
      await s.provider.destroy(first.id);
      const again = await s.provider.create(s.request);
      expect(again.id).not.toBe(first.id);
      expect(await s.active()).toEqual([again.id]);
    });
  });
}
