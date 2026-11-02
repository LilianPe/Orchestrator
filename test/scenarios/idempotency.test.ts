import { DEFAULT_REQUIREMENTS } from '../../src/adapters/sandbox/types.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeForge } from '../../src/adapters/forge/fake.js';
import { FakeSandboxProvider } from '../../src/adapters/sandbox/fake.js';
import type { EventPayloads } from '../../src/core/types.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import type { EffectOutcome } from '../../src/store/types.js';
import { CRASH_WORKFLOW } from '../helpers/crash-workflow.js';
import { createHarness } from '../helpers/harness.js';

/**
 * The idempotency table of docs/idempotence.md (ORC-162), one test per row: the effect executed
 * twice gives one visible effect. The rows the factory carries out today are replayed through the
 * outbox itself: the first execution acts, then loses its lease before it settles (`LosingStore`),
 * so the row is claimed and executed again once the lease expires, as after a stalled executor.
 */

const LEASE_MS = 50;

/** A store whose first settle of each row of `kind` finds its lease gone: the row runs again once it expires. */
class LosingStore extends SqliteStore {
  private lost = new Set<string>();

  constructor(private readonly kind: string) {
    super(':memory:');
  }

  override async completeEffect(id: string, lease?: string, at?: number, outcome?: EffectOutcome): Promise<boolean> {
    const row = (await this.listEffects('p', id.split(':')[0])).find((r) => r.id === id);
    if (row?.effect.kind === this.kind && !this.lost.has(id)) {
      this.lost.add(id);
      return false;
    }
    return super.completeEffect(id, lease, at, outcome);
  }
}

