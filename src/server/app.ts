import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { parseStreamLine } from '../adapters/runner/stream-parser.js';
import { maskTranscriptLine, TRANSCRIPT_RETENTION_MS } from '../adapters/runner/transcript.js';
import type { ReplaySource } from '../ghost/delegate.js';
import type { SignIn } from '../adapters/forge/github-login.js';
import { auditSheet, humanReviewed, prsOf, type ReviewDefect } from '../core/audit.js';
import type { BusMessage, EventBus } from './live-feed.js';
import type { Clock } from '../core/clock.js';
import { pendingLabels } from '../core/attempt-labels.js';
import { blockPareto, causeOf, isTakenOver } from '../core/block-cause.js';
import type { TakeOverDesk } from '../core/orchestrator.js';
import { measureTicket, mergeTime, type TicketMeasures } from '../core/measures.js';
import { BASELINE_DAYS, DAY_MS } from '../core/baseline.js';
import { overview } from '../core/overview.js';
import { runDetail } from '../core/run-detail.js';
import { ticketDiagnoses, type HeldRow } from '../core/diagnosis.js';
import { TRUSTED, type FactoryEvent, type TicketState } from '../core/types.js';
import { cliActor, githubActor } from '../core/authz.js';
import type { RunRecord, Store } from '../store/types.js';
import { handleMcp } from '../api/mcp.js';
import { isLoopbackHost } from '../config/instance.js';
import type { KbHit } from '../knowledge/kb.js';
import { runSecurityView, shownHosts } from '../network/security-log.js';
import { buildFlow, flowKey, flowTicket } from './flow.js';
import { readSession, signSession } from './session.js';
import { readStatic } from './static.js';
import { PRODUCT_NAME } from '../product.js';

declare module 'hono' {
  interface ContextVariableMap {
    /** The GitHub login of the request's session, set by the guard off the loopback (ORC-399). */
    githubLogin?: string;
  }
}

export interface ServerDeps {
  store: Store;
  bus: EventBus;
  clock: Clock;
  /** Writes an event to the inbox (ORC-147); awaited before the route answers. */
  submit: (e: FactoryEvent) => unknown;
  isPaused: () => boolean | Promise<boolean>;
  /** Until when the Claude account's usage limit holds every launch (ORC-340); undefined when it holds none. Absent: never shown. */
  usageLimitedUntil?: () => Promise<number | undefined>;
  /** `budgets.per_ticket_tokens` of factory.yml (ORC-216): what the measures' `usageLimitShare` is a share of. Absent: no share. */
  perTicketTokens?: number;
  linearWebhook: (raw: string, headers: Record<string, string | undefined>) => { status: number } | Promise<{ status: number }>;
  /** The GitHub webhook (ORC-134): signature checked, events written to the inbox before the answer. */
  githubWebhook: (raw: string, headers: Record<string, string | undefined>) => Promise<{ status: number }>;
  oauth?: { authorizeUrl: () => string; callback: (code: string, state: string) => Promise<void> };
  linearConnected: () => boolean;
  /** The replay of closed tickets (ORC-376): a replayed ticket's run searches the knowledge base as of its start. */
  replays?: ReplaySource;
  /**
   * The MCP's `kb_search` (ORC-232), on the server's clone of the knowledge base; `repo`, another checkout of it (a replayed
   * ticket's, at transaction time: ORC-376). Absent: no knowledge base.
   */
  knowledgeSearch?: (q: string, repo?: string) => Promise<KbHit[]>;
  capacity: () => { dev: { used: number; total: number }; questions: { used: number; total: number } };
  transcriptsDir: string;
  webDir?: string;
  /**
   * When set (non-loopback host, ORC-399), a GitHub sign-in through the factory's App guards everything but the webhooks,
   * the OAuth callbacks and /agent: `authorizeUrl` is GitHub's authorization for a state, `signIn` who a callback's code
   * signs in and whether factory.yml lets them in. Absent: the loopback, where nobody signs in.
   */
  githubLogin?: { authorizeUrl: (state: string) => string; signIn: (code: string) => Promise<SignIn> };
  /** A human's take-over of a run (ORC-234), only with sandboxes: absent, there is none. */
  takeOver?: TakeOverDesk;
  /** Why the configuration lets no ticket reach its end (ORC-350): the daemon then takes none. Empty or absent: it takes them. */
  configProblems?: readonly string[];
  /** The controls factory.yml disables (`disabledControls`, ORC-381), shown by the dashboard. Absent: none. */
  disabledControls?: readonly string[];
  /** The failed inbox rows the worker holds for a ticket (ORC-350), for its diagnosis. */
  heldRows?: (ticketId: string) => HeldRow[];
  /** The daemon's secret values (`transcriptSecrets`), masked in what the diagnosis tells with the secret shapes; read once per request. */
  secrets?: () => string[];
  /** `audit.serious_defect` of factory.yml (ORC-153): absent, the defects of the audit sheets are kept, never counted (ORC-229). */
  seriousDefect?: string;
}

