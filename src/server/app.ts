import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { teamOf, type Tracker } from '../adapters/tracker/types.js';
import type { BusMessage, EventBus } from '../core/bus.js';
import type { Clock } from '../core/clock.js';
import { pendingLabels } from '../core/attempt-labels.js';
import { measureTicket, type TicketMeasures } from '../core/measures.js';
import { TRUSTED, type FactoryEvent, type TicketState } from '../core/types.js';
import type { RunRecord, Store } from '../store/types.js';
import { handleMcp } from '../api/mcp.js';
import { buildFlow, flowKey } from './flow.js';
import { readStatic } from './static.js';
import { PRODUCT_NAME } from '../product.js';

export interface ServerDeps {
  store: Store;
  bus: EventBus;
  clock: Clock;
  /** Writes an event to the inbox (ORC-147); awaited before the route answers. */
  submit: (e: FactoryEvent) => unknown;
  isPaused: () => boolean | Promise<boolean>;
  /** Until when the Claude account's usage limit holds every launch (ORC-340); undefined when it holds none. Absent: never shown. */
  usageLimitedUntil?: () => Promise<number | undefined>;
  linearWebhook: (raw: string, headers: Record<string, string | undefined>) => { status: number } | Promise<{ status: number }>;
  /** The GitHub webhook (ORC-134): signature checked, events written to the inbox before the answer. */
  githubWebhook: (raw: string, headers: Record<string, string | undefined>) => Promise<{ status: number }>;
  oauth?: { authorizeUrl: () => string; callback: (code: string, state: string) => Promise<void> };
  linearConnected: () => boolean;
  tracker: Pick<Tracker, 'getIssue' | 'search' | 'activity'>;
  knowledgeSearch?: (q: string) => Promise<{ file: string; line: number; text: string }[]>;
  capacity: () => { dev: { used: number; total: number }; questions: { used: number; total: number } };
  dailyBudgetUsd?: number;
  transcriptsDir: string;
  webDir?: string;
  /** When set (non-loopback host), HTTP Basic auth with this password guards everything but the webhook, the OAuth callback and /agent. */
  uiPassword?: string;
}

