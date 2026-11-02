import { expect } from 'vitest';
import type { ExecResult } from '../../src/adapters/exec.js';
import type { SandboxProvider, SandboxRequest, SandboxRequirements } from '../../src/adapters/sandbox/types.js';
import { describeContract, resolved, subjectWith, type ContractOptions } from './cases.js';

/** What the exec case runs, and what a real sandbox answers: a fake scripts its `exec` to match. */
export const EXEC_PROBE: { argv: readonly string[]; result: ExecResult } = {
  argv: ['sh', '-c', 'printf out; printf err >&2; exit 3'],
  result: { stdout: 'out', stderr: 'err', code: 3 },
};

/** What the implementation under test arranged for the suite. Docs: docs/ports/sandbox-provider.md. */
export interface SandboxSubject {
  provider: SandboxProvider;
  /** A request for a run that has no sandbox yet; the cases vary its runId and network. */
  request: SandboxRequest;
  /** The ids of the sandboxes alive right now. */
  active: () => Promise<string[]>;
  /** Requirements the provider cannot meet, and a pattern of the refusal naming them; without it, the refusal case is skipped. */
  unsatisfiable?: { requirements: SandboxRequirements; unmet: RegExp };
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
      const replay = await resolved(s.provider.create(s.request));
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

    it('exec returns the exit code and the output, a non-zero exit included', async () => {
      const s = await make();
      const sbx = await s.provider.create(s.request);
      expect(await resolved(s.provider.exec(sbx.id, EXEC_PROBE.argv))).toEqual(EXEC_PROBE.result);
    });

    it('exec rejects on an unknown or destroyed sandbox', async () => {
      const s = await make();
      await expect(s.provider.exec('contract-no-such-sandbox', ['true'])).rejects.toThrow();
      const sbx = await s.provider.create(s.request);
      await s.provider.destroy(sbx.id);
      await expect(s.provider.exec(sbx.id, ['true'])).rejects.toThrow();
    });

    it('spawnCommand throws on an unknown sandbox', async () => {
      const s = await make();
      expect(() => s.provider.spawnCommand('contract-no-such-sandbox', ['true'])).toThrow();
    });

    it('findByAttempt finds the live sandbox of a run, and nothing once it is destroyed', async () => {
      const s = await make();
      expect(await resolved(s.provider.findByAttempt(s.request.runId))).toBeUndefined();
      const sbx = await s.provider.create(s.request);
      expect(await resolved(s.provider.findByAttempt(s.request.runId))).toEqual(sbx);
      await s.provider.destroy(sbx.id);
      expect(await resolved(s.provider.findByAttempt(s.request.runId))).toBeUndefined();
    });

    it('list holds each live sandbox with its run, and no destroyed one', async () => {
      const s = await make();
      const a = await s.provider.create(s.request);
      const other = `${s.request.runId}-other`;
      const b = await s.provider.create({ ...s.request, runId: other });
      await s.provider.destroy(a.id);
      const listed = await resolved(s.provider.list());
      expect(listed).toContainEqual({ runId: other, sandbox: b });
      expect(listed.map((l) => l.sandbox.id)).not.toContain(a.id);
    });

    it('create rejects requirements nothing satisfies, naming the unmet one, and makes no sandbox', async (ctx) => {
      const s = await subjectWith(make, () => ctx.skip(), 'unsatisfiable');
      await expect(s.provider.create({ ...s.request, requirements: s.unsatisfiable.requirements })).rejects.toThrow(s.unsatisfiable.unmet);
      expect(await s.active()).toEqual([]);
    });
  });
}