export type { TakeOverDesk };

/** The largest bundle handed back after a take-over (ORC-234), held in memory once before it is written. */
const MAX_BUNDLE_BYTES = 100 * 2 ** 20;

/** What each control of a run adds to its stop (ORC-301, ORC-234). */
const RUN_CONTROL = { pause: { pause: true }, stop: {}, 'take-over': { takeOver: true } } as const;

/** Tickets `GET /api/measures` serves, the most recently updated: each costs a read of its journal. */
const MEASURED_TICKETS = 50;
const MEASURES_AT_ONCE = 2;

/** Tickets `GET /api/audit` looks through for a PR a human reviewed, the most recently updated. */
const AUDITED_TICKETS = 50;

/** A defect a human enters from review (ORC-229): on a PR of the ticket, linked to an AI finding of the ticket or not. */
const defectEntry = z
  .object({
    prNumber: z.number().int().positive(),
    description: z.string().trim().min(1).max(4_000),
    findingId: z.string().min(1).max(200).optional(),
    file: z.string().trim().min(1).max(500).optional(),
    line: z.number().int().positive().optional(),
  })
  .strict();

/** Runs `GET /api/security` serves, the most refused: the others are counted. */
const SECURITY_RUNS = 50;
/** The period the security log and the Pareto read when none is asked (ORC-300). */
const DEFAULT_PERIOD_MS = 7 * DAY_MS;
/** The period the overview reads when none is asked (ORC-299): as long as the baseline it is to be compared with (ORC-230). */
const OVERVIEW_PERIOD_MS = BASELINE_DAYS * DAY_MS;