/**
 * A name of the loopback: `host` without a password listens there, and the interface without a password answers under
 * these names alone (ORC-349). Not `publicUrl`'s, which a tunnel brings here: the webhooks and the OAuth callback answer
 * under any name, the interface does not. A rebound name is never one of these.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

type AgentEnv = { Variables: { run: RunRecord } };

/** Tickets `GET /api/measures` serves, the most recently updated: each costs a read of its journal. */
const MEASURED_TICKETS = 50;

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sameSecret(a: string, b: string): boolean {
  const h = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

function basicPassword(header: string | undefined): string | undefined {
  const m = header?.match(/^Basic\s+(.+)$/i);
  if (!m) return undefined;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i < 0 ? undefined : decoded.slice(i + 1);
}

function isPublicPath(method: string, path: string): boolean {
  return (method === 'POST' && (path === '/webhooks/linear' || path === '/webhooks/github')) || (method === 'GET' && path === '/oauth/callback') || path === '/agent' || path.startsWith('/agent/');
}

/**
 * The agent API alone (ORC-204), for the listener the sandboxes reach off the loopback: every other
 * path answers 404. Node's server has already resolved `..` in the URL Hono routes on.
 */
export function agentOnly(app: Hono): (req: Request) => Response | Promise<Response> {
  return (req) => (new URL(req.url).pathname.startsWith('/agent/') ? app.fetch(req) : new Response('Not Found', { status: 404 }));
}

function publicRun({ token: _t, ...rest }: RunRecord) {
  // The labels still null, with the tickets that will fill them, as known now (ORC-226).
  return rest.labels ? { ...rest, labels: { ...rest.labels, pending: pendingLabels(rest.labels) } } : rest;
}

export function createApp(d: ServerDeps): Hono {
  const app = new Hono();

  if (d.uiPassword) {
    const password = d.uiPassword;
    app.use('*', async (c, next) => {
      if (isPublicPath(c.req.method, c.req.path)) return next();
      const given = basicPassword(c.req.header('authorization'));
      if (given === undefined || !sameSecret(given, password)) {
        return c.text('Authentication required', 401, { 'WWW-Authenticate': `Basic realm="${PRODUCT_NAME}", charset="UTF-8"` });
      }
      return next();
    });
  } else {
    // DNS rebinding (ORC-349): a page whose name the attacker rebinds to 127.0.0.1 is same-origin with this server under
    // that name, Origin and Host alike. Without a password, only a name of the loopback is answered.
    app.use('*', async (c, next) => {
      if (isPublicPath(c.req.method, c.req.path)) return next();
      if (!isLoopbackHost((c.req.header('host') ?? new URL(c.req.url).host).replace(/:\d*$/, ''))) return c.text('Unknown host', 403);
      return next();
    });
  }

  // CSRF: a browser always sends Origin on a cross-site POST; refuse it unless it is this server, whose name is checked above.
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    const origin = c.req.header('origin');
    if (origin !== undefined) {
      let host: string | undefined;
      try {
        host = new URL(origin).host;
      } catch {
        host = undefined;
      }
      if (!host || host !== new URL(c.req.url).host) return c.json({ error: 'cross-origin request refused' }, 403);
    }
    return next();
  });

  const webhook = (handle: ServerDeps['linearWebhook']) => async (c: Context) => {
    const raw = await c.req.text();
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const { status } = await handle(raw, headers);
    return c.body(null, status as 200);
  };
  app.post('/webhooks/linear', webhook(d.linearWebhook));
  app.post('/webhooks/github', webhook(d.githubWebhook));

  app.get('/oauth/start', (c) => (d.oauth ? c.redirect(d.oauth.authorizeUrl()) : c.notFound()));
  app.get('/oauth/callback', async (c) => {
    if (!d.oauth) return c.notFound();
    try {
      await d.oauth.callback(c.req.query('code') ?? '', c.req.query('state') ?? '');
      return c.html('<p>Linear is connected. You can close this tab.</p>');
    } catch (err) {
      return c.html(`<p>Could not connect Linear: ${escapeHtml((err as Error).message)}</p>`, 400);
    }
  });

  app.get('/api/state', async (c) => {
    // Independent reads: one round trip's wait on Postgres, not five.
    const [paused, tickets, queue, running, costTodayUsd, usageLimitedUntil] = await Promise.all([
      d.isPaused(),
      d.store.listTickets(),
      d.store.listQueue(),
      d.store.runsByStatus('running'),
      d.store.costSince(startOfUtcDay(d.clock.now())),
      d.usageLimitedUntil?.(),
    ]);
    return c.json({
      paused,
      usageLimitedUntil: usageLimitedUntil ?? null,
      linearConnected: d.linearConnected(),
      tickets,
      queue,
      activeRuns: running.map(publicRun),
      costTodayUsd,
      budgetUsd: d.dailyBudgetUsd ?? null,
      capacity: d.capacity(),
    });
  });

  app.get('/api/flow', async (c) => {
    const [tickets, running, queue] = await Promise.all([d.store.listTickets(), d.store.runsByStatus('running'), d.store.listQueue()]);
    const verifying = (await Promise.all(tickets.filter((t) => t.verifyingRunId).map((t) => d.store.getRun(t.verifyingRunId!)))).filter((r) => r !== undefined);
    // One ticket whose measures cannot be read loses its tokens, not the whole page.
    const measured = (r: RunRecord) =>
      measureTicket(d.store, r.projectId, r.ticketId).then(
        (m) => [flowKey(r), m] as const,
        (err: Error) => {
          d.bus.publish({ kind: 'log', level: 'error', message: `measures of ${r.ticketId}: ${err.message}`, at: d.clock.now() });
          return undefined;
        },
      );
    const atWork = new Map([...running, ...verifying].map((r) => [flowKey(r), r]));
    const measures = new Map((await Promise.all([...atWork.values()].map(measured))).filter((m) => m !== undefined));
    return c.json(buildFlow({ now: d.clock.now(), tickets, running, verifying, queue, measures }));
  });

  // The measures of the most recently updated tickets (ORC-223), read-only: one ticket whose measures cannot be read is
  // served with `measures: null`, the others still are.
  const measuredTicket = (t: TicketState, measures: TicketMeasures | null) => ({
    projectId: t.projectId,
    ticketId: t.ticketId,
    title: t.title,
    logical: t.logical,
    blocked: t.blocked,
    ...(t.prUrl === undefined ? {} : { prUrl: t.prUrl }),
    measures,
  });
  const measuresOf = (t: TicketState) =>
    measureTicket(d.store, t.projectId, t.ticketId).catch((err: Error) => {
      d.bus.publish({ kind: 'log', level: 'error', message: `measures of ${t.ticketId}: ${err.message}`, at: d.clock.now() });
      return null;
    });
  app.get('/api/measures', async (c) => {
    const tickets = (await d.store.listTickets()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MEASURED_TICKETS);
    return c.json({ tickets: await Promise.all(tickets.map(async (t) => measuredTicket(t, await measuresOf(t)))) });
  });
  app.get('/api/tickets/:projectId/:ticketId/measures', async (c) => {
    const ticket = await d.store.getTicket(c.req.param('projectId'), c.req.param('ticketId'));
    if (!ticket) return c.json({ error: 'unknown ticket' }, 404);
    const measures = await measuresOf(ticket);
    return measures ? c.json(measuredTicket(ticket, measures)) : c.json({ error: 'the measures could not be read' }, 500);
  });

  app.get('/api/events/recent',async (c) => c.json(await d.store.recentEvents(100, c.req.query('ticket') || undefined)));

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

  // The answer waits for the inbox write (ORC-147): `ok` means the command is recorded.
  const control = (type: 'control.pause' | 'control.resume') => async (c: Context) => {
    const at = d.clock.now();
    await d.submit({ ...TRUSTED, id: `ui:${type}:${at}`, type, at, projectId: '*', payload: {} } as FactoryEvent);
    return c.json({ ok: true });
  };
  app.post('/api/control/pause', control('control.pause'));
  app.post('/api/control/resume', control('control.resume'));
  app.post('/api/tickets/:projectId/:ticketId/stop', async (c) => {
    const at = d.clock.now();
    const ticketId = c.req.param('ticketId');
    await d.submit({ ...TRUSTED, id: `ui:stop:${ticketId}:${at}`, type: 'control.stop', at, projectId: c.req.param('projectId'), ticketId, payload: {} });
    return c.json({ ok: true });
  });

  const agent = new Hono<AgentEnv>();
  agent.use('*', async (c, next) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const run = token ? await d.store.findRunByToken(token) : undefined;
    if (!run || run.status !== 'running') return c.json({ error: 'unauthorized' }, 401);
    c.set('run', run);
    await next();
  });
  agent.get('/issue/:id', async (c) => {
    const run = c.get('run');
    if (c.req.param('id') !== run.ticketId) return c.json({ error: 'forbidden' }, 403);
    return c.json(await d.tracker.getIssue(run.ticketId));
  });
  // The run's team alone (ORC-349): the factory's token reads the whole workspace, the agent reads its ticket's team.
  agent.get('/search', async (c) => c.json(await d.tracker.search(c.req.query('q') ?? '', teamOf(c.get('run').ticketId))));
  agent.get('/kb/search', async (c) => c.json(d.knowledgeSearch ? await d.knowledgeSearch(c.req.query('q') ?? '') : []));
  // In the inbox, in order behind the events before it: the agent waits for no decision, and hears of a failed write.
  const ask = async (run: RunRecord, question: string) => {
    const at = d.clock.now();
    await d.submit({ ...TRUSTED, id: `ask:${run.id}:${at}`, type: 'agent.asked', at, projectId: run.projectId, ticketId: run.ticketId, payload: { question, job: run.job, ...(run.linearSessionId ? { linearSessionId: run.linearSessionId } : {}) } });
  };
  agent.post('/ask', async (c) => {
    const { text } = (await c.req.json()) as { text?: string };
    if (!text) return c.json({ error: 'text required' }, 400);
    await ask(c.get('run'), text);
    return c.json({ ok: true });
  });
  agent.post('/mcp', async (c) => {
    let msg: unknown;
    try {
      msg = await c.req.json();
    } catch {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    }
    const res = await handleMcp(msg, c.get('run'), { store: d.store, ask });
    return res ? c.json(res) : c.body(null, 202);
  });
  // No SSE stream to GET: the MCP transport's answer for a server that offers none.
  agent.all('/mcp', (c) => c.body(null, 405, { Allow: 'POST' }));
  app.route('/agent', agent);

  app.get('*', (c) => {
    if (!d.webDir) return c.notFound();
    const file = readStatic(d.webDir, new URL(c.req.url).pathname);
    if (!file) return c.notFound();
    return c.body(new Uint8Array(file.body), 200, { 'content-type': file.type });
  });

  return app;
}
