import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakeTracker } from '../adapters/tracker/fake.js';
import { EventBus } from '../core/bus.js';
import { FakeClock } from '../core/clock.js';
import { newTicketState, type FactoryEvent } from '../core/types.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { LABELS } from '../../test/helpers/store-suite.js';
import { pendingLabels } from '../core/attempt-labels.js';
import { agentOnly, createApp } from './app.js';

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
  const githubWebhook = vi.fn(async () => ({ status: 401 }));
  const blockTicket = vi.fn(async (_p: string, _t: string, _reason: string) => {});
  const app = createApp({
    store, bus, clock: new FakeClock(10), submit: (e) => void submitted.push(e), isPaused: () => false, linearWebhook, githubWebhook, blockTicket,
    linearConnected: () => true, tracker, capacity: () => ({ dev: { used: 1, total: 3 }, questions: { used: 0, total: 2 } }),
    transcriptsDir, webDir, ...extra,
  });
  await store.putTicket(newTicketState('p', 'REL-1', 'Export', 'dev', 1));
  await store.putRun({
    id: 'r1', projectId: 'p', ticketId: 'REL-1', job: 'dev', queue: 'dev', status: 'running', claudeSessionId: 'c', linearSessionId: 'ls-1',
    startedAt: 1, costUsd: 0.5, turns: 2, lastText: '', token: 'tok', cwd: '/w',
  });
  return { app, store, bus, tracker, submitted, linearWebhook, githubWebhook, blockTicket, transcriptsDir, webDir };
}

