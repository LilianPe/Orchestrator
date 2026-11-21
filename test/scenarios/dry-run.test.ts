import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DryRun, DryRunRequest } from '../../src/core/dry-run.js';
import { parseRepoConfig } from '../../src/config/repo-config.js';
import { MAIN_UNCHECKED } from '../../src/core/maturity.js';
import { createHarness } from '../helpers/harness.js';

const FINGERPRINT = { setup: 'a'.repeat(64), image: 'factory/runner:test', lockfiles: {}, hash: 'b'.repeat(64) };

/** ORC-408: the engine's dry run of a project, recorded red or green. */
describe('the dry run of a project', () => {
  it('runs on the forge\'s default branch with the workflow\'s setup, the dev job\'s verify commands and the runner image, and records what it found', async () => {
    const asked: DryRunRequest[] = [];
    const dryRunner = async (req: DryRunRequest): Promise<DryRun> => {
      asked.push(req);
      expect(existsSync(req.workDir)).toBe(true);
      return { id: req.runId, projectId: req.projectId, sha: 'c'.repeat(40), target: 'main', ok: false, fingerprint: FINGERPRINT, breaks: [{ kind: 'dependency', step: 'setup', command: 'npm ci', detail: 'left-pad@9.9.9', output: '' }], commands: ['npm test'], startedAt: req.now(), endedAt: req.now() };
    };
    const h = createHarness({ sandboxed: true, dryRunner, workflow: { workspace: { setup: ['npm ci'] }, verify: ['npm test'] } });
    const run = await h.orch.dryRun('p');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ projectId: 'p', originUrl: '/origin', setup: ['npm ci'], commands: ['npm test'], image: 'factory/runner:test', sandboxes: expect.anything() });
    expect(asked[0]).not.toHaveProperty('sha');
    expect(await asked[0]!.env(parseRepoConfig(undefined))).toEqual({});
    // Its place is the dry run's, gone with it.
    expect(existsSync(dirname(asked[0]!.workDir))).toBe(false);
    expect(await h.store.lastDryRun('p')).toEqual(run);
  });

  it('on a commit given, it asks for that commit', async () => {
    const asked: DryRunRequest[] = [];
    const h = createHarness({
      sandboxed: true,
      dryRunner: async (req) => {
        asked.push(req);
        return { id: req.runId, projectId: req.projectId, sha: req.sha!, target: 'commit', ok: true, fingerprint: FINGERPRINT, breaks: [], commands: [], startedAt: 0, endedAt: 0 };
      },
    });
    await h.orch.dryRun('p', { sha: 'd'.repeat(40) });
    expect(asked[0]!.sha).toBe('d'.repeat(40));
    expect(await h.store.lastDryRun('p', 'd'.repeat(40))).toMatchObject({ ok: true, target: 'commit' });
    expect(await h.store.lastDryRun('p')).toBeUndefined();
  });

  it('on the default branch, one at a time: who asks meanwhile gets its result, or with `fresh` a new one once it ended (ORC-409)', async () => {
    const ends: (() => void)[] = [];
    let running = 0;
    const h = createHarness({
      sandboxed: true,
      dryRunner: (req) => {
        running++;
        expect(running).toBe(1);
        return new Promise((resolve) => ends.push(() => {
          running--;
          resolve({ id: req.runId, projectId: req.projectId, sha: 'c'.repeat(40), target: 'main', ok: true, fingerprint: FINGERPRINT, breaks: [], commands: [], startedAt: 0, endedAt: 0 });
        }));
      },
    });
    const first = h.orch.dryRun('p');
    const joined = h.orch.dryRun('p');
    const fresh = h.orch.dryRun('p', { fresh: true });
    // Asked before it starts: the same new one.
    const freshToo = h.orch.dryRun('p', { fresh: true });
    await vi.waitFor(() => expect(ends).toHaveLength(1));
    ends[0]!();
    expect(await joined).toEqual(await first);
    await vi.waitFor(() => expect(ends).toHaveLength(2));
    ends[1]!();
    expect((await fresh).id).not.toBe((await first).id);
    expect(await freshToo).toEqual(await fresh);
  });

  it('without sandboxes, it refuses and records nothing', async () => {
    const h = createHarness({ dryRunner: async () => expect.unreachable() });
    await expect(h.orch.dryRun('p')).rejects.toThrow('FACTORY_CONTAINER_CLI');
    expect(await h.store.lastDryRun('p')).toBeUndefined();
  });

  it('a dry run that cannot run records nothing', async () => {
    const h = createHarness({ sandboxed: true, dryRunner: async () => Promise.reject(new Error('engine down')) });
    await expect(h.orch.dryRun('p')).rejects.toThrow('engine down');
    expect(await h.store.lastDryRun('p')).toBeUndefined();
  });

  it("on the default branch, it sets the project's main card green or red, its approval dropped on a new value; on a commit, it leaves it (ORC-437)", async () => {
    let ok = true;
    const h = createHarness({
      sandboxed: true,
      dryRunner: async (req) => ({
        id: req.runId, projectId: req.projectId, sha: req.sha ?? 'c'.repeat(40), target: req.sha ? 'commit' : 'main', ok,
        fingerprint: FINGERPRINT, breaks: ok ? [] : [{ kind: 'failure', step: 'command', command: 'npm test', detail: '1 failed', output: '' }], commands: ['npm test'], startedAt: Date.UTC(2026, 10, 21, 9), endedAt: Date.UTC(2026, 10, 21, 9),
      }),
    });
    const main = async () => (await h.store.maturityCards('p')).find((c) => c.key === 'main');
    // No card yet (init never ran): none is made.
    await h.orch.dryRun('p');
    expect(await h.store.maturityCards('p')).toEqual([]);
    await h.store.putMaturityCards('p', [{ key: 'stack', title: 'Stack', value: 'Node (npm)' }, { key: 'main', title: 'main green or red', value: MAIN_UNCHECKED }], 1);
    await h.orch.dryRun('p');
    expect((await main())?.value).toBe('green: the dry run of cccccccccccc on 2026-11-21 09:00 UTC (npm test)');
    await h.store.approveMaturityCard('p', 'main', (await main())!.value, 'armand', 2);
    ok = false;
    await h.orch.dryRun('p', { sha: 'd'.repeat(40) });
    expect((await main())?.approvedBy).toBe('armand');
    await h.orch.dryRun('p');
    expect(await main()).toMatchObject({ value: 'red: the dry run of cccccccccccc on 2026-11-21 09:00 UTC: failure in `npm test`\nfix it on main, then factory dry-run p' });
    expect((await main())?.approvedBy).toBeUndefined();
    expect((await h.store.maturityCards('p'))[0]!.detectedAt).toBe(1);
  });
});
