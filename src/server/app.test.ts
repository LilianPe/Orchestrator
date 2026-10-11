import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakeTracker } from '../adapters/tracker/fake.js';
import { EventBus } from '../core/bus.js';
import { FakeClock } from '../core/clock.js';
import { newTicketState, type RelaisEvent } from '../core/types.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { createApp } from './app.js';

function setup() {
  const store = new SqliteStore(':memory:');
  const bus = new EventBus();
  const tracker = new FakeTracker();
  tracker.addIssue({ identifier: 'REL-1', title: 'Export' });
  const submitted: RelaisEvent[] = [];
  const transcriptsDir = mkdtempSync(join(tmpdir(), 'relais-tr-'));
  const webDir = mkdtempSync(join(tmpdir(), 'relais-web-'));
  writeFileSync(join(webDir, 'index.html'), '<h1>Relais</h1>');
  const linearWebhook = vi.fn(() => ({ status: 200 }));
  const app = createApp({
    store, bus, clock: new FakeClock(10), submit: (e) => void submitted.push(e), isPaused: () => false, linearWebhook,
    linearConnected: () => true, tracker, capacity: () => ({ dev: { used: 1, total: 3 }, questions: { used: 0, total: 2 } }),
    transcriptsDir, webDir,
  });
  store.putTicket(newTicketState('p', 'REL-1', 'Export', 'dev', 1));
  store.putRun({
    id: 'r1', projectId: 'p', ticketId: 'REL-1', job: 'dev', queue: 'dev', status: 'running', claudeSessionId: 'c', linearSessionId: 'ls-1',
    startedAt: 1, costUsd: 0.5, turns: 2, lastText: '', token: 'tok', cwd: '/w',
  });
  return { app, store, tracker, submitted, linearWebhook, transcriptsDir };
}

describe('server', () => {
  it('forwards raw webhooks with lower-cased headers', async () => {
    const { app, linearWebhook } = setup();
    const res = await app.request('/webhooks/linear', { method: 'POST', body: '{"x":1}', headers: { 'Linear-Signature': 'abc' } });
    expect(res.status).toBe(200);
    expect(linearWebhook).toHaveBeenCalledWith('{"x":1}', expect.objectContaining({ 'linear-signature': 'abc' }));
  });

  it('serves state without run tokens', async () => {
    const { app } = setup();
    const body = await (await app.request('/api/state')).json();
    expect(body.tickets).toHaveLength(1);
    expect(body.activeRuns[0].id).toBe('r1');
    expect(body.activeRuns[0].token).toBeUndefined();
    expect(body.capacity.dev).toEqual({ used: 1, total: 3 });
  });

  it('submits pause and stop controls', async () => {
    const { app, submitted } = setup();
    await app.request('/api/control/pause', { method: 'POST' });
    await app.request('/api/tickets/p/REL-1/stop', { method: 'POST' });
    expect(submitted.map((e) => [e.type, e.projectId, e.ticketId])).toEqual([
      ['control.pause', '*', undefined],
      ['control.stop', 'p', 'REL-1'],
    ]);
  });

  it('protects the agent API with the run token', async () => {
    const { app } = setup();
    expect((await app.request('/agent/issue/REL-1')).status).toBe(401);
    const ok = await app.request('/agent/issue/REL-1', { headers: { authorization: 'Bearer tok' } });
    expect((await ok.json()).identifier).toBe('REL-1');
    expect((await app.request('/agent/issue/REL-2', { headers: { authorization: 'Bearer tok' } })).status).toBe(403);
  });

  it('agent ask posts an elicitation and blocks the ticket', async () => {
    const { app, store, tracker } = setup();
    const res = await app.request('/agent/ask', { method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Quelle base ?' }) });
    expect(res.status).toBe(200);
    expect(tracker.activities('ls-1')).toEqual([{ type: 'elicitation', body: 'Quelle base ?' }]);
    expect(store.getTicket('p', 'REL-1')!.blocked).toBe(true);
  });

  it('returns a transcript and serves the UI', async () => {
    const { app, transcriptsDir } = setup();
    writeFileSync(join(transcriptsDir, 'r1.jsonl'), '{"type":"system"}\n{"type":"result"}\n');
    expect(await (await app.request('/api/runs/r1/transcript')).json()).toEqual([{ type: 'system' }, { type: 'result' }]);
    expect(await (await app.request('/')).text()).toContain('Relais');
    expect(await (await app.request('/some/route')).text()).toContain('Relais');
  });
});
