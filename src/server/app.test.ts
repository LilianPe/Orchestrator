import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakeTracker } from '../adapters/tracker/fake.js';
import { EventBus } from '../core/bus.js';
import { FakeClock } from '../core/clock.js';
import { newTicketState, TRUSTED, type FactoryEvent, type TicketState } from '../core/types.js';
import { SqliteStore } from '../store/sqlite-store.js';
import type { ChangelogEntry, SecurityLog } from '../store/types.js';
import { LABELS } from '../../test/helpers/store-suite.js';
import { pendingLabels } from '../core/attempt-labels.js';
import { agentOnly, createApp, type ServerDeps, type TakeOverDesk } from './app.js';
import { TAKEN_OVER } from '../core/block-cause.js';

async function setup(extra: Partial<Pick<ServerDeps, 'uiPassword' | 'usageLimitedUntil' | 'perTicketTokens' | 'takeOver' | 'configProblems' | 'heldRows' | 'mask'>> & { clock?: FakeClock } = {}) {
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
  const app = createApp({
    store, bus, clock: new FakeClock(10), submit: (e) => void submitted.push(e), isPaused: () => false, linearWebhook, githubWebhook,
    linearConnected: () => true, tracker, capacity: () => ({ dev: { used: 1, total: 3 }, questions: { used: 0, total: 2 } }),
    transcriptsDir, webDir, ...extra,
  });
  await store.putTicket(newTicketState('p', 'REL-1', 'Export', 'dev', 1));
  await store.putRun({
    id: 'r1', projectId: 'p', ticketId: 'REL-1', job: 'dev', queue: 'dev', status: 'running', claudeSessionId: 'c', linearSessionId: 'ls-1',
    startedAt: 1, costUsd: 0.5, turns: 2, lastText: '', token: 'tok', cwd: '/w',
  });
  return { app, store, bus, tracker, submitted, linearWebhook, githubWebhook, transcriptsDir, webDir };
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

  it('serves until when the usage limit holds the launches, null when it holds none (ORC-340)', async () => {
    expect((await (await (await setup()).app.request('/api/state')).json()).usageLimitedUntil).toBeNull();
    const held = await setup({ usageLimitedUntil: async () => 301_000 });
    expect((await (await held.app.request('/api/state')).json()).usageLimitedUntil).toBe(301_000);
  });

  it('serves state without run tokens', async () => {
    const { app } = await setup();
    const body = await (await app.request('/api/state')).json();
    expect(body.tickets).toHaveLength(1);
    expect(body.activeRuns[0].id).toBe('r1');
    expect(body.activeRuns[0].token).toBeUndefined();
    expect(body.capacity.dev).toEqual({ used: 1, total: 3 });
  });

  describe('the Flow (ORC-297)', () => {
    it('serves a blocked ticket in Needs you with its cause, a running run in Working with its step, duration and tokens', async () => {
      const { app, store } = await setup();
      const tokens = { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 };
      await store.putRun({ ...(await store.getRun('r1'))!, id: 'r0', status: 'failure', token: 'tok0', tokens });
      await store.putTicket({ ...newTicketState('p', 'REL-1', 'Export', 'dev', 1), activeRunId: 'r1' });
      await store.putTicket({ ...newTicketState('p', 'REL-2', 'Import', 'dev', 1), blocked: true, blockReason: "Waiting for an answer to the agent's question." });
      const res = await app.request('/api/flow');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.needsYou.blocked).toEqual([{ cause: 'question', tickets: [expect.objectContaining({ ticketId: 'REL-2', title: 'Import', reason: "Waiting for an answer to the agent's question." })] }]);
      expect(body.working).toEqual([expect.objectContaining({ runId: 'r1', ticketId: 'REL-1', title: 'Export', step: 'dev', stoppable: true, durationMs: 9, tokens, attemptsWithoutTokens: 0 })]);
    });

    it('still answers when the measures of a ticket cannot be read: Needs you never goes dark, the error is logged', async () => {
      const { app, store, bus } = await setup();
      const logs: string[] = [];
      bus.subscribe((m) => {
        if (m.kind === 'log') logs.push(m.message);
      });
      vi.spyOn(store, 'measureFacts').mockRejectedValue(new Error('journal illisible'));
      await store.putTicket({ ...newTicketState('p', 'REL-2', 'Import', 'dev', 1), blocked: true, blockReason: 'Stopped on request' });
      const res = await app.request('/api/flow');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.working).toEqual([expect.objectContaining({ runId: 'r1', tokens: null })]);
      expect(body.needsYou.blocked).toHaveLength(1);
      expect(logs).toEqual([expect.stringContaining('journal illisible')]);
    });

    it('asks for the password, as the other routes of the interface', async () => {
      const { app } = await setup({ uiPassword: 'secret' });
      expect((await app.request('/api/flow')).status).toBe(401);
    });

    it('serves no run token to the browser: not in the state, the Flow, the events nor the live stream', async () => {
      const { app, store, bus } = await setup();
      const TOKEN = 'CANARY-RUN-TOKEN';
      const run = (await store.getRun('r1'))!;
      await store.putRun({ ...run, token: TOKEN });
      await store.putRun({ ...run, id: 'r2', ticketId: 'REL-2', status: 'success', endedAt: 5, token: `${TOKEN}-2`, tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } });
      await store.putRun({ ...run, id: 'r3', ticketId: 'REL-3', status: 'failure', endedAt: 5, token: `${TOKEN}-3` });
      await store.putTicket({ ...newTicketState('p', 'REL-1', 'Export', 'dev', 1), activeRunId: 'r1' });
      await store.putTicket({ ...newTicketState('p', 'REL-2', 'Verif', 'human_review', 1), verifyingRunId: 'r2' });
      await store.putTicket({ ...newTicketState('p', 'REL-3', 'Bloqué', 'dev', 1), blocked: true, blockReason: 'The run dev failed.' });
      await store.recordEvent({ ...TRUSTED, id: 'e1', type: 'run.finished', at: 2, projectId: 'p', ticketId: 'REL-2', payload: { runId: 'r2', job: 'dev', outcome: 'success', costUsd: 0, turns: 1, lastText: '' } });

      for (const path of ['/api/state', '/api/flow', '/api/events/recent', '/api/measures', '/api/overview', '/api/runs/r1', '/api/runs/r2']) {
        const res = await app.request(path);
        expect(res.status, path).toBe(200);
        expect(await res.text(), path).not.toContain(TOKEN);
      }
      const flow = await (await app.request('/api/flow')).json();
      // The runs are in what was served: the check above saw them.
      expect(flow.working.map((w: { runId: string }) => w.runId)).toEqual(['r1', 'r2']);
      expect(flow.working[0].token).toBeUndefined();

      const live = await app.request('/api/events');
      const reader = live.body!.getReader();
      bus.publish({ kind: 'ticket', ticket: (await store.getTicket('p', 'REL-1'))! });
      const { value } = await reader.read();
      const chunk = new TextDecoder().decode(value);
      expect(chunk).toContain('REL-1');
      expect(chunk).not.toContain(TOKEN);
      await reader.cancel();
    });
  });

  describe('the measures (ORC-223)', () => {
    it('serves each ticket with the cost, duration and review rounds of its runs, from the journal and the run records', async () => {
      const { app, store } = await setup();
      const tokens = { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 };
      const run = (await store.getRun('r1'))!;
      await store.putRun({ ...run, id: 'r0', status: 'success', startedAt: 0, endedAt: 3, token: 'tok0', tokens, costUsd: 0.3, turns: 4, sessionRole: 'reviewer', job: 'review' });
      await store.putRun({ ...run, id: 'r1', sessionRole: 'implementer' });
      await store.recordEvent({ ...TRUSTED, id: 'd', type: 'ticket.delegated', at: 1, projectId: 'p', ticketId: 'REL-1', payload: { linearSessionId: 'ls-1' } });
      const res = await app.request('/api/measures');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tickets).toEqual([
        expect.objectContaining({
          projectId: 'p', ticketId: 'REL-1', title: 'Export', logical: 'dev', blocked: false,
          measures: expect.objectContaining({ tokens, costUsd: 0.8, startedAt: 0, leadTimeMs: null, workMs: 3, reviewRounds: { ai: 1, human: 0 }, attempts: 2 }),
        }),
      ]);
      expect(body.tickets[0].measures.runs.map((r: { id: string; durationMs: number | null }) => [r.id, r.durationMs])).toEqual([['r0', 3], ['r1', null]]);
    });

    it("serves the share of the ticket's token budget its code runs spent, against factory.yml's cap (ORC-216)", async () => {
      const share = async (perTicketTokens?: number) => {
        const { app, store } = await setup(perTicketTokens ? { perTicketTokens } : {});
        await store.putRun({ ...(await store.getRun('r1'))!, status: 'success', tokens: { input: 100, output: 150, cacheRead: 9_000, cacheCreation: 0 } });
        return (await (await app.request('/api/measures')).json()).tickets[0].measures.usageLimitShare;
      };
      expect(await share(1_000)).toBe(0.25);
      expect(await share()).toBeNull();
    });

    it('serves a ticket whose measures cannot be read with null measures, the others still measured, and logs it', async () => {
      const { app, store, bus } = await setup();
      const logs: string[] = [];
      bus.subscribe((m) => {
        if (m.kind === 'log') logs.push(m.message);
      });
      await store.putTicket(newTicketState('p', 'REL-2', 'Import', 'todo', 2));
      const read = store.measureFacts.bind(store);
      vi.spyOn(store, 'measureFacts').mockImplementation((projectId, ticketId) => (ticketId === 'REL-2' ? Promise.reject(new Error('journal illisible')) : read(projectId, ticketId)));
      const body = await (await app.request('/api/measures')).json();
      const by = Object.fromEntries(body.tickets.map((t: { ticketId: string; measures: unknown }) => [t.ticketId, t.measures]));
      expect(by['REL-2']).toBeNull();
      expect(by['REL-1']).toMatchObject({ attempts: 1 });
      expect(logs).toEqual([expect.stringContaining('journal illisible')]);
    });

    it("serves a blocked ticket's cause from its typed kind, as the Flow classes it (ORC-345), and none for a ticket not blocked", async () => {
      const { app, store } = await setup();
      await store.putTicket({ ...newTicketState('p', 'REL-2', 'Import', 'dev', 2), blocked: true, blockKind: 'asked', blockReason: 'Something else entirely' });
      const body = await (await app.request('/api/measures')).json();
      const by = Object.fromEntries(body.tickets.map((t: { ticketId: string; blockCause: unknown }) => [t.ticketId, t.blockCause]));
      expect(by).toEqual({ 'REL-1': null, 'REL-2': 'question' });
    });

    it('serves the most recently updated tickets first, at most 50', async () => {
      const { app, store } = await setup();
      for (let i = 2; i <= 52; i++) await store.putTicket(newTicketState('p', `REL-${i}`, `T${i}`, 'todo', 100 + i));
      const body = await (await app.request('/api/measures')).json();
      expect(body.tickets).toHaveLength(50);
      expect(body.tickets[0].ticketId).toBe('REL-52');
      expect(body.tickets.map((t: { ticketId: string }) => t.ticketId)).not.toContain('REL-1');
    });

    it('asks for the password, as the other routes of the interface', async () => {
      const { app } = await setup({ uiPassword: 'secret' });
      expect((await app.request('/api/measures')).status).toBe(401);
    });
  });

  describe('the overview (ORC-299)', () => {
    const DAY = 24 * 60 * 60 * 1000;

    it('serves the tickets merged in the period, their lead time, tokens and first try, and the delays of the human messages', async () => {
      const { app, store } = await setup();
      await store.putRun({ ...(await store.getRun('r1'))!, status: 'success', startedAt: 2, endedAt: 4, tokens: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 } });
      const delegated: FactoryEvent = { ...TRUSTED, id: 'd', type: 'ticket.delegated', at: 1, projectId: 'p', ticketId: 'REL-1', payload: { linearSessionId: 'ls-1' } };
      await store.appendInbox(delegated);
      await store.recordEvent(delegated);
      await store.markAcked('d', 3);
      await store.recordEvent({ ...TRUSTED, id: 'm', type: 'pr.merged', at: 7, projectId: 'p', ticketId: 'REL-1', payload: { number: 1, url: 'u', branch: 'b' } });
      const res = await app.request('/api/overview?since=0&until=100');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        since: 0, until: 100, unmeasured: 0, delivered: 1, medianLeadTimeMs: 6, tokensPerMerged: { mean: 150, leftOut: 0 },
        firstTry: { yes: 1, of: 1 }, messages: { count: 1, medianSignOfLifeMs: 2 }, baseline: null,
      });
    });

    it('reads the last 90 days by default, and only the tickets updated since the period began: the others cannot have changed in it', async () => {
      const clock = new FakeClock(100 * DAY);
      const { app, store } = await setup({ clock });
      await store.putTicket(newTicketState('p', 'REL-1', 'Export', 'done', 10 * DAY - 1));
      await store.putTicket(newTicketState('p', 'REL-2', 'Import', 'done', 50 * DAY));
      const read = vi.spyOn(store, 'measureFacts');
      const body = await (await app.request('/api/overview')).json();
      expect(body).toMatchObject({ since: 10 * DAY, until: 100 * DAY });
      expect(read.mock.calls.map((c) => c[1])).toEqual(['REL-2']);
    });

    it('serves the baseline computed last facing the measures, each of its measures by name (ORC-230)', async () => {
      const { app, store } = await setup();
      const v = (value: number) => ({ value, over: 4, leftOut: 1, noSource: false });
      await store.putBaseline({ projectId: 'p', since: 0, until: 90 * DAY, computedAt: 5, measures: { delivered: v(3), first_try: v(0.5) } }, false);
      expect((await (await app.request('/api/overview?since=0&until=100')).json()).baseline).toEqual({
        projectId: 'p', since: 0, until: 90 * DAY, computedAt: 5,
        measures: { delivered: { value: 3, over: 4, leftOut: 1, noSource: false }, first_try: { value: 0.5, over: 4, leftOut: 1, noSource: false } },
      });
    });

    it('counts a ticket whose measures cannot be read as unmeasured, and logs it', async () => {
      const { app, store, bus } = await setup();
      const logs: string[] = [];
      bus.subscribe((m) => {
        if (m.kind === 'log') logs.push(m.message);
      });
      vi.spyOn(store, 'measureFacts').mockRejectedValue(new Error('journal illisible'));
      expect(await (await app.request('/api/overview?since=0&until=100')).json()).toMatchObject({ unmeasured: 1, delivered: 0 });
      expect(logs).toEqual([expect.stringContaining('journal illisible')]);
    });

    it('refuses a period that is not one, and asks for the password as the other routes of the interface', async () => {
      expect((await (await setup()).app.request('/api/overview?since=100&until=10')).status).toBe(400);
      expect((await (await setup({ uiPassword: 'secret' })).app.request('/api/overview')).status).toBe(401);
    });
  });

  describe('the changelog (ORC-197)', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const entry = (id: string, at: number): ChangelogEntry => ({
      id, projectId: 'p', ticketId: id.split(':')[0]!, title: 'Export CSV', summary: 'Audits export to CSV.', prNumber: 3, prUrl: 'https://gh/pr/3', paths: [], visualProof: { status: 'not_applicable' }, at,
    });

    it('lists the entries of the period asked, the last 7 days by default, the most recent first, read-only', async () => {
      const clock = new FakeClock(30 * DAY);
      const { app, store } = await setup({ clock });
      for (const e of [entry('REL-1:1:1', 10 * DAY), entry('REL-2:1:1', 25 * DAY), entry('REL-3:1:1', 29 * DAY)]) await store.appendChangelog(e);
      expect(await (await app.request('/api/changelog')).json()).toEqual({ since: 23 * DAY, until: 30 * DAY, entries: [entry('REL-3:1:1', 29 * DAY), entry('REL-2:1:1', 25 * DAY)] });
      const all = await (await app.request(`/api/changelog?since=0&until=${30 * DAY}`)).json();
      expect(all.entries.map((e: ChangelogEntry) => e.ticketId)).toEqual(['REL-3', 'REL-2', 'REL-1']);
      expect((await app.request('/api/changelog?since=x')).status).toBe(400);
      await store.appendChangelog({ ...entry('OPS-1:1:1', 29 * DAY), projectId: 'ops' });
      expect((await (await app.request('/api/changelog?project=ops')).json()).entries.map((e: ChangelogEntry) => e.ticketId)).toEqual(['OPS-1']);
      // Nothing writes it from outside: the after_merge step alone appends to it.
      for (const method of ['POST', 'PUT', 'DELETE']) expect((await app.request('/api/changelog', { method })).status).not.toBe(200);
      expect((await (await setup({ uiPassword: 'secret' })).app.request('/api/changelog')).status).toBe(401);
    });
  });

  describe('the security log and the Pareto of the block causes (ORC-300)', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const log = (runId: string, ticketId: string, at: number): SecurityLog => ({
      runId, projectId: 'p', ticketId, at: at + 100,
      egress: [
        { at, method: 'GET', host: 'registry.npmjs.org', ok: true, up: 1, down: 1 },
        { at: at + 1, method: 'POST', host: 'evil.example', ok: false, up: 0, down: 0 },
        { at: at + 1, method: 'CONNECT', host: 'ghp_s3cret:x@evil', ok: false, up: 0, down: 0 },
      ],
      refusals: [
        { at: at + 2, tool: 'Bash', rule: 'push' },
        { at: at + 3, tool: 'Bash', rule: 'push' },
        { at: at + 4, tool: 'Bash', rule: 'force-push' },
      ],
      skipped: { egress: 0, refusals: 1 },
    });

    it("lists a run's refusals and refused hosts, counted per rule, without a command nor a path", async () => {
      const { app, store } = await setup();
      await store.putSecurityLog(log('r1', 'REL-1', 1_000));
      const res = await app.request('/api/security/runs/r1');
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const hidden of ['s3cret', 'git push', '/upload', '/pkg', 'not allowed']) expect(text).not.toContain(hidden);
      expect(JSON.parse(text)).toMatchObject({
        runId: 'r1', ticketId: 'REL-1',
        rules: [{ rule: 'push', refusals: 2 }, { rule: 'force-push', refusals: 1 }],
        hosts: [{ host: 'evil.example', requests: 1, refused: 1 }, { host: 'registry.npmjs.org', requests: 1, refused: 0 }, { host: '(not a host name)', requests: 1, refused: 1 }],
        skipped: { egress: 0, refusals: 1 },
      });
      expect((await app.request('/api/security/runs/nope')).status).toBe(404);
    });

    it('counts hosts, rules and runs over the period asked, the last 7 days by default', async () => {
      const clock = new FakeClock(30 * DAY);
      const { app, store } = await setup({ clock });
      await store.putSecurityLog(log('old', 'REL-1', 10 * DAY));
      await store.putSecurityLog(log('recent', 'REL-2', 25 * DAY));
      const body = await (await app.request('/api/security')).json();
      expect(body).toMatchObject({ since: 23 * DAY, until: 30 * DAY });
      expect(body.runs).toEqual([{ runId: 'recent', projectId: 'p', ticketId: 'REL-2', requests: 3, refused: 2, refusals: 3 }]);
      expect(body.runsLeftOut).toBe(0);
      expect(body.rules).toEqual([{ rule: 'push', refusals: 2 }, { rule: 'force-push', refusals: 1 }]);
      const both = await (await app.request(`/api/security?since=${5 * DAY}&until=${30 * DAY}`)).json();
      expect(both.runs.map((r: { runId: string }) => r.runId)).toEqual(['old', 'recent']);
      expect(both.hosts).toEqual([{ host: 'evil.example', requests: 2, refused: 2 }, { host: 'registry.npmjs.org', requests: 2, refused: 0 }, { host: '(not a host name)', requests: 2, refused: 2 }]);
      expect(JSON.stringify(both)).not.toContain('s3cret');
    });

    it('serves the 50 most refused runs of the period, and how many it leaves out', async () => {
      const { app, store } = await setup();
      for (let i = 0; i < 52; i++) await store.putSecurityLog({ ...log(`r${String(i).padStart(2, '0')}`, 'REL-1', 1), refusals: [] });
      const body = await (await app.request('/api/security?since=0&until=10')).json();
      expect(body.runs).toHaveLength(50);
      expect(body.runs[0].runId).toBe('r00');
      expect(body.runsLeftOut).toBe(2);
    });

    it('refuses a period that is not one', async () => {
      const { app } = await setup();
      for (const q of ['since=abc', 'since=10&until=5', 'until=1.5', 'since=-1']) {
        expect((await app.request(`/api/security?${q}`)).status, q).toBe(400);
        expect((await app.request(`/api/blocks?${q}`)).status, q).toBe(400);
      }
    });

    it('sorts the causes of the tickets moved into Blocked over the period by frequency', async () => {
      const clock = new FakeClock(30 * DAY);
      const { app, store } = await setup({ clock });
      let n = 0;
      const blockAt = async (ticketId: string, at: number, patch: Partial<TicketState>) => {
        const event = { ...TRUSTED, id: `e${++n}`, type: 'ticket.delegated', at, projectId: 'p', ticketId, payload: { linearSessionId: 'ls' } } as FactoryEvent;
        await store.appendInbox(event);
        await store.decide({
          event, workflow: { hash: 'h', definition: {} },
          decide: (t) => ({ ticket: { ...(t ?? newTicketState('p', ticketId, 'T', 'dev', 1)), ...patch }, effects: [], timers: [], clearTimers: false, at }),
        });
      };
      const red = { blocked: true, blockKind: 'red' as const, blockReason: 'red' };
      const clear = { blocked: false, blockKind: undefined, blockReason: undefined };
      await blockAt('REL-1', 10 * DAY, { blocked: true, blockKind: 'loop', blockReason: 'loop' });
      await blockAt('REL-1', 11 * DAY, clear);
      await blockAt('REL-1', 24 * DAY, red);
      await blockAt('REL-1', 25 * DAY, clear);
      await blockAt('REL-1', 26 * DAY, red);
      await blockAt('REL-2', 27 * DAY, { blocked: true, blockKind: 'budget', blockReason: 'tokens' });
      await blockAt('REL-3', 28 * DAY, red);

      const body = await (await app.request('/api/blocks')).json();
      expect(body).toEqual({
        since: 23 * DAY,
        until: 30 * DAY,
        total: 4,
        causes: [
          { cause: 'red', count: 3, share: 0.75, cumulative: 0.75 },
          { cause: 'limit', count: 1, share: 0.25, cumulative: 1 },
        ],
      });
      const all = await (await app.request(`/api/blocks?since=0&until=${30 * DAY}`)).json();
      expect(all.causes.map((c: { cause: string; count: number }) => [c.cause, c.count])).toEqual([['red', 3], ['limit', 1], ['loop', 1]]);
    });

    it('asks for the password, as the other routes of the interface', async () => {
      const { app } = await setup({ uiPassword: 'secret' });
      for (const path of ['/api/security', '/api/security/runs/r1', '/api/blocks']) expect((await app.request(path)).status, path).toBe(401);
    });
  });

  describe('the run detail (ORC-298)', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const ended = async (store: SqliteStore, endedAt: number) => {
      const run = (await store.getRun('r1'))!;
      await store.putRun({ ...run, status: 'success', endedAt, lastText: 'AGENT-CLAIM: merged at the first try', tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 } });
    };

    it('serves a finished run: its timeline, decisions, gates, findings, checks, cost per step and its transcript as lines', async () => {
      const { app, store, transcriptsDir } = await setup();
      await ended(store, 5);
      await store.recordEvent({ ...TRUSTED, id: 'd', type: 'ticket.delegated', at: 1, projectId: 'p', ticketId: 'REL-1', actor: 'u-lilian', payload: { linearSessionId: 'ls-1' } });
      await store.recordEvent({ ...TRUSTED, id: 'f', type: 'run.finished', at: 5, projectId: 'p', ticketId: 'REL-1', payload: { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 0.5, turns: 2, lastText: 'AGENT-CLAIM: merged at the first try', attempt: 'succeeded' } });
      await store.recordEvent({ ...TRUSTED, id: 'v', type: 'verify.passed', at: 6, projectId: 'p', ticketId: 'REL-1', payload: { runId: 'r1', job: 'dev', commands: ['npm test'] } });
      writeFileSync(join(transcriptsDir, 'r1.jsonl'), [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the code.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
        JSON.stringify({ type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 0.5, result: 'Done' }),
        '{"type":"res',
      ].join('\n'));
      const res = await app.request('/api/runs/r1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.run).toMatchObject({ id: 'r1', ticketId: 'REL-1', job: 'dev', status: 'success', outcome: 'succeeded', durationMs: 4 });
      expect(body.timeline.map((e: { id: string; ofRun: boolean }) => [e.id, e.ofRun])).toEqual([['d', false], ['f', true], ['v', true]]);
      expect(body.decisions).toEqual([expect.objectContaining({ id: 'd', who: 'u-lilian', channel: 'linear' })]);
      expect(body.checks).toEqual([expect.objectContaining({ check: 'verify', result: 'passed', names: ['npm test'] })]);
      expect(body.steps).toEqual([expect.objectContaining({ job: 'dev', attempts: 1, turns: 2, tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 } })]);
      expect(body).toMatchObject({ gates: [], findings: [] });
      expect(body.transcript).toEqual({
        status: 'kept',
        lines: [
          { kind: 'text', text: 'Reading the code.' },
          { kind: 'tool', name: 'Bash', input: 'npm test' },
          { kind: 'result', isError: false, costUsd: 0.5, turns: 2, text: 'Done' },
        ],
      });
      // The agent's last text is not the factory's to serve: only its transcript says what it wrote.
      expect(JSON.stringify(body)).not.toContain('AGENT-CLAIM');
    });

    it('says a transcript purged at 30 days instead of failing, and one never written as such, on the simulated clock', async () => {
      const clock = new FakeClock(10);
      const { app, store } = await setup({ clock });
      await ended(store, 10);
      clock.advance(30 * DAY - 1);
      let res = await app.request('/api/runs/r1');
      expect(res.status).toBe(200);
      expect((await res.json()).transcript).toEqual({ status: 'none' });
      clock.advance(1);
      res = await app.request('/api/runs/r1');
      expect(res.status).toBe(200);
      expect((await res.json()).transcript).toEqual({ status: 'purged' });
    });

    it('answers 404 for a run it does not know', async () => {
      const { app } = await setup();
      expect((await app.request('/api/runs/nope')).status).toBe(404);
    });
  });

  it('serves the labels of a run with those still null and the tickets that will fill them (ORC-226)', async () => {
    const { app, store } = await setup();
    const run = (await store.getRun('r1'))!;
    await store.putRun({ ...run, id: 'r2', token: 'tok2', labels: LABELS });
    const body = await (await app.request('/api/state')).json();
    const labelled = body.activeRuns.find((r: { id: string }) => r.id === 'r2');
    expect(labelled.labels).toEqual({ ...LABELS, pending: pendingLabels(LABELS) });
    expect(labelled.labels.pending.image).toEqual(['ORC-204']);
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
    // A stop is checked on the matrix (ORC-301): its author, and the role the dashboard's guard gives, journaled with it.
    expect(submitted[1]).toMatchObject({ actor: 'dashboard:local', roles: ['operator'] });
  });

  describe("a run's inspection (ORC-301)", () => {
    const atWork = async (store: SqliteStore) => store.putTicket({ ...newTicketState('p', 'REL-1', 'Export', 'dev', 1), activeRunId: 'r1' });

    it('pauses or stops that run alone: the stop names it, its author and the role the guard gives are journaled with it', async () => {
      const { app, store, submitted } = await setup();
      await atWork(store);
      expect((await app.request('/api/runs/r1/pause', { method: 'POST' })).status).toBe(200);
      expect((await app.request('/api/runs/r1/stop', { method: 'POST' })).status).toBe(200);
      expect(submitted).toEqual([
        expect.objectContaining({ type: 'control.stop', projectId: 'p', ticketId: 'REL-1', actor: 'dashboard:local', roles: ['operator'], payload: { runId: 'r1', pause: true } }),
        expect.objectContaining({ type: 'control.stop', projectId: 'p', ticketId: 'REL-1', actor: 'dashboard:local', roles: ['operator'], payload: { runId: 'r1' } }),
      ]);
      expect(new Set(submitted.map((e) => e.id)).size).toBe(2);
    });

    it('names the author by the user of the HTTP Basic auth, behind the password', async () => {
      const { app, store, submitted } = await setup({ uiPassword: 's3cret' });
      await atWork(store);
      const headers = { authorization: `Basic ${Buffer.from('armand:s3cret').toString('base64')}` };
      expect((await app.request('/api/runs/r1/stop', { method: 'POST' })).status).toBe(401);
      expect((await app.request('/api/runs/r1/stop', { method: 'POST', headers })).status).toBe(200);
      expect(submitted.map((e) => e.actor)).toEqual(['dashboard:armand']);
    });

    it('takes no name from a Basic header without a password: on the loopback, the author is local', async () => {
      const { app, store, submitted } = await setup();
      await atWork(store);
      await app.request('/api/runs/r1/stop', { method: 'POST', headers: { authorization: `Basic ${Buffer.from('lilian:x').toString('base64')}` } });
      expect(submitted.map((e) => e.actor)).toEqual(['dashboard:local']);
    });

    it("answers 404 for an unknown run, 409 for a run that is not its ticket's at work (ended, a check), and submits nothing", async () => {
      const { app, store, submitted } = await setup();
      await store.putRun({ ...(await store.getRun('r1'))!, id: 'r0', status: 'success', endedAt: 5, token: 'tok0' });
      expect((await app.request('/api/runs/nope/stop', { method: 'POST' })).status).toBe(404);
      const ended = await app.request('/api/runs/r0/pause', { method: 'POST' });
      expect(ended.status).toBe(409);
      expect(await ended.json()).toEqual({ error: "run r0 is not the ticket's run at work" });
      // Still running, but the ticket's check, not its agent run.
      await store.putTicket({ ...newTicketState('p', 'REL-1', 'Export', 'dev', 1), verifyingRunId: 'r1' });
      expect((await app.request('/api/runs/r1/stop', { method: 'POST' })).status).toBe(409);
      expect(submitted).toEqual([]);
    });

    it('refuses a pause or a stop from another origin', async () => {
      const { app, store, submitted } = await setup();
      await atWork(store);
      const res = await app.request('http://localhost/api/runs/r1/stop', { method: 'POST', headers: { origin: 'https://evil.test' } });
      expect(res.status).toBe(403);
      expect(submitted).toEqual([]);
    });
  });

  describe('a human takes over a run (ORC-234)', () => {
    const atWork = async (store: SqliteStore) => store.putTicket({ ...newTicketState('p', 'REL-1', 'Export', 'dev', 1), activeRunId: 'r1' });
    const takenOver = async (store: SqliteStore) => store.putTicket({ ...newTicketState('p', 'REL-1', 'Export', 'dev', 1), blocked: true, blockKind: 'taken_over', blockReason: TAKEN_OVER });
    const desk = (): TakeOverDesk & { kept: { projectId: string; ticketId: string; bytes: number }[] } => {
      const kept: { projectId: string; ticketId: string; bytes: number }[] = [];
      return {
        kept,
        attach: async (projectId, ticketId) => (projectId === 'p' && ticketId === 'REL-1' ? { command: ['docker', 'exec', '-it', 'c1', 'sh'], env: { DOCKER_HOST: 'unix:///run/user/1000/docker.sock' } } : undefined),
        keepBundle: async (projectId, ticketId, bytes) => (kept.push({ projectId, ticketId, bytes: bytes.byteLength }), `/runs/take-over-${projectId}-${ticketId}/1.bundle`),
      };
    };

    it('takes over that run alone: the stop names it and asks the take-over, its author and the role the guard gives journaled with it', async () => {
      const { app, store, submitted } = await setup({ takeOver: desk() });
      await atWork(store);
      expect((await app.request('/api/runs/r1/take-over', { method: 'POST' })).status).toBe(200);
      expect(submitted).toEqual([expect.objectContaining({ type: 'control.stop', projectId: 'p', ticketId: 'REL-1', actor: 'dashboard:local', roles: ['operator'], payload: { runId: 'r1', takeOver: true } })]);
    });

    it('refuses a take-over without sandboxes: never a shell on the server', async () => {
      const { app, store, submitted } = await setup();
      await atWork(store);
      const res = await app.request('/api/runs/r1/take-over', { method: 'POST' });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/sandbox/);
      expect(submitted).toEqual([]);
    });

    it("answers 409 for a run that is not its ticket's at work, and refuses another origin", async () => {
      const { app, store, submitted } = await setup({ takeOver: desk() });
      expect((await app.request('/api/runs/r1/take-over', { method: 'POST' })).status).toBe(409);
      await atWork(store);
      expect((await app.request('http://localhost/api/runs/r1/take-over', { method: 'POST', headers: { origin: 'https://evil.test' } })).status).toBe(403);
      expect(submitted).toEqual([]);
    });

    it("gives the command that opens a shell in the take-over's container, for a ticket taken over only", async () => {
      const { app, store } = await setup({ takeOver: desk() });
      expect((await app.request('/api/tickets/p/REL-1/take-over')).status).toBe(409);
      await takenOver(store);
      const res = await app.request('/api/tickets/p/REL-1/take-over');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ command: ['docker', 'exec', '-it', 'c1', 'sh'], env: { DOCKER_HOST: 'unix:///run/user/1000/docker.sock' } });
    });

    it('keeps a bundle handed back and submits it, journaled with its author: the factory checks it before any push', async () => {
      const d = desk();
      const { app, store, submitted } = await setup({ takeOver: d });
      await takenOver(store);
      const res = await app.request('/api/tickets/p/REL-1/take-over/bundle', { method: 'POST', body: new Uint8Array([1, 2, 3]) });
      expect(res.status).toBe(200);
      expect(d.kept).toEqual([{ projectId: 'p', ticketId: 'REL-1', bytes: 3 }]);
      expect(submitted).toEqual([expect.objectContaining({ type: 'control.bundle', projectId: 'p', ticketId: 'REL-1', actor: 'dashboard:local', roles: ['operator'], payload: { file: '/runs/take-over-p-REL-1/1.bundle' } })]);
    });

    it('takes no bundle for a ticket not taken over, nor an empty one, nor without sandboxes', async () => {
      const d = desk();
      const { app, store, submitted } = await setup({ takeOver: d });
      expect((await app.request('/api/tickets/p/REL-1/take-over/bundle', { method: 'POST', body: new Uint8Array([1]) })).status).toBe(409);
      await takenOver(store);
      expect((await app.request('/api/tickets/p/REL-1/take-over/bundle', { method: 'POST', body: new Uint8Array() })).status).toBe(400);
      const none = await setup();
      await takenOver(none.store);
      expect((await none.app.request('/api/tickets/p/REL-1/take-over/bundle', { method: 'POST', body: new Uint8Array([1]) })).status).toBe(409);
      expect([...submitted, ...none.submitted]).toEqual([]);
      expect(d.kept).toEqual([]);
    });
  });

  it('protects the agent API with the run token', async () => {
    const { app } = await setup();
    expect((await app.request('/agent/issue/REL-1')).status).toBe(401);
    const ok = await app.request('/agent/issue/REL-1', { headers: { authorization: 'Bearer tok' } });
    expect((await ok.json()).identifier).toBe('REL-1');
    expect((await app.request('/agent/issue/REL-2', { headers: { authorization: 'Bearer tok' } })).status).toBe(403);
  });

  it("searches the run's team alone, not the whole Linear workspace with the factory's token (ORC-349)", async () => {
    const { app, tracker } = await setup();
    tracker.addIssue({ identifier: 'REL-2', title: 'Export to CSV' });
    tracker.addIssue({ identifier: 'HR-7', title: 'Export of salaries' });
    const res = await app.request('/agent/search?q=export', { headers: { authorization: 'Bearer tok' } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { identifier: string }[]).map((h) => h.identifier).sort()).toEqual(['REL-1', 'REL-2']);
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

  it('agent ask journals the question, and tells nothing itself: `decide` blocks and the outbox writes it', async () => {
    const { app, tracker, submitted } = await setup();
    const res = await app.request('/agent/ask', { method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Quelle base ?' }) });
    expect(res.status).toBe(200);
    expect(submitted).toEqual([expect.objectContaining({ type: 'agent.asked', projectId: 'p', ticketId: 'REL-1', payload: { question: 'Quelle base ?', job: expect.any(String), linearSessionId: 'ls-1' } })]);
    expect(tracker.activities('ls-1')).toEqual([]);
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
      expect(await call(app, 'submit_result', { ...output, summary: 'premier' })).toEqual({ content: [{ type: 'text', text: 'Result recorded.' }] });
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

    it('ask journals the question, like /agent/ask', async () => {
      const { app, submitted } = await setup();
      expect((await call(app, 'ask', { text: 'Quelle base ?' })).isError).toBeUndefined();
      expect(submitted).toEqual([expect.objectContaining({ type: 'agent.asked', payload: expect.objectContaining({ question: 'Quelle base ?' }) })]);
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
      for (const path of ['/api/state', '/', '/oauth/start', '/api/runs/r1/transcript', '/api/runs/r1']) {
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

  describe('a foreign Host is refused: DNS rebinding (ORC-349)', () => {
    // A page of evil.example rebound to 127.0.0.1 sends Host and Origin of its own name: equal, so the Origin check passes.
    const as = (host: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string>), host } });

    it('refuses the interface, its reads and its writes, under a name that is not the loopback or the public URL', async () => {
      const { app, submitted } = await setup();
      expect((await app.request('/api/state', as('evil.example:4100'))).status).toBe(403);
      expect((await app.request('/', as('evil.example'))).status).toBe(403);
      const pause = await app.request('/api/control/pause', as('evil.example:4100', { method: 'POST', headers: { origin: 'http://evil.example:4100' } }));
      expect(pause.status).toBe(403);
      expect(submitted).toEqual([]);
    });

    it('answers under the loopback names alone, not a tunnel that brings the public URL here', async () => {
      const { app } = await setup();
      for (const host of ['localhost:4100', '127.0.0.1:4100', '127.0.1.1:4100', '[::1]:4100', 'LOCALHOST']) expect((await app.request('/api/state', as(host))).status, host).toBe(200);
      for (const host of ['factory.example.com', '127.0.0.1.evil.example', 'localhost.evil.example:4100', '127.0.0.1x']) expect((await app.request('/api/state', as(host))).status, host).toBe(403);
    });

    it('leaves the webhooks and the run-token agent API to their own guards, and the password-guarded interface to its password', async () => {
      const { app } = await setup();
      expect((await app.request('/webhooks/linear', as('relay.example', { method: 'POST', body: '{}' }))).status).toBe(200);
      expect((await app.request('/agent/issue/REL-1', as('host.containers.internal:4101', { headers: { authorization: 'Bearer tok' } }))).status).toBe(200);
      const guarded = await setup({ uiPassword: 's3cret' });
      const basic = { authorization: `Basic ${Buffer.from('x:s3cret').toString('base64')}` };
      expect((await guarded.app.request('/api/state', as('192.168.1.20:4100', { headers: basic }))).status).toBe(200);
    });
  });
});

describe('the health check and the diagnosis of a ticket (ORC-350)', () => {
  it('serves /health: 200 while it takes tickets, 503 with the reasons when the configuration is invalid or the store does not answer', async () => {
    const ok = await setup();
    const res = await ok.app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, store: 'ok', takingTickets: true, configProblems: [], linearConnected: true });

    const invalid = await setup({ configProblems: ['publication impossible: it needs the sandboxes and the GitHub App'] });
    const refused = await invalid.app.request('/health');
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ ok: false, takingTickets: false, configProblems: ['publication impossible: it needs the sandboxes and the GitHub App'] });

    const down = await setup();
    down.store.getMeta = async () => {
      throw new Error('connect ECONNREFUSED postgres://factory:pw@db');
    };
    const lost = await down.app.request('/health');
    expect(lost.status).toBe(503);
    const body = await lost.json();
    expect(body).toMatchObject({ ok: false, store: 'unreachable' });
    expect(JSON.stringify(body)).not.toContain('pw');
  });

  it('serves the diagnosis of a ticket with what holds the whole factory, 404 for a ticket it knows nothing of, 409 when two projects track it', async () => {
    const { app, store } = await setup({
      configProblems: ['no Claude token'],
      heldRows: (id) => (id === 'REL-1' ? [{ projectId: 'p', eventId: 'e1', type: 'ticket.delegated', error: 'token tok-123 refused', attempts: 3, behind: 0 }] : []),
      mask: (s) => s.replace('tok-123', '***'),
    });
    const res = await app.request('/tickets/REL-1/diagnosis');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      projectId: 'p',
      ticketId: 'REL-1',
      heldRow: { error: 'token *** refused' },
      factory: { takingTickets: false, configProblems: ['no Claude token'], paused: false, usageLimitedUntil: null },
    });
    expect(body.reasons).toContain('the factory takes no ticket, its configuration is invalid: no Claude token');
    expect(JSON.stringify(body)).not.toContain('tok-123');
    // The run's token stays out, as in /api/state.
    expect(body.run).toMatchObject({ id: 'r1', job: 'dev' });
    expect(body.run.token).toBeUndefined();

    expect((await app.request('/tickets/REL-404/diagnosis')).status).toBe(404);
    await store.putTicket(newTicketState('q', 'REL-1', 'Export', 'todo', 1));
    const twice = await app.request('/tickets/REL-1/diagnosis');
    expect(twice.status).toBe(409);
    expect(await twice.json()).toEqual({ error: 'REL-1 is tracked in several projects: ask with ?project=', projects: ['p', 'q'] });
    expect((await app.request('/tickets/REL-1/diagnosis?project=q')).status).toBe(200);
  });
});