/** A harness whose rows of `kind` are each executed twice, the second time once the first lease expired. */
function replaying(kind: string, opts: { projectYaml?: string } = {}) {
  const store = new LosingStore(kind);
  const h = createHarness({ store, effectLeaseMs: LEASE_MS, ...opts });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
  /** Waits until the outbox and the inbox are empty, under the daemon's poll (the rows behind the lost lease wait for it). */
  const settled = async ({ stop = true } = {}) => {
    void h.orch.startWorker(LEASE_MS);
    const open = async () =>
      (await store.listEffects('p', 'REL-1')).some((r) => r.status !== 'done') || (await store.pendingInbox(1)).length > 0;
    for (let i = 0; i < 200 && (await open()); i++) {
      await new Promise((r) => setTimeout(r, 10));
      await h.orch.drained();
    }
    expect(await open()).toBe(false);
    if (stop) {
      h.orch.stopAll();
      await h.orch.drained();
    }
  };
  /** The result of the row of `kind`: the second execution says it found the effect already made. */
  const result = async () => {
    const row = (await store.listEffects('p', 'REL-1')).find((r) => r.effect.kind === kind)!;
    expect(row.attempts).toBe(2);
    const journaled = (await store.recentEvents(100, 'REL-1')).find((e) => e.id === `effect:${row.id}`)!;
    return journaled.payload as EventPayloads['effect.done'];
  };
  return { h, settled, result };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('idempotency table (ORC-162, docs/idempotence.md)', () => {
  it('Commentaire: a replayed comment finds its marker and writes no second comment', async () => {
    const { h, settled, result } = replaying('comment', { projectYaml: CRASH_WORKFLOW });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await settled();
    expect(h.tracker.comments('REL-1')).toEqual(['Pris en charge.']);
    expect(await result()).toMatchObject({ kind: 'comment', deduplicated: true, ref: 'comment-REL-1-1' });
    // The key is the effect id salted by the installation's id, drawn once and kept in the store.
    const [key] = h.tracker.calls.filter((c) => c.method === 'comment').map((c) => c.args[2] as string);
    expect(key).toBe(`REL-1:1:2@${await h.store.getMeta('instance-id')}`);
    expect(key).toMatch(/^REL-1:1:2@[0-9a-f]{12}$/);
  });

  it('Commentaire (activité de session): a replayed agent activity finds its id and is not posted twice', async () => {
    const { h, settled, result } = replaying('post_output');
    h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte, tests verts.' }] });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await settled();
    expect(h.tracker.activities('ls-1').filter((a) => a.type === 'response')).toEqual([{ type: 'response', body: 'PR ouverte, tests verts.' }]);
    expect(await result()).toMatchObject({ kind: 'post_output', deduplicated: true });
  });

  it('Labels: a replayed label change finds the final state already there and writes nothing', async () => {
    const { h, settled, result } = replaying('labels', { projectYaml: CRASH_WORKFLOW });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await settled();
    expect(h.tracker.calls.filter((c) => c.method === 'setLabels')).toHaveLength(1);
    expect((await h.tracker.getIssue('REL-1')).labels).toEqual(['agent:pris']);
    // Naturally idempotent: the second execution writes nothing, but has nothing to look up either.
    expect((await result()).deduplicated).toBeUndefined();
  });

  it('Labels: the final state of the group holds whatever the labels read when the effect is replayed', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', labels: ['agent:attente', 'bug'] });
    for (let i = 0; i < 2; i++) await h.tracker.setLabels('REL-1', ['agent:pris'], ['agent:attente', 'agent:stop']);
    expect((await h.tracker.getIssue('REL-1')).labels).toEqual(['bug', 'agent:pris']);
    expect(h.tracker.calls.filter((c) => c.method === 'setLabels')).toHaveLength(1);
  });

  it('Push (pending ORC-125): --force-with-lease on the expected sha is a no-op when replayed and refused once the branch moved', () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-push-'));
    const remote = join(root, 'remote.git');
    const work = join(root, 'work');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    const commit = (msg: string) => {
      git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', msg);
      return git(work, 'rev-parse', 'HEAD');
    };
    const a = commit('A');
    git(work, 'push', '-q', remote, 'HEAD:refs/heads/b');
    const b = commit('B');
    const push = (lease: string) => spawnSync('git', ['push', `--force-with-lease=b:${lease}`, remote, 'HEAD:refs/heads/b'], { cwd: work, encoding: 'utf8' });

    expect(push(a).status).toBe(0);
    // Replayed: the branch is already at the pushed sha, git answers before it checks the lease.
    expect(push(a).status).toBe(0);
    expect(git(remote, 'rev-parse', 'refs/heads/b')).toBe(b);
    // A replay of an older push after the branch moved on: refused, never written over.
    commit('C');
    const stale = push(a);
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain('stale info');
    expect(git(remote, 'rev-parse', 'refs/heads/b')).toBe(b);
  });

  it('PR: a replayed opening finds the open PR of the branch and opens no second one; a closed one is not reused', async () => {
    const forge = new FakeForge();
    const req = { branch: 'factory/rel-1', base: 'main', title: 'REL-1', body: '' };
    const first = await forge.ensurePr('/repo', req);
    const again = await forge.ensurePr('/repo', req);
    expect(again).toEqual({ ...first, deduplicated: true });
    expect(forge.opened).toHaveLength(1);
    expect(await forge.findPr('/repo', req.branch)).toMatchObject({ number: first.number, state: 'OPEN' });

    forge.setPr(req.branch, { number: first.number, url: first.url, state: 'CLOSED', checks: 'none', failedChecks: [] });
    const reopened = await forge.ensurePr('/repo', req);
    expect(reopened).toMatchObject({ deduplicated: false });
    expect(reopened.number).not.toBe(first.number);
  });

  it('Merge: a replayed merge finds the PR already merged on the reviewed head and merges nothing twice', async () => {
    const forge = new FakeForge();
    forge.setPr('factory/rel-1', { number: 3, url: 'u', state: 'OPEN', headSha: 'abc123', checks: 'pass', failedChecks: [] });
    expect(await forge.mergePr('/repo', 3, 'abc123')).toEqual({ merged: true, deduplicated: false });
    expect(await forge.mergePr('/repo', 3, 'abc123')).toEqual({ merged: true, deduplicated: true });
    expect(forge.merges).toHaveLength(1);
  });

  it('Check run: a replayed check run with the same external_id updates it instead of creating a second one', async () => {
    const forge = new FakeForge();
    const run = { sha: 'abc123', name: 'factory/verify', externalId: 'REL-1:4:1' };
    const created = await forge.upsertCheckRun('/repo', { ...run, status: 'in_progress' });
    const replayed = await forge.upsertCheckRun('/repo', { ...run, status: 'in_progress' });
    const completed = await forge.upsertCheckRun('/repo', { ...run, status: 'completed', conclusion: 'success' });
    expect(created).toEqual({ id: 1, deduplicated: false });
    expect(replayed).toEqual({ id: 1, deduplicated: true });
    expect(completed).toEqual({ id: 1, deduplicated: true });
    expect(forge.checkRuns).toEqual([{ ...run, id: 1, status: 'completed', conclusion: 'success' }]);
  });

  it('Conteneur (pending ORC-204): a replayed create for the same attempt finds its sandbox and makes no second one', async () => {
    const sandboxes = new FakeSandboxProvider();
    const req = { runId: 'run-1', ticketId: 'REL-1', workspacePath: '/w', network: 'none' as const, requirements: DEFAULT_REQUIREMENTS, mounts: [] };
    const first = await sandboxes.create(req);
    expect(await sandboxes.create(req)).toEqual(first);
    expect(sandboxes.active()).toEqual([first]);
  });

  it('Appel au modèle: a replayed start of an attempt still running calls the model once', async () => {
    const { h, settled, result } = replaying('start_run', { projectYaml: CRASH_WORKFLOW });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await settled({ stop: false });
    expect(h.runner.requests).toHaveLength(1);
    // Not set pending behind the attempt it started: nothing starts again once that one ends.
    expect((await h.ticket()).pendingJob).toBeUndefined();
    expect(await result()).toMatchObject({ kind: 'start_run', deduplicated: true });
    h.runner.release(h.runner.requests[0]!.runId);
    await settled();
    expect(h.runner.requests).toHaveLength(1);
  });
});