/** `[since, until)` from the query, in ms, `until` now and `since` `length` before by default; undefined when it is not a period. */
function periodOf(c: Context, now: number, length = DEFAULT_PERIOD_MS): { since: number; until: number } | undefined {
  const ms = (name: string, fallback: number) => {
    const raw = c.req.query(name);
    if (raw === undefined || raw === '') return fallback;
    return /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  };
  const until = ms('until', now);
  const since = ms('since', until - length);
  return Number.isNaN(since) || Number.isNaN(until) || since >= until ? undefined : { since, until };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sameSecret(a: string, b: string): boolean {
  const h = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

/** GitHub's callback of the dashboard's sign-in (ORC-399), guarded by its state. */
export const GITHUB_CALLBACK_PATH = '/auth/github/callback';
/** The session and the sign-in's state, each a cookie of this site alone: `__Host-` makes them HTTPS, path `/`, no domain. */
const SESSION_COOKIE = '__Host-factory_session';
const STATE_COOKIE = '__Host-factory_oauth';
/** How long a session lasts, and a sign-in started. */
const SESSION_MS = 12 * 3_600_000;
const SIGN_IN_MS = 10 * 60_000;
/**
 * Not `Strict`: the sign-in comes back from GitHub, and a strict cookie would not follow its redirect. The writes are
 * the `Origin` check's.
 */
const COOKIE = { path: '/', httpOnly: true, secure: true, sameSite: 'Lax' } as const;

/** The factory MCP (ORC-288): all the agents reach of the factory (ORC-192). */
export const AGENT_MCP_PATH = '/agent/mcp';

/** The agents' prefix: the MCP and, everywhere else under it, a 404 (ORC-192). */
export const isAgentPath = (path: string) => path === '/agent' || path.startsWith('/agent/');

/**
 * Public, guarded by their own: the webhooks, the OAuth callbacks, and `/agent`, so that what is not the MCP there answers 404,
 * never 401. And the health check (ORC-405), which tells the state alone.
 */
function isPublicPath(method: string, path: string): boolean {
  return (method === 'POST' && (path === '/webhooks/linear' || path === '/webhooks/github')) || (method === 'GET' && (path === '/oauth/callback' || path === GITHUB_CALLBACK_PATH)) || ((method === 'GET' || method === 'HEAD') && path === '/health') || isAgentPath(path);
}

/**
 * The mark of a request the CLI's Unix socket brought (ORC-405), in Hono's env: the host's name. Only `cliOnly` sets it;
 * nothing a request carries over HTTP reaches the env.
 */
const CLI_HOST = Symbol('cliHost');
const cliHostOf = (c: Context): string | undefined => (c.env as { [CLI_HOST]?: string } | undefined)?.[CLI_HOST];

/** What no guard of the interface holds: a public path, or a request of the CLI's socket (ORC-405). */
const unguarded = (c: Context) => isPublicPath(c.req.method, c.req.path) || cliHostOf(c) !== undefined;

/** What `factory status|stop|pause|resume` call (src/cli/control.ts). */
const CLI_ROUTES: readonly (readonly [string, RegExp])[] = [
  ['GET', /^\/api\/state$/],
  ['POST', /^\/api\/control\/(pause|resume)$/],
  ['POST', /^\/api\/tickets\/[^/]+\/[^/]+\/stop$/],
];

/**
 * The CLI's routes alone (ORC-405), for the listener of the Unix socket in FACTORY_HOME, which its file mode keeps to the
 * factory's user: let in without a GitHub sign-in, as the operator `cli:<host>`. Every other path answers 404.
 */
export function cliOnly(app: Hono, host: string): (req: Request) => Response | Promise<Response> {
  return (req) => {
    const path = new URL(req.url).pathname;
    return CLI_ROUTES.some(([method, route]) => method === req.method && route.test(path)) ? app.fetch(req, { [CLI_HOST]: host }) : new Response('Not Found', { status: 404 });
  };
}

/**
 * The factory MCP alone (ORC-204, ORC-192), for the listener the sandboxes reach off the loopback: every other
 * path answers 404. Node's server has already resolved `..` in the URL Hono routes on.
 */
export function agentOnly(app: Hono): (req: Request) => Response | Promise<Response> {
  return (req) => (new URL(req.url).pathname === AGENT_MCP_PATH ? app.fetch(req) : new Response('Not Found', { status: 404 }));
}

function publicRun({ token: _t, ...rest }: RunRecord) {
  // The labels still null, with the tickets that will fill them, as known now (ORC-226).
  return rest.labels ? { ...rest, labels: { ...rest.labels, pending: pendingLabels(rest.labels) } } : rest;
}

export function createApp(d: ServerDeps): Hono {
  const app = new Hono();

  /** The lines of a run's transcript, a half-written last one included; undefined without a file (never written, or purged). */
  const transcriptLines = (runId: string): string[] | undefined => {
    try {
      return readFileSync(join(d.transcriptsDir, `${runId.replace(/[^a-zA-Z0-9_-]/g, '')}.jsonl`), 'utf8').split('\n').filter(Boolean);
    } catch {
      // No file, or the purge removed it meanwhile.
      return undefined;
    }
  };

  // Drawn at each start and kept in memory alone (ORC-399): a restart ends every session.
  const sessionKey = randomBytes(32);
  /**
   * Who acts from the dashboard (ORC-301), checked on the matrix and journaled with the event: `cli:<host>` through the CLI's
   * socket (ORC-405); `github:<login>` of the session off the loopback (ORC-399), as the GitHub webhooks name their sender;
   * `dashboard:local` on the loopback, whatever header comes. Whoever passed the guard is an operator.
   */
  const operator = (c: Context): Pick<FactoryEvent, 'actor' | 'roles'> => {
    const cli = cliHostOf(c);
    const login = c.get('githubLogin');
    return { actor: cli !== undefined ? cliActor(cli) : login ? githubActor(login) : 'dashboard:local', roles: ['operator'] };
  };

  if (d.githubLogin) {
    const github = d.githubLogin;
    app.use('*', async (c, next) => {
      if (unguarded(c)) return next();
      const login = readSession(getCookie(c, SESSION_COOKIE), sessionKey, d.clock.now());
      if (login) {
        c.set('githubLogin', login);
        return next();
      }
      // A page a browser opens goes to GitHub, its state in a cookie of this browser; the API and the tools get a 401.
      if (c.req.method === 'GET' && c.req.header('accept')?.includes('text/html')) {
        const state = randomBytes(16).toString('hex');
        setCookie(c, STATE_COOKIE, state, { ...COOKIE, maxAge: SIGN_IN_MS / 1000 });
        return c.redirect(github.authorizeUrl(state));
      }
      return c.json({ error: 'sign in with GitHub first' }, 401);
    });
    // The state is this browser's and spent here: a callback another page forged, or replayed, exchanges no code.
    app.get(GITHUB_CALLBACK_PATH, async (c) => {
      const expected = deleteCookie(c, STATE_COOKIE, COOKIE);
      if (!expected || !sameSecret(expected, c.req.query('state') ?? '')) return c.html('<p>This sign-in was not started here, or has expired: open the dashboard again.</p>', 400);
      let who: SignIn;
      try {
        who = await github.signIn(c.req.query('code') ?? '');
      } catch (err) {
        return c.html(`<p>The GitHub sign-in failed: ${escapeHtml((err as Error).message)}</p>`, 502);
      }
      if (!who.allowed) {
        d.bus.publish({ kind: 'log', level: 'warn', message: `GitHub sign-in refused to the dashboard: ${who.login} is not in its list, org or team (factory.yml dashboard; an org or a team also needs the App's Members: read permission and its installation there)`, at: d.clock.now() });
        return c.html(`<p>${escapeHtml(who.login)} is not allowed on this ${escapeHtml(PRODUCT_NAME)}: ask its maintainers to add you to its dashboard's list, org or team.</p>`, 403);
      }
      setCookie(c, SESSION_COOKIE, signSession(who.login, d.clock.now() + SESSION_MS, sessionKey), { ...COOKIE, maxAge: SESSION_MS / 1000 });
      return c.redirect('/');
    });
  } else {
    // DNS rebinding (ORC-349): a page whose name the attacker rebinds to 127.0.0.1 is same-origin with this server under
    // that name, Origin and Host alike. Without a password, only a name of the loopback is answered.
    app.use('*', async (c, next) => {
      // The CLI's socket is no page a browser opens: no name to rebind.
      if (unguarded(c)) return next();
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

  // Read once at the start: a fix of the configuration needs a restart.
  const configProblems = d.configProblems ?? [];
  const takingTickets = configProblems.length === 0;

  // The health check (ORC-350): the store answers, and the factory takes tickets; 503 otherwise. Open (ORC-405), it tells
  // the state alone: why the configuration takes no ticket is the start's log and each ticket's diagnosis, behind the sign-in.
  app.get('/health', async (c) => {
    const store = await d.store.getMeta('paused').then(
      () => 'ok' as const,
      () => 'unreachable' as const,
    );
    const ok = store === 'ok' && takingTickets;
    return c.json({ ok, store, takingTickets }, ok ? 200 : 503);
  });

  // Why a ticket is stuck (ORC-350), with what holds every ticket: the configuration, the pause, the usage limit.
  app.get('/tickets/:id/diagnosis', async (c) => {
    const ticketId = c.req.param('id');
    const secrets = d.secrets?.() ?? [];
    const mask = (text: string) => maskTranscriptLine(text, secrets);
    const [found, paused, usageLimitedUntil] = await Promise.all([
      ticketDiagnoses({ store: d.store, ...(d.heldRows ? { held: d.heldRows } : {}), mask }, ticketId, c.req.query('project') || undefined),
      d.isPaused(),
      d.usageLimitedUntil?.(),
    ]);
    if (found.length === 0) return c.json({ error: `${ticketId}: no such ticket` }, 404);
    if (found.length > 1) return c.json({ error: `${ticketId} is tracked in several projects: ask with ?project=`, projects: found.map((f) => f.projectId).sort() }, 409);
    const diagnosis = found[0]!;
    const factory: string[] = [];
    if (!takingTickets) factory.push(`the factory launches no run, its configuration is invalid: ${configProblems.join('; ')}`);
    if (paused) factory.push('the factory is paused');
    if (usageLimitedUntil !== undefined) factory.push(`the Claude usage limit holds every launch until ${new Date(usageLimitedUntil).toISOString()}`);
    return c.json({
      ...diagnosis,
      factory: { takingTickets, configProblems, paused, usageLimitedUntil: usageLimitedUntil ?? null },
      reasons: [...factory, ...diagnosis.reasons],
    });
  });

  app.get('/api/state', async (c) => {
    // Independent reads: one round trip's wait on Postgres, not five.
    const [paused, tickets, queue, running, usageLimitedUntil] = await Promise.all([
      d.isPaused(),
      d.store.listTickets(),
      d.store.listQueue(),
      d.store.runsByStatus('running'),
      d.usageLimitedUntil?.(),
    ]);
    return c.json({
      paused,
      usageLimitedUntil: usageLimitedUntil ?? null,
      disabledControls: d.disabledControls ?? [],
      linearConnected: d.linearConnected(),
      tickets,
      queue,
      activeRuns: running.map(publicRun),
      capacity: d.capacity(),
    });
  });

  // A route over a period, `length` long by default: 400 when the query asks for one that is not.
  const overPeriod = (serve: (c: Context, period: { since: number; until: number }) => Promise<Response>, length?: number) => (c: Context) => {
    const period = periodOf(c, d.clock.now(), length);
    return period ? serve(c, period) : c.json({ error: 'since and until: whole ms, since before until' }, 400);
  };

  // The measures of a ticket, or null when they cannot be read: the error is logged, and that ticket alone loses them.
  const measuresOf = (t: { projectId: string; ticketId: string }): Promise<TicketMeasures | null> =>
    measureTicket(d.store, t.projectId, t.ticketId, d.perTicketTokens).catch((err: Error) => {
      d.bus.publish({ kind: 'log', level: 'error', message: `measures of ${t.ticketId}: ${err.message}`, at: d.clock.now() });
      return null;
    });

  app.get('/api/flow', async (c) => {
    const [tickets, running, queue] = await Promise.all([d.store.listTickets(), d.store.runsByStatus('running'), d.store.listQueue()]);
    const verifying = (await Promise.all(tickets.filter((t) => t.verifyingRunId).map((t) => d.store.getRun(t.verifyingRunId!)))).filter((r) => r !== undefined);
    // One ticket whose measures cannot be read loses its tokens, not the whole page.
    const measured = async (r: RunRecord) => {
      const m = await measuresOf(r);
      return m ? ([flowKey(r), m] as const) : undefined;
    };
    const atWork = new Map([...running, ...verifying].map((r) => [flowKey(r), r]));
    const measures = new Map((await Promise.all([...atWork.values()].map(measured))).filter((m) => m !== undefined));
    return c.json(buildFlow({ now: d.clock.now(), tickets, running, verifying, queue, measures }));
  });

  // The measures of the most recently updated tickets (ORC-223), read-only: one ticket whose measures cannot be read is
  // served with `measures: null`, the others still are. A blocked ticket's cause is its typed kind's, as the Flow classes it (ORC-345).
  const measuredTicket = (t: TicketState, measures: TicketMeasures | null) => ({
    ...flowTicket(t),
    logical: t.logical,
    blocked: t.blocked,
    blockCause: t.blocked ? causeOf(t.blockKind) : null,
    measures,
  });
  // Two tickets at a time: each read is five queries at once, on a pool of ten that also serves the webhooks and the worker.
  const twoAtATime = async <R>(tickets: TicketState[], read: (t: TicketState) => Promise<R>): Promise<R[]> => {
    const out: R[] = [];
    for (let i = 0; i < tickets.length; i += MEASURES_AT_ONCE) out.push(...(await Promise.all(tickets.slice(i, i + MEASURES_AT_ONCE).map(read))));
    return out;
  };
  const measuresOfAll = (tickets: TicketState[]) => twoAtATime(tickets, measuresOf);
  app.get('/api/measures', async (c) => {
    const tickets = (await d.store.listTickets()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MEASURED_TICKETS);
    const measures = await measuresOfAll(tickets);
    return c.json({ tickets: tickets.map((t, i) => measuredTicket(t, measures[i]!)) });
  });

  // The reduced overview (ORC-299), read-only, over a period, the last 90 days by default. Only the tickets the factory
  // updated since the period began are read: each event it decides updates its ticket, so the others hold no merge nor
  // message of the period. A ticket whose measures cannot be read is counted, the error logged. The baseline computed
  // last faces the measures (ORC-230).
  app.get('/api/overview', overPeriod(async (c, period) => {
    const [measures, baseline, defects] = await Promise.all([
      measuresOfAll((await d.store.listTickets()).filter((t) => t.updatedAt >= period.since)),
      d.store.latestBaseline(),
      d.store.reviewDefects(period.since, period.until),
    ]);
    const measured = measures.filter((m) => m !== null);
    return c.json(overview(period, measured, measures.length - measured.length, baseline, { defects, definition: d.seriousDefect }));
  }, OVERVIEW_PERIOD_MS));

  // The audit sheets (ORC-229): the PRs a human reviewed among the tickets updated last, and the sheet of one, read from its
  // journal, attempts and kept findings, with the defects humans entered. `definition`: the definition of a serious defect
  // they are counted by, null while none is set (ORC-153), and then nothing is counted.
  const definition = d.seriousDefect ?? null;
  app.get('/api/audit', async (c) => {
    const withPr = (await d.store.listTickets()).filter((t) => t.prNumber !== undefined).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, AUDITED_TICKETS);
    // A ticket whose facts cannot be read leaves the list, the error logged: the others are still served.
    const facts = await twoAtATime(withPr, (t) =>
      d.store.measureFacts(t.projectId, t.ticketId).catch((err: Error) => {
        d.bus.publish({ kind: 'log', level: 'error', message: `audit of ${t.ticketId}: ${err.message}`, at: d.clock.now() });
        return null;
      }),
    );
    const sheets = withPr.flatMap((t, i) => {
      const f = facts[i];
      if (!f || !humanReviewed(f)) return [];
      const merged = f.events.find((e): e is FactoryEvent<'pr.merged'> => e.type === 'pr.merged');
      return [{ ...flowTicket(t), logical: t.logical, mergedAt: merged ? mergeTime(merged) : null }];
    });
    return c.json({ sheets });
  });
  const defectLimit = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'defect over 16 KB' }, 413) });
  const sheetOf = async (projectId: string, ticketId: string) => {
    const [t, facts, findings, defects] = await Promise.all([
      d.store.getTicket(projectId, ticketId),
      d.store.measureFacts(projectId, ticketId),
      d.store.ticketFindings(projectId, ticketId),
      d.store.ticketDefects(projectId, ticketId),
    ]);
    return t ? auditSheet(t, facts, findings, defects) : undefined;
  };
  app.get('/api/audit/:projectId/:ticketId', async (c) => {
    const sheet = await sheetOf(c.req.param('projectId'), c.req.param('ticketId'));
    return sheet ? c.json({ ...sheet, definition }) : c.notFound();
  });
  // A defect found in human review, entered by an operator: on a PR of the sheet, linked to one of its findings or not. Kept
  // with the definition in force, never changed: only those under the definition in force are counted.
  app.post('/api/audit/:projectId/:ticketId/defects', defectLimit, async (c) => {
    // The body is checked before the sheet is read: a malformed entry costs no query.
    const parsed = defectEntry.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || 'body'))];
      return c.json({ error: `expected { prNumber, description, findingId?, file?, line? }: ${fields.join(', ')} at fault` }, 400);
    }
    // Only what the entry is checked against: the ticket's PRs and its kept findings, not the whole sheet.
    const projectId = c.req.param('projectId');
    const ticketId = c.req.param('ticketId');
    const [t, facts, findings] = await Promise.all([d.store.getTicket(projectId, ticketId), d.store.measureFacts(projectId, ticketId), d.store.ticketFindings(projectId, ticketId)]);
    if (!t) return c.json({ error: 'no such ticket' }, 404);
    const entry = parsed.data;
    if (!prsOf(facts.events).some((p) => p.number === entry.prNumber)) return c.json({ error: `PR #${entry.prNumber} is not a PR of ${ticketId}` }, 400);
    if (entry.findingId !== undefined && !findings.some((f) => f.id === entry.findingId)) return c.json({ error: `no finding ${entry.findingId} on ${ticketId}` }, 400);
    const defect: ReviewDefect = {
      id: randomUUID(),
      projectId,
      ticketId,
      prNumber: entry.prNumber,
      description: entry.description,
      findingId: entry.findingId ?? null,
      ...(entry.file === undefined ? {} : { file: entry.file }),
      ...(entry.line === undefined ? {} : { line: entry.line }),
      definition,
      enteredBy: operator(c).actor!,
      at: d.clock.now(),
    };
    await d.store.putReviewDefect(defect);
    return c.json({ ok: true, defect });
  });

  // The security log (ORC-300), read-only, from the logs the factory read off the proxy and the hook (ORC-296): hosts,
  // rules and runs over a period; a run's refusals and hosts. Never a command, a path nor a host that is not a plain name:
  // they can hold a secret.
  app.get('/api/security', overPeriod(async (c, period) => {
    const { hosts, rules, runs } = await d.store.securityStats(period.since, period.until);
    return c.json({ ...period, hosts: shownHosts(hosts), rules, runs: runs.slice(0, SECURITY_RUNS), runsLeftOut: Math.max(0, runs.length - SECURITY_RUNS) });
  }));
  app.get('/api/security/runs/:id', async (c) => {
    const log = await d.store.securityLog(c.req.param('id'));
    return log ? c.json(runSecurityView(log)) : c.notFound();
  });

  // The Pareto of the block causes (ORC-300): the moves into Blocked of the period, by their typed kind's cause (ORC-345).
  app.get('/api/blocks', overPeriod(async (c, period) => {
    const blocks = await d.store.blocksEntered(period.since, period.until);
    return c.json({ ...period, total: blocks.length, causes: blockPareto(blocks.map((b) => b.kind)) });
  }));

  // The changelog (ORC-197), read-only: what the merged PRs delivered over a period, the last 7 days by default, the most recent first,
  // of one project with `project`. Only the after_merge step appends to it.
  app.get('/api/changelog', overPeriod(async (c, period) => c.json({ ...period, entries: await d.store.changelog(period.since, period.until, c.req.query('project') || undefined) })));

  app.get('/api/events/recent', async (c) => c.json(await d.store.recentEvents(100, c.req.query('ticket') || undefined)));

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
    const lines = transcriptLines(c.req.param('id'));
    if (!lines) return c.notFound();
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

  // The detail of a run (ORC-298), read-only: its ticket's journal, attempts and outbox as the measures read them, and its
  // transcript as the lines the live session shows. A transcript gone past its retention is said purged, not an error.
  app.get('/api/runs/:id', async (c) => {
    const run = await d.store.getRun(c.req.param('id'));
    if (!run) return c.notFound();
    const detail = runDetail(run, await d.store.measureFacts(run.projectId, run.ticketId));
    const lines = transcriptLines(run.id);
    const purged = run.endedAt !== undefined && run.endedAt + TRANSCRIPT_RETENTION_MS <= d.clock.now();
    const transcript = lines ? { status: 'kept', lines: lines.flatMap(parseStreamLine) } : { status: purged ? 'purged' : 'none' };
    return c.json({ ...detail, transcript });
  });

  // The answer waits for the inbox write (ORC-147): `ok` means the command is recorded, with who asked it.
  const control = (type: 'control.pause' | 'control.resume') => async (c: Context) => {
    const at = d.clock.now();
    await d.submit({ ...TRUSTED, ...operator(c), id: `ui:${type}:${at}`, type, at, projectId: '*', payload: {} } as FactoryEvent);
    return c.json({ ok: true });
  };
  app.post('/api/control/pause', control('control.pause'));
  app.post('/api/control/resume', control('control.resume'));
  // A stop is checked on the matrix by `decide` (ORC-301), on the operator journaled with it.
  app.post('/api/tickets/:projectId/:ticketId/stop', async (c) => {
    const at = d.clock.now();
    const ticketId = c.req.param('ticketId');
    await d.submit({ ...TRUSTED, ...operator(c), id: `ui:stop:${ticketId}:${at}`, type: 'control.stop', at, projectId: c.req.param('projectId'), ticketId, payload: {} });
    return c.json({ ok: true });
  });
  // A run's inspection (ORC-301): the stop names its run, which `decide` stops only while it is its ticket's agent run (not a check,
  // not a question). The same check here answers the operator at once; `decide`'s is the one journaled.
  const runControl = (action: keyof typeof RUN_CONTROL) => async (c: Context) => {
    const runId = c.req.param('id')!;
    const run = await d.store.getRun(runId);
    if (!run) return c.json({ error: `unknown run ${runId}` }, 404);
    if ((await d.store.getTicket(run.projectId, run.ticketId))?.activeRunId !== runId) return c.json({ error: `run ${runId} is not the ticket's run at work` }, 409);
    // Only in a container of its own (ORC-234): without sandboxes, never a shell on the server.
    if (action === 'take-over' && !d.takeOver) return c.json({ error: 'taking over a run needs the sandboxes (FACTORY_CONTAINER_CLI): never a shell on the server' }, 409);
    const at = d.clock.now();
    const payload = { runId, ...RUN_CONTROL[action] };
    await d.submit({ ...TRUSTED, ...operator(c), id: `ui:${action}:${runId}:${at}`, type: 'control.stop', at, projectId: run.projectId, ticketId: run.ticketId, payload });
    return c.json({ ok: true });
  };
  app.post('/api/runs/:id/pause', runControl('pause'));
  app.post('/api/runs/:id/stop', runControl('stop'));
  app.post('/api/runs/:id/take-over', runControl('take-over'));

  // A ticket taken over (ORC-234): how to reach its container, and the bundle handed back, which `decide` checks on the matrix.
  const takenOver = async (c: Context): Promise<{ desk: TakeOverDesk; projectId: string; ticketId: string } | Response> => {
    const projectId = c.req.param('projectId')!;
    const ticketId = c.req.param('ticketId')!;
    if (!d.takeOver) return c.json({ error: 'no take-over without the sandboxes (FACTORY_CONTAINER_CLI)' }, 409);
    const t = await d.store.getTicket(projectId, ticketId);
    if (!isTakenOver(t)) return c.json({ error: `${ticketId} is not taken over` }, 409);
    return { desk: d.takeOver, projectId, ticketId };
  };
  app.get('/api/tickets/:projectId/:ticketId/take-over', async (c) => {
    const at = await takenOver(c);
    if (at instanceof Response) return at;
    const shell = await at.desk.attach(at.projectId, at.ticketId);
    return shell ? c.json(shell) : c.json({ error: `no container open for ${at.ticketId}: hand back a bundle, or reply to relaunch` }, 404);
  });
  const bundleLimit = bodyLimit({ maxSize: MAX_BUNDLE_BYTES, onError: (c) => c.json({ error: `bundle over ${MAX_BUNDLE_BYTES / 2 ** 20} MB` }, 413) });
  app.post('/api/tickets/:projectId/:ticketId/take-over/bundle', bundleLimit, async (c) => {
    const at = await takenOver(c);
    if (at instanceof Response) return at;
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.byteLength) return c.json({ error: 'empty bundle' }, 400);
    const file = await at.desk.keepBundle(at.projectId, at.ticketId, bytes);
    const now = d.clock.now();
    await d.submit({ ...TRUSTED, ...operator(c), id: `ui:bundle:${at.ticketId}:${now}`, type: 'control.bundle', at: now, projectId: at.projectId, ticketId: at.ticketId, payload: { file } });
    return c.json({ ok: true });
  });

  // The factory MCP alone under /agent (ORC-192): factory-agent's routes are gone, every other path is a 404, token or not.
  app.post(AGENT_MCP_PATH, async (c) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const run = token ? await d.store.findRunByToken(token) : undefined;
    if (!run || run.status !== 'running') return c.json({ error: 'unauthorized' }, 401);
    let msg: unknown;
    try {
      msg = await c.req.json();
    } catch {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    }
    const search = d.knowledgeSearch;
    // A replayed ticket's run (ORC-376): the knowledge base at its start, never the one of now, which may hold a note learned from
    // its own PR; none with `--memory off`.
    const kbSearch = search && (async (q: string) => {
      const replayed = await d.replays?.of(run.projectId, run.ticketId);
      if (!replayed) return search(q);
      return replayed.knowledge ? search(q, replayed.knowledge) : [];
    });
    const res = await handleMcp(msg, run, { store: d.store, ...(kbSearch ? { kbSearch } : {}) });
    return res ? c.json(res) : c.body(null, 202);
  });
  // No SSE stream to GET: the MCP transport's answer for a server that offers none.
  app.all(AGENT_MCP_PATH, (c) => c.body(null, 405, { Allow: 'POST' }));
  app.all('/agent', (c) => c.notFound());
  app.all('/agent/*', (c) => c.notFound());

  app.get('*', (c) => {
    if (!d.webDir) return c.notFound();
    const file = readStatic(d.webDir, new URL(c.req.url).pathname);
    if (!file) return c.notFound();
    return c.body(new Uint8Array(file.body), 200, { 'content-type': file.type });
  });

  return app;
}
