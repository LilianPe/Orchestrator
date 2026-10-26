import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakeTracker } from '../adapters/tracker/fake.js';
import { EventBus } from '../core/bus.js';
import { FakeClock } from '../core/clock.js';
import { newTicketState, type FactoryEvent } from '../core/types.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { createApp } from './app.js';

async function setup(extra: { uiPassword?: string } = {}) {
  const store = new SqliteStore(':memory:');
  const bus = new EventBus();
  const tracker = new FakeTracker();
  tracker.addIssue({ identifier: 'REL-1', title: 'Export' });
  const submitted: FactoryEvent[] = [];
  const transcriptsDir = mkdtempSync(join(tmpdir(), 'factory-tr-'));
  const webDir = mkdtempSync(join(tmpdir(), 'factory-web-'));
  writeFileSync(join(webDir, 'index.html'), '<h1>Factory</h1>');
  const linearWebhook = vi.fn(() => ({ status: 200 }));
  const blockTicket = vi.fn(async (_p: string, _t: string, _reason: string) => {});
  const app = createApp({
    store, bus, clock: new FakeClock(10), submit: (e) => void submitted.push(e), isPaused: () => false, linearWebhook, blockTicket,
    linearConnected: () => true, tracker, capacity: () => ({ dev: { used: 1, total: 3 }, questions: { used: 0, total: 2 } }),
    transcriptsDir, webDir, ...extra,
  });
  await store.putTicket(newTicketState('p', 'REL-1', 'Export', 'dev', 1));
  await store.putRun({
    id: 'r1', projectId: 'p', ticketId: 'REL-1', job: 'dev', queue: 'dev', status: 'running', claudeSessionId: 'c', linearSessionId: 'ls-1',
    startedAt: 1, costUsd: 0.5, turns: 2, lastText: '', token: 'tok', cwd: '/w',
  });
  return { app, store, tracker, submitted, linearWebhook, blockTicket, transcriptsDir, webDir };
}

