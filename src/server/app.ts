import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Tracker } from '../adapters/tracker/types.js';
import type { BusMessage, EventBus } from '../core/bus.js';
import type { Clock } from '../core/clock.js';
import type { RelaisEvent } from '../core/types.js';
import type { RunRecord, Store } from '../store/types.js';
import { readStatic } from './static.js';

export interface ServerDeps {
  store: Store;
  bus: EventBus;
  clock: Clock;
  submit: (e: RelaisEvent) => void;
  isPaused: () => boolean;
  linearWebhook: (raw: string, headers: Record<string, string | undefined>) => { status: number };
  oauth?: { authorizeUrl: () => string; callback: (code: string, state: string) => Promise<void> };
  linearConnected: () => boolean;
  tracker: Pick<Tracker, 'getIssue' | 'search' | 'activity'>;
  knowledgeSearch?: (q: string) => Promise<{ file: string; line: number; text: string }[]>;
  capacity: () => { dev: { used: number; total: number }; questions: { used: number; total: number } };
  dailyBudgetUsd?: number;
  transcriptsDir: string;
  webDir?: string;
}

type AgentEnv = { Variables: { run: RunRecord } };

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function publicRun({ token: _t, ...rest }: RunRecord) {
  return rest;
}

export function createApp(d: ServerDeps): Hono {
  const app = new Hono();

  app.post('/webhooks/linear', async (c) => {
    const raw = await c.req.text();
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const { status } = d.linearWebhook(raw, headers);
    return c.body(null, status as 200);
  });

  app.get('/oauth/start', (c) => (d.oauth ? c.redirect(d.oauth.authorizeUrl()) : c.notFound()));
  app.get('/oauth/callback', async (c) => {
    if (!d.oauth) return c.notFound();
    try {
      await d.oauth.callback(c.req.query('code') ?? '', c.req.query('state') ?? '');
      return c.html('<p>Linear est connecté. Vous pouvez fermer cet onglet.</p>');
    } catch (err) {
      return c.html(`<p>Connexion Linear impossible : ${escapeHtml((err as Error).message)}</p>`, 400);
    }
  });

  app.get('/api/state', (c) =>
    c.json({
      paused: d.isPaused(),
      linearConnected: d.linearConnected(),
      tickets: d.store.listTickets(),
      queue: d.store.listQueue(),
      activeRuns: d.store.runsByStatus('running').map(publicRun),
      costTodayUsd: d.store.costSince(startOfUtcDay(d.clock.now())),
      budgetUsd: d.dailyBudgetUsd ?? null,
      capacity: d.capacity(),
    }),
  );

  app.get('/api/events/recent', (c) => c.json(d.store.recentEvents(100, c.req.query('ticket') || undefined)));

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const queue: BusMessage[] = [];
      let wake: (() => void) | undefined;
      const off = d.bus.subscribe((m) => {
        queue.push(m);
        wake?.();
      });
      const ping = setInterval(() => {
        queue.push({ kind: 'log', level: 'info', message: 'ping', at: d.clock.now() });
        wake?.();
      }, 15_000);
      stream.onAbort(() => {
        off();
        clearInterval(ping);
        wake?.();
      });
      while (!stream.aborted) {
        const m = queue.shift();
        if (!m) {
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
          continue;
        }
        const event = m.kind === 'log' && m.message === 'ping' ? 'ping' : m.kind;
        await stream.writeSSE({ event, data: JSON.stringify(m) });
      }
    }),
  );

  app.get('/api/runs/:id/transcript', (c) => {
    const id = c.req.param('id').replace(/[^a-zA-Z0-9_-]/g, '');
    const file = join(d.transcriptsDir, `${id}.jsonl`);
    if (!existsSync(file)) return c.notFound();
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const parsed: unknown[] = [];
    for (const l of lines) {
      try {
        parsed.push(JSON.parse(l));
      } catch {
        // skip a half-written line
      }
    }
    return c.json(parsed);
  });

  const control = (type: 'control.pause' | 'control.resume') => (c: Context) => {
    const at = d.clock.now();
    d.submit({ id: `ui:${type}:${at}`, type, at, projectId: '*', payload: {} } as RelaisEvent);
    return c.json({ ok: true });
  };
  app.post('/api/control/pause', control('control.pause'));
  app.post('/api/control/resume', control('control.resume'));
  app.post('/api/tickets/:projectId/:ticketId/stop', (c) => {
    const at = d.clock.now();
    const ticketId = c.req.param('ticketId');
    d.submit({ id: `ui:stop:${ticketId}:${at}`, type: 'control.stop', at, projectId: c.req.param('projectId'), ticketId, payload: {} });
    return c.json({ ok: true });
  });

  const agent = new Hono<AgentEnv>();
  agent.use('*', async (c, next) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const run = token ? d.store.findRunByToken(token) : undefined;
    if (!run || run.status !== 'running') return c.json({ error: 'unauthorized' }, 401);
    c.set('run', run);
    await next();
  });
  agent.get('/issue/:id', async (c) => {
    const run = c.get('run');
    if (c.req.param('id') !== run.ticketId) return c.json({ error: 'forbidden' }, 403);
    return c.json(await d.tracker.getIssue(run.ticketId));
  });
  agent.get('/search', async (c) => c.json(await d.tracker.search(c.req.query('q') ?? '')));
  agent.get('/kb/search', async (c) => c.json(d.knowledgeSearch ? await d.knowledgeSearch(c.req.query('q') ?? '') : []));
  agent.post('/ask', async (c) => {
    const run = c.get('run');
    const { text } = (await c.req.json()) as { text?: string };
    if (!text) return c.json({ error: 'text required' }, 400);
    if (run.linearSessionId) await d.tracker.activity(run.linearSessionId, { type: 'elicitation', body: text });
    const t = d.store.getTicket(run.projectId, run.ticketId);
    if (t) {
      t.blocked = true;
      t.blockReason = "Question posée par l'agent";
      t.updatedAt = d.clock.now();
      d.store.putTicket(t);
      d.bus.publish({ kind: 'ticket', ticket: t });
    }
    return c.json({ ok: true });
  });
  app.route('/agent', agent);

  app.get('*', (c) => {
    if (!d.webDir) return c.notFound();
    const file = readStatic(d.webDir, new URL(c.req.url).pathname);
    if (!file) return c.notFound();
    return c.body(new Uint8Array(file.body), 200, { 'content-type': file.type });
  });

  return app;
}