describe('server', () => {
  it('forwards raw webhooks with lower-cased headers', async () => {
    const { app, linearWebhook } = await setup();
    const res = await app.request('/webhooks/linear', { method: 'POST', body: '{"x":1}', headers: { 'Linear-Signature': 'abc' } });
    expect(res.status).toBe(200);
    expect(linearWebhook).toHaveBeenCalledWith('{"x":1}', expect.objectContaining({ 'linear-signature': 'abc' }));
  });

  it('forwards raw GitHub webhooks with lower-cased headers and answers their status (ORC-134)', async () => {
    const { app, githubWebhook } = await setup();
    const res = await app.request('/webhooks/github', { method: 'POST', body: '{"x":1}', headers: { 'X-Hub-Signature-256': 'sha256=00', 'X-GitHub-Event': 'push' } });
    expect(res.status).toBe(401);
    expect(githubWebhook).toHaveBeenCalledWith('{"x":1}', expect.objectContaining({ 'x-hub-signature-256': 'sha256=00', 'x-github-event': 'push' }));
  });

  it('serves state without run tokens', async () => {
    const { app } = await setup();
    const body = await (await app.request('/api/state')).json();
    expect(body.tickets).toHaveLength(1);
    expect(body.activeRuns[0].id).toBe('r1');
    expect(body.activeRuns[0].token).toBeUndefined();
    expect(body.capacity.dev).toEqual({ used: 1, total: 3 });
  });

  it('serves the labels of a run with those still null and the tickets that will fill them (ORC-226)', async () => {
    const { app, store } = await setup();
    const run = (await store.getRun('r1'))!;
    await store.putRun({ ...run, id: 'r2', token: 'tok2', labels: LABELS });
    const body = await (await app.request('/api/state')).json();
    const labelled = body.activeRuns.find((r: { id: string }) => r.id === 'r2');
    expect(labelled.labels).toEqual({ ...LABELS, pending: pendingLabels(LABELS) });
    expect(labelled.labels.pending.effort).toEqual(['ORC-136', 'ORC-187']);
    expect(labelled.labels.pending).not.toHaveProperty('factoryCommit');
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

  it('the agent listener serves the agent API, with its run token, and nothing else (ORC-204)', async () => {
    const { app } = await setup({ uiPassword: 'pw' });
    const fetch = agentOnly(app);
    const get = (path: string, token = 'tok') => fetch(new Request(`http://172.17.0.1:4101${path}`, { headers: { authorization: `Bearer ${token}` } }));
    expect((await (await get('/agent/issue/REL-1')).json()).identifier).toBe('REL-1');
    expect((await get('/agent/issue/REL-1', 'nope')).status).toBe(401);
    for (const path of ['/api/state', '/', '/webhooks/linear', '/agent/../api/state', '/agent%2F..%2Fapi/state', '/agent']) {
      expect((await get(path)).status, path).toBe(404);
    }
  });

  it('agent ask posts an elicitation and blocks the ticket through the orchestrator', async () => {
    const { app, tracker, blockTicket } = await setup();
    const res = await app.request('/agent/ask', { method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Quelle base ?' }) });
    expect(res.status).toBe(200);
    expect(tracker.activities('ls-1')).toEqual([{ type: 'elicitation', body: 'Quelle base ?' }]);
    expect(blockTicket).toHaveBeenCalledWith('p', 'REL-1', "Question posée par l'agent");
  });

  it('agent ask answers without waiting for the block, and reports a failed one', async () => {
    const { app, blockTicket, bus } = await setup();
    let fail!: (err: Error) => void;
    blockTicket.mockImplementation(() => new Promise((_resolve, reject) => (fail = reject)));
    const logs: string[] = [];
    bus.subscribe((m) => m.kind === 'log' && logs.push(m.message));
    const res = await app.request('/agent/ask', { method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Quelle base ?' }) });
    expect(res.status).toBe(200);
    fail(new Error('store down'));
    await new Promise((r) => setImmediate(r));
    expect(logs).toEqual(['ask REL-1: store down']);
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

  describe('factory MCP (ORC-288)', () => {
    const output = { status: 'done', summary: 'Export ajouté', tests_added: ['export.test.ts'], why: 'demandé', assumptions: [], risks: [], untested: [], review_hints: [] };
    const rpc = (app: Awaited<ReturnType<typeof setup>>['app'], body: unknown, token = 'tok') =>
      agentOnly(app)(new Request('http://172.17.0.1:4101/agent/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) }));
    const call = async (app: Awaited<ReturnType<typeof setup>>['app'], name: string, args: unknown) =>
      (await (await rpc(app, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })).json()).result;

    it('initializes, echoing a known protocol version, and acknowledges the initialized notification', async () => {
      const { app } = await setup();
      const res = await (await rpc(app, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } } })).json();
      expect(res).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'factory' } } });
      const unknown = await (await rpc(app, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).json();
      expect(unknown.result.protocolVersion).toBe('2025-11-25');
      const note = await rpc(app, { jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(note.status).toBe(202);
      expect(await note.text()).toBe('');
      expect(await (await rpc(app, { jsonrpc: '2.0', id: 4, method: 'ping' })).json()).toEqual({ jsonrpc: '2.0', id: 4, result: {} });
    });

    it('answers any method but POST with 405 Allow: POST, never the UI', async () => {
      const { app } = await setup();
      for (const method of ['GET', 'DELETE']) {
        const res = await agentOnly(app)(new Request('http://172.17.0.1:4101/agent/mcp', { method, headers: { authorization: 'Bearer tok' } }));
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('POST');
      }
    });

    it('lists exactly submit_result, with the output JSON Schema, and ask', async () => {
      const { app } = await setup();
      const { tools } = (await (await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()).result;
      expect(tools.map((t: { name: string }) => t.name)).toEqual(['submit_result', 'ask']);
      expect(tools[0].inputSchema).toMatchObject({ type: 'object', required: expect.arrayContaining(['status', 'summary', 'review_hints']), additionalProperties: false });
      expect(tools[1].inputSchema).toMatchObject({ type: 'object', required: ['text'] });
    });

    it('submit_result stores a valid output for the run of the token, the last one winning', async () => {
      const { app, store } = await setup();
      expect(await call(app, 'submit_result', { ...output, summary: 'premier' })).toEqual({ content: [{ type: 'text', text: 'Résultat enregistré.' }] });
      await call(app, 'submit_result', output);
      expect(JSON.parse((await store.getMeta('agent-output:r1'))!)).toEqual(output);
    });

    it('submit_result refuses an invalid output, naming the fields, and stores nothing', async () => {
      const { app, store } = await setup();
      const res = await call(app, 'submit_result', { ...output, status: 'blocked', summary: '' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('summary');
      expect(res.content[0].text).toContain('question');
      expect(await store.getMeta('agent-output:r1')).toBeUndefined();
    });

    it('ask posts an elicitation and blocks the ticket, like /agent/ask', async () => {
      const { app, tracker, blockTicket } = await setup();
      expect((await call(app, 'ask', { text: 'Quelle base ?' })).isError).toBeUndefined();
      expect(tracker.activities('ls-1')).toEqual([{ type: 'elicitation', body: 'Quelle base ?' }]);
      expect(blockTicket).toHaveBeenCalledWith('p', 'REL-1', "Question posée par l'agent");
      expect((await call(app, 'ask', {})).isError).toBe(true);
    });

    it('answers 401 without a valid run token, -32601 on an unknown method, -32602 on an unknown tool', async () => {
      const { app } = await setup();
      expect((await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'nope')).status).toBe(401);
      const unknown = await (await rpc(app, { jsonrpc: '2.0', id: 7, method: 'server/discover' })).json();
      expect(unknown).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32601 } });
      const tool = await (await rpc(app, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'rm', arguments: {} } })).json();
      expect(tool.error.code).toBe(-32602);
    });
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
      // Its own signature guards it: the answer is the ingestion's, never the UI password's.
      expect((await app.request('/webhooks/github', { method: 'POST', body: '{}' })).headers.get('www-authenticate')).toBeNull();
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