describe('server', () => {
  it('forwards raw webhooks with lower-cased headers', async () => {
    const { app, linearWebhook } = await setup();
    const res = await app.request('/webhooks/linear', { method: 'POST', body: '{"x":1}', headers: { 'Linear-Signature': 'abc' } });
    expect(res.status).toBe(200);
    expect(linearWebhook).toHaveBeenCalledWith('{"x":1}', expect.objectContaining({ 'linear-signature': 'abc' }));
  });

  it('serves state without run tokens', async () => {
    const { app } = await setup();
    const body = await (await app.request('/api/state')).json();
    expect(body.tickets).toHaveLength(1);
    expect(body.activeRuns[0].id).toBe('r1');
    expect(body.activeRuns[0].token).toBeUndefined();
    expect(body.capacity.dev).toEqual({ used: 1, total: 3 });
  });

  it('submits pause and stop controls', async () => {
    const { app, submitted } = await setup();
    await app.request('/api/control/pause', { method: 'POST' });
    await app.request('/api/tickets/p/REL-1/stop', { method: 'POST' });
    expect(submitted.map((e) => [e.type, e.projectId, e.ticketId])).toEqual([
      ['control.pause', '*', undefined],
      ['control.stop', 'p', 'REL-1'],
    ]);
  });

  it('protects the agent API with the run token', async () => {
    const { app } = await setup();
    expect((await app.request('/agent/issue/REL-1')).status).toBe(401);
    const ok = await app.request('/agent/issue/REL-1', { headers: { authorization: 'Bearer tok' } });
    expect((await ok.json()).identifier).toBe('REL-1');
    expect((await app.request('/agent/issue/REL-2', { headers: { authorization: 'Bearer tok' } })).status).toBe(403);
  });

  it('agent ask posts an elicitation and blocks the ticket through the orchestrator', async () => {
    const { app, tracker, blockTicket } = await setup();
    const res = await app.request('/agent/ask', { method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Quelle base ?' }) });
    expect(res.status).toBe(200);
    expect(tracker.activities('ls-1')).toEqual([{ type: 'elicitation', body: 'Quelle base ?' }]);
    expect(blockTicket).toHaveBeenCalledWith('p', 'REL-1', "Question posée par l'agent");
  });

  it('returns a transcript and serves the UI', async () => {
    const { app, transcriptsDir } = await setup();
    writeFileSync(join(transcriptsDir, 'r1.jsonl'), '{"type":"system"}\n{"type":"result"}\n');
    expect(await (await app.request('/api/runs/r1/transcript')).json()).toEqual([{ type: 'system' }, { type: 'result' }]);
    expect(await (await app.request('/')).text()).toContain('Factory');
    expect(await (await app.request('/some/route')).text()).toContain('Factory');
  });

  it('does not serve files outside webDir', async () => {
    const { app, webDir } = await setup();
    writeFileSync(join(webDir, '..', 'factory-secret.txt'), 'TOPSECRET');
    for (const path of ['/%2e%2e/factory-secret.txt', '/..%2ffactory-secret.txt', '/../factory-secret.txt']) {
      const res = await app.request(path);
      expect(await res.text()).not.toContain('TOPSECRET');
    }
  });

  it('returns 404 on a malformed URI without throwing', async () => {
    const { app } = await setup();
    const res = await app.request('/%E0%A4%A');
    expect(res.status).toBe(404);
  });

  it('skips a truncated last transcript line', async () => {
    const { app, transcriptsDir } = await setup();
    writeFileSync(join(transcriptsDir, 'r2.jsonl'), '{"type":"system"}\n{"type":"res');
    const res = await app.request('/api/runs/r2/transcript');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ type: 'system' }]);
  });

  describe('UI password (non-loopback host)', () => {
    const basic = (p: string) => ({ authorization: `Basic ${Buffer.from(`admin:${p}`).toString('base64')}` });

    it('requires Basic auth on the API, the UI and /oauth/start', async () => {
      const { app } = await setup({ uiPassword: 's3cret' });
      for (const path of ['/api/state', '/', '/oauth/start', '/api/runs/r1/transcript']) {
        const res = await app.request(path);
        expect(res.status, path).toBe(401);
        expect(res.headers.get('www-authenticate')).toMatch(/^Basic /);
      }
      expect((await app.request('/api/state', { headers: basic('wrong') })).status).toBe(401);
      expect((await app.request('/api/state', { headers: basic('s3cret') })).status).toBe(200);
      expect((await app.request('/api/control/pause', { method: 'POST' })).status).toBe(401);
    });

    it('leaves the webhook, the OAuth callback and the run-token agent API open', async () => {
      const { app } = await setup({ uiPassword: 's3cret' });
      expect((await app.request('/webhooks/linear', { method: 'POST', body: '{}' })).status).toBe(200);
      expect((await app.request('/oauth/callback?code=x&state=y')).status).not.toBe(401);
      expect((await app.request('/agent/issue/REL-1', { headers: { authorization: 'Bearer tok' } })).status).toBe(200);
    });
  });

  describe('CSRF', () => {
    it('rejects a mutating API call from another origin', async () => {
      const { app, submitted } = await setup();
      const res = await app.request('/api/control/pause', { method: 'POST', headers: { origin: 'https://evil.example' } });
      expect(res.status).toBe(403);
      const stop = await app.request('/api/tickets/p/REL-1/stop', { method: 'POST', headers: { origin: 'null' } });
      expect(stop.status).toBe(403);
      expect(submitted).toEqual([]);
    });

    it('accepts same-origin and Origin-less calls', async () => {
      const { app, submitted } = await setup();
      expect((await app.request('http://localhost:4100/api/control/pause', { method: 'POST', headers: { origin: 'http://localhost:4100' } })).status).toBe(200);
      expect((await app.request('/api/control/resume', { method: 'POST' })).status).toBe(200);
      expect(submitted).toHaveLength(2);
    });
  });
});
