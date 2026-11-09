import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SandboxRequest } from '../../src/adapters/sandbox/types.js';
import { TAKEN_OVER } from '../../src/core/block-cause.js';
import { TRUSTED } from '../../src/core/types.js';
import { createApp } from '../../src/server/app.js';
import { createHarness } from '../helpers/harness.js';
import { sha } from '../helpers/github-webhook.js';

/**
 * ORC-234: a human takes over a run from its inspection, only in a container of its own or by a bundle the factory checks
 * before any push, never on the server. The run is stopped first, the take-over is journaled with its operator, and a
 * bundle that passes the diff check is the human's push (ORC-159): verify checks it before the agent resumes on top of it.
 */
type Harness = ReturnType<typeof createHarness>;
const WORKTREE = '/tmp/factory-fake/p/REL-1';
const TAKE_OVER = 'take-over-p-REL-1';

function dashboard(h: Harness) {
  const takeOver = h.orch.takeOverDesk();
  return createApp({
    store: h.store, bus: h.bus, clock: h.clock, isPaused: () => false,
    submit: async (e) => {
      await h.orch.accept(e);
      await h.orch.drained();
    },
    linearWebhook: () => ({ status: 200 }), githubWebhook: async () => ({ status: 200 }), linearConnected: () => true, tracker: h.tracker,
    capacity: () => ({ dev: { used: 0, total: 1 }, questions: { used: 0, total: 1 } }), transcriptsDir: '.',
    ...(takeOver ? { takeOver } : {}),
  });
}

/** A ticket whose agent is at work, in its sandbox; what the take-over's sandbox saw alive when it was opened. */
async function atWork(opts: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness({ sandboxed: true, ...opts });
  const aliveAtOpening: string[][] = [];
  const create = h.sandboxes.create.bind(h.sandboxes);
  h.sandboxes.create = async (req: SandboxRequest) => {
    if (req.runId === TAKE_OVER) aliveAtOpening.push(h.sandboxes.active().map((s) => s.id));
    return create(req);
  };
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.workspaces.heads.set(WORKTREE, sha('a'));
  h.runner.enqueue({ hold: true });
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
  const runId = (await h.ticket()).activeRunId!;
  expect(runId).toBeDefined();
  return { h, runId, aliveAtOpening, app: dashboard(h) };
}

async function takeOver(h: Harness, app: ReturnType<typeof dashboard>, runId: string): Promise<void> {
  expect((await app.request(`/api/runs/${runId}/take-over`, { method: 'POST' })).status).toBe(200);
  await h.advance(0);
}

const takeOverRequest = (h: Harness) => h.sandboxes.created.find((r) => r.runId === TAKE_OVER);
const takeOverOpen = (h: Harness) => h.sandboxes.list().then((l) => l.some((s) => s.runId === TAKE_OVER));
const handBack = (app: ReturnType<typeof dashboard>) => app.request('/api/tickets/p/REL-1/take-over/bundle', { method: 'POST', body: new TextEncoder().encode('# v2 git bundle\n') });

