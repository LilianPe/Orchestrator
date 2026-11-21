import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DryRun, DryRunRequest } from '../../src/core/dry-run.js';
import { parseRepoConfig } from '../../src/config/repo-config.js';
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
    await vi.waitFor(() => expect(ends).toHaveLength(1));
    ends[0]!();
    expect(await joined).toEqual(await first);
    await vi.waitFor(() => expect(ends).toHaveLength(2));
    ends[1]!();
    expect((await fresh).id).not.toBe((await first).id);
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
});