describe('a human takes over a run (ORC-234)', () => {
  it('criterion 1: the run is stopped first, then a container of its own opens on the worktree, without network nor secret, journaled with its operator', async () => {
    const { h, runId, aliveAtOpening, app } = await atWork();
    const agentBox = h.sandboxes.created.find((r) => r.runId === runId);
    expect(agentBox).toBeDefined();
    await takeOver(h, app, runId);

    expect(await h.store.getRun(runId)).toMatchObject({ status: 'stopped' });
    expect(await h.ticket()).toMatchObject({ blocked: true, blockKind: 'taken_over', blockReason: TAKEN_OVER });
    // Its own container, on the ticket's worktree: no network, nothing mounted but the worktree (no session, no pack, no secret).
    expect(takeOverRequest(h)).toEqual({ runId: TAKE_OVER, ticketId: 'REL-1', workspacePath: WORKTREE, network: 'none', requirements: { minLevel: 'L3', browser: false, services: [] }, mounts: [] });
    // Opened once the agent's was gone: the human never shares the worktree with the agent.
    expect(aliveAtOpening).toEqual([[]]);
    const journal = (await h.store.ticketJournal('p', 'REL-1')).map((e) => e.event);
    expect(journal.find((e) => e.type === 'control.stop')).toMatchObject({ actor: 'dashboard:local', roles: ['operator'], payload: { runId, takeOver: true } });

    // How to reach it: a shell in that container, never on the server.
    const res = await app.request('/api/tickets/p/REL-1/take-over');
    expect(res.status).toBe(200);
    expect((await res.json()).command).toEqual(['sh', '-i']);
  });

  it('criterion 1: without sandboxes, no take-over at all: refused by the dashboard, and opened on the host by nothing', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const runId = (await h.ticket()).activeRunId!;
    expect(h.orch.takeOverDesk()).toBeUndefined();
    expect((await dashboard(h).request(`/api/runs/${runId}/take-over`, { method: 'POST' })).status).toBe(409);
    // A take-over journaled all the same (an older instance, a replay): the run stops, and nothing opens.
    await h.orch.accept({ ...TRUSTED, id: 'ui:take-over', type: 'control.stop', at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', actor: 'dashboard:local', roles: ['operator'], payload: { runId, takeOver: true } });
    await h.advance(0);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockKind: 'taken_over' });
    expect(h.sandboxes.created).toEqual([]);
    expect(h.logs.some((l) => l.level === 'error' && /take-over of REL-1.*sandbox/.test(l.message))).toBe(true);
  });

  it("criterion 2: a bundle handed back is checked by the factory, then it is the human's push: verify checks it before anything resumes", async () => {
    const { h, runId, app } = await atWork();
    await takeOver(h, app, runId);
    h.publisher.bundleHead = sha('c');
    const read: string[] = [];
    const publishBundle = h.publisher.publishBundle.bind(h.publisher);
    h.publisher.publishBundle = async (req) => (read.push(readFileSync(req.bundle, 'utf8')), publishBundle(req));
    expect((await handBack(app)).status).toBe(200);
    await h.advance(0);

    // Kept where the factory reads it, and handed to the publisher, which verifies it in a fresh clone (extract.test.ts, publish.test.ts).
    expect(h.publisher.bundles).toHaveLength(1);
    const asked = h.publisher.bundles[0]!;
    expect(asked).toMatchObject({ projectId: 'p', ticketId: 'REL-1', runId: 'bundle-p-REL-1', branch: (await h.ticket()).branch });
    expect(read).toEqual(['# v2 git bundle\n']);
    // Read once: then removed.
    expect(existsSync(asked.bundle)).toBe(false);
    // The take-over ends with it: its container is closed.
    expect(await takeOverOpen(h)).toBe(false);
    const journal = (await h.store.ticketJournal('p', 'REL-1')).map((e) => e.event);
    expect(journal.find((e) => e.type === 'control.bundle')).toMatchObject({ actor: 'dashboard:local', roles: ['operator'] });
    expect(journal.find((e) => e.type === 'push.human')).toMatchObject({ taint: 'untrusted', payload: { sha: sha('c'), author: 'dashboard:local' } });
    expect(await h.ticket()).toMatchObject({ blocked: true, blockKind: 'human_push', verifiedSha: sha('c') });
    expect(h.runner.requests).toHaveLength(1);
  });

  it('criterion 3: a bundle the diff check refuses is pushed by nothing; the human is told, and the take-over stays open', async () => {
    const { h, runId, app } = await atWork();
    await takeOver(h, app, runId);
    h.publisher.refuseNextBundle('diff', 'factory/chemins-interdits: `.github/workflows/ci.yml`: forbidden path');
    expect((await handBack(app)).status).toBe(200);
    await h.advance(0);

    expect((await h.store.ticketJournal('p', 'REL-1')).map((e) => e.event.type)).not.toContain('push.human');
    expect(await h.ticket()).toMatchObject({ blocked: true, blockKind: 'taken_over' });
    expect(h.tracker.activities('ls-1').at(-1)).toMatchObject({ type: 'response', body: expect.stringMatching(/^The bundle handed back is refused, nothing was pushed: factory\/chemins-interdits/) });
    expect(await takeOverOpen(h)).toBe(true);
    expect(existsSync(h.publisher.bundles[0]!.bundle)).toBe(false);
  });

  it("a human's direct push to the branch ends the take-over: its container is closed while verify checks the push", async () => {
    const { h, runId, app } = await atWork();
    await takeOver(h, app, runId);
    await h.send('push.human', { branch: (await h.ticket()).branch!, sha: sha('d'), author: 'lilian' }, 'REL-1', { taint: 'untrusted' });
    expect(await h.ticket()).toMatchObject({ blocked: true, blockKind: 'human_push' });
    expect(await takeOverOpen(h)).toBe(false);
  });

  it("a reply relaunches the agent: the human's container is closed before the agent's opens", async () => {
    const { h, runId, app } = await atWork();
    await takeOver(h, app, runId);
    expect(await takeOverOpen(h)).toBe(true);
    h.runner.enqueue({ hold: true });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'reprends', author: 'Lilian', kind: 'instruction' });
    expect(h.runner.requests).toHaveLength(2);
    expect(await takeOverOpen(h)).toBe(false);
  });

  it('a restart keeps the take-over open: its container is no dead attempt', async () => {
    const { h, runId, app } = await atWork();
    await takeOver(h, app, runId);
    await h.restart();
    expect(await takeOverOpen(h)).toBe(true);
    // And the relaunch after it still closes it.
    h.runner.enqueue({ hold: true });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'reprends', author: 'Lilian', kind: 'instruction' });
    expect(await takeOverOpen(h)).toBe(false);
  });
});
