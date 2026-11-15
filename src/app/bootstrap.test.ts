import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PrPoller } from '../adapters/forge/pr-poller.js';
import { githubDelivery } from '../../test/helpers/github-webhook.js';
import { signLinear } from '../../test/helpers/linear-webhook.js';
import { Orchestrator, type OrchestratorDeps } from '../core/orchestrator.js';
import type { TicketState } from '../core/types.js';
import type { RunRecord } from '../store/types.js';
import { TimerService } from '../runtime/timers.js';
import { saveInstance, saveSecrets } from '../config/instance.js';
import { posixPath } from '../config/run-settings.js';
import { defaultWorkflow } from '../presets/workflow.js';
import { startFactory } from './bootstrap.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { TrackerSwitch } from './tracker-switch.js';

describe('bootstrap', () => {
  it('starts without Linear, serves state and stops cleanly', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4199, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    const app = await startFactory({ home, fakeRunner: true, log: () => {} });
    expect(app.url).toBe('http://localhost:4199');
    const state = await (await fetch('http://127.0.0.1:4199/api/state')).json();
    expect(state).toMatchObject({ linearConnected: false, paused: false, tickets: [] });
    const runSettings = JSON.parse(readFileSync(join(home, 'run-settings.json'), 'utf8'));
    expect(runSettings.permissions.deny).toContain(`Read(/${posixPath(home)}/secrets.json)`);
    await app.stop();
  });

  it('says at startup that no token budget caps a ticket, and only then (ORC-216)', async () => {
    const started = async (factoryYml?: string) => {
      const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
      saveInstance(home, { port: 4178, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
      if (factoryYml) writeFileSync(join(home, 'factory.yml'), factoryYml);
      const logs: string[] = [];
      const app = await startFactory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: {} });
      await app.stop();
      return logs.filter((m) => m.startsWith('Warning: no'));
    };
    expect(await started()).toContain('Warning: no ticket budget (budgets.per_ticket_tokens in factory.yml): a ticket runs whatever it spends; `factory validate` refuses until it is set.');
    expect((await started('budgets:\n  per_ticket_tokens: 1000000\n')).filter((m) => m.includes('budget'))).toEqual([]);
  });

  it('selects the GitHub App forge when the app is configured, without logging the key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    saveInstance(home, {
      port: 4190,
      host: '127.0.0.1',
      relay: { kind: 'none' },
      projects: [],
      limits: {},
      github: { appId: '123', privateKey: pem },
    });
    const logs: string[] = [];
    const app = await startFactory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: {} });
    await app.stop();
    expect(logs.some((m) => m.includes('GitHub App 123'))).toBe(true);
    expect(logs.join('\n')).not.toContain('PRIVATE KEY');
  });

  it('takes the GitHub App from factory.yml, its key from the environment (ORC-209)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    saveInstance(home, { port: 4191, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    writeFileSync(join(home, 'factory.yml'), 'github: { app_id: 456, private_key: env:GH_APP_KEY }\n');
    const logs: string[] = [];
    const app = await startFactory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: { GH_APP_KEY: pem } });
    await app.stop();
    expect(logs.some((m) => m.includes('GitHub App 456'))).toBe(true);
  });

  it('takes the dev capacity from concurrency in factory.yml (ORC-203)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4179, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    writeFileSync(join(home, 'factory.yml'), 'concurrency: 1\n');
    const app = await startFactory({ home, fakeRunner: true, log: () => {} });
    try {
      const state = (await (await fetch('http://127.0.0.1:4179/api/state')).json()) as { capacity: { dev: { total: number } } };
      expect(state.capacity.dev.total).toBe(1);
    } finally {
      await app.stop();
    }
  });

  describe('the whole-read settings of a run (ORC-279)', () => {
    /** What bootstrap gave the orchestrator: its `recover` is the first thing to run with them. */
    const depsOf = async (port: number, yml?: string) => {
      const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
      saveInstance(home, { port, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
      if (yml) writeFileSync(join(home, 'factory.yml'), yml);
      let deps: OrchestratorDeps | undefined;
      const recover = vi.spyOn(Orchestrator.prototype, 'recover').mockImplementation(async function (this: Orchestrator) {
        deps = (this as unknown as { d: OrchestratorDeps }).d;
      });
      const app = await startFactory({ home, fakeRunner: true, log: () => {}, env: {} });
      await app.stop();
      recover.mockRestore();
      return deps!;
    };
    const agentEnvOf = async (port: number, yml?: string) => (await depsOf(port, yml)).agentEnv({ token: 't', ticketId: 'REL-1' } as RunRecord);

    it('hands each run the threshold of factory.yml, and none when it declares none', async () => {
      expect((await agentEnvOf(4194, 'read_guard: { max_lines: 500 }\n'))['FACTORY_READ_MAX_LINES']).toBe('500');
      expect(await agentEnvOf(4195)).not.toHaveProperty('FACTORY_READ_MAX_LINES');
    });

    it('lets a run read the frozen tests of its ticket whole, and nothing on a ticket with no freeze', async () => {
      const { fullReadPaths } = await depsOf(4183);
      const frozen = { sha: 'abc', files: { 'src/export.test.ts': 'f1', 'vitest.config.ts': 'f2' } };
      expect(fullReadPaths!({ frozenTests: frozen } as Partial<TicketState> as TicketState)).toEqual(['src/export.test.ts', 'vitest.config.ts']);
      expect(fullReadPaths!({} as TicketState)).toEqual([]);
    });
  });

  it("runs a project on the factory/default workflow, its repository's .factory/workflow.yml ignored (ORC-388)", async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    const repo = mkdtempSync(join(tmpdir(), 'factory-boot-repo-'));
    mkdirSync(join(repo, '.factory'));
    writeFileSync(join(repo, '.factory/workflow.yml'), 'version: 1\nlimits: { verify_attempts: 9 }\njobs:\n  dev:\n    model: opus\n');
    saveInstance(home, { port: 4178, host: '127.0.0.1', relay: { kind: 'none' }, projects: [{ id: 'p', repoPath: repo, linearTeamKey: 'REL' }], limits: {} });
    writeFileSync(join(home, 'factory.yml'), 'budgets: { max_turns: { build: 40 } }\n');
    let deps: OrchestratorDeps | undefined;
    const recover = vi.spyOn(Orchestrator.prototype, 'recover').mockImplementation(async function (this: Orchestrator) {
      deps = (this as unknown as { d: OrchestratorDeps }).d;
    });
    const logs: string[] = [];
    try {
      const app = await startFactory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: {} });
      await app.stop();
    } finally {
      recover.mockRestore();
    }
    expect(deps!.projects[0]!.workflow).toEqual(defaultWorkflow({ budgets: { maxTurns: { build: 40 } } }));
    expect(logs).toContain('p: Warning: .factory/workflow.yml is ignored: the workflow is the factory/default preset. Delete it; its setup and checks go in .factory/config.yml.');
  });

  it('refuses to start on a Claude token a header cannot carry, naming the variable (ORC-337)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4192, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    await expect(startFactory({ home, fakeRunner: true, log: () => {}, env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x\r\nX-Injected: 1' } })).rejects.toThrow(/^CLAUDE_CODE_OAUTH_TOKEN: the Claude token holds a character/);
  });

  it('refuses to start on an invalid factory.yml, naming the key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4192, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    writeFileSync(join(home, 'factory.yml'), 'github: { app_id: 456, private_key: env:GH_APP_KEY }\n');
    await expect(startFactory({ home, fakeRunner: true, log: () => {}, env: {} })).rejects.toThrow(/github\.private_key: the environment variable GH_APP_KEY/);
  });

  it('plans the reconciliation of each project in the store at start, once, and drops a removed project\'s (ORC-185)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    const project = (id: string, key: string) => ({ id, repoPath: mkdtempSync(join(tmpdir(), 'factory-repo-')), linearTeamKey: key });
    const planned = async () => {
      const store = new SqliteStore(join(home, 'factory.db'));
      const timers = (await store.dueTimers(Number.MAX_SAFE_INTEGER)).filter((t) => t.kind === 'reconcile').map((t) => [t.projectId, t.key]);
      store.close();
      return timers.sort();
    };
    const start = async (projects: ReturnType<typeof project>[]) => {
      saveInstance(home, { port: 4193, host: '127.0.0.1', relay: { kind: 'none' }, projects, limits: {} });
      const app = await startFactory({ home, fakeRunner: true, log: () => {}, env: {} });
      await app.stop();
    };
    const a = project('a', 'AAA');
    const b = project('b', 'BBB');
    await start([a, b]);
    await start([a, b]);
    // One timer per project: their keys never collide, and a restart arms no second one.
    expect(await planned()).toEqual([['a', '_reconcile.a:reconcile'], ['b', '_reconcile.b:reconcile']]);
    await start([a]);
    expect(await planned()).toEqual([['a', '_reconcile.a:reconcile']]);
  });

  it('falls back to the gh CLI when no GitHub App is configured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4189, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    const logs: string[] = [];
    const app = await startFactory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: {} });
    await app.stop();
    expect(logs.some((m) => m.includes('gh CLI'))).toBe(true);
  });

  it('purges the transcripts older than 30 days at start', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4186, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    const dir = join(home, 'transcripts');
    mkdirSync(dir, { recursive: true });
    const old = join(dir, 'r-old.jsonl');
    const recent = join(dir, 'r-recent.jsonl');
    for (const f of [old, recent]) writeFileSync(f, '{}\n');
    const t = (Date.now() - 31 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(old, t, t);
    const logs: string[] = [];
    const app = await startFactory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: {} });
    await app.stop();
    expect([existsSync(old), existsSync(recent)]).toEqual([false, true]);
    expect(logs).toContain('transcripts: 1 deleted after 30 days');
  });

  it('closes the store it opened when the start fails afterwards', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4185, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    const recover = vi.spyOn(Orchestrator.prototype, 'recover').mockRejectedValue(new Error('boom'));
    const close = vi.spyOn(SqliteStore.prototype, 'close');
    try {
      await expect(startFactory({ home, fakeRunner: true, log: () => {}, env: {} })).rejects.toThrow('boom');
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      recover.mockRestore();
      close.mockRestore();
    }
  });

  it('stops the server and the timers it started when the start fails after them', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4184, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    const poll = vi.spyOn(PrPoller.prototype, 'start').mockImplementation(() => {
      throw new Error('boom');
    });
    const timersStop = vi.spyOn(TimerService.prototype, 'stop');
    const close = vi.spyOn(SqliteStore.prototype, 'close');
    try {
      await expect(startFactory({ home, fakeRunner: true, log: () => {}, env: {} })).rejects.toThrow('boom');
      expect(timersStop).toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      poll.mockRestore();
      timersStop.mockRestore();
      close.mockRestore();
    }
    // The port is free again: a second start listens on it.
    const app = await startFactory({ home, fakeRunner: true, log: () => {}, env: {} });
    expect((await fetch('http://127.0.0.1:4184/api/state')).status).toBe(200);
    await app.stop();
  });

  it('ticks the orchestrator every minute until stopped', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4198, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    const tick = vi.spyOn(Orchestrator.prototype, 'tick').mockResolvedValue();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const app = await startFactory({ home, fakeRunner: true, log: () => {} });
      vi.advanceTimersByTime(120_000);
      expect(tick).toHaveBeenCalledTimes(2);
      await app.stop();
      vi.advanceTimersByTime(120_000);
      expect(tick).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      tick.mockRestore();
    }
  });

  it('stops even while an SSE client is connected', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4197, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    const app = await startFactory({ home, fakeRunner: true, log: () => {} });
    const ctrl = new AbortController();
    const res = await fetch('http://127.0.0.1:4197/api/events', { signal: ctrl.signal });
    expect(res.status).toBe(200);
    await app.stop();
    ctrl.abort();
  });

  it.each([
    { webhookSecret: undefined, warns: true, port: 4194 },
    { webhookSecret: '', warns: true, port: 4193 },
    { webhookSecret: '  ', warns: true, port: 4192 },
    { webhookSecret: 'whsecret', warns: false, port: 4191 },
  ])('warns at startup only when the webhook signing secret is unusable ($webhookSecret)', async ({ webhookSecret, warns, port }) => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    if (webhookSecret !== undefined) saveSecrets(home, { linear: { clientId: 'cid', clientSecret: 'cs', webhookSecret } });
    const logs: string[] = [];
    const app = await startFactory({ home, fakeRunner: true, log: (m) => void logs.push(m) });
    await app.stop();
    expect(logs.some((m) => m.includes('webhook secret') && m.includes('refused'))).toBe(warns);
  });

  it('TrackerSwitch explains how to connect', async () => {
    await expect(new TrackerSwitch(4100).getIssue('REL-1')).rejects.toThrow('Linear not connected: open http://localhost:4100/oauth/start');
  });

  // ORC-399: off the loopback, the dashboard is reached through a GitHub sign-in alone; the shared password is gone.
  it("refuses a non-loopback host without the GitHub sign-in: the App's OAuth client, who is let in, an HTTPS publicUrl", async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    const client = { GH_APP_CLIENT_ID: 'Iv1.client', GH_APP_CLIENT_SECRET: 'client-secret' };
    const start = (env: NodeJS.ProcessEnv) => startFactory({ home, fakeRunner: true, log: () => {}, env });
    saveInstance(home, { port: 4196, host: '0.0.0.0', publicUrl: 'https://factory.example', relay: { kind: 'none' }, projects: [], limits: {} });
    // The old password opens nothing any more.
    await expect(start({ FACTORY_UI_PASSWORD: 'pw' })).rejects.toThrow(/GitHub sign-in.*github\.client_id.*GH_APP_CLIENT_ID/);
    await expect(start(client)).rejects.toThrow(/dashboard: \{ logins, org, team \}/);
    writeFileSync(join(home, 'factory.yml'), 'dashboard: { logins: [armand] }\n');
    saveInstance(home, { port: 4196, host: '0.0.0.0', publicUrl: 'http://factory.example', relay: { kind: 'none' }, projects: [], limits: {} });
    await expect(start(client)).rejects.toThrow(/publicUrl.*https/);
  });

  it('refuses to start real runs without a container engine or FACTORY_ALLOW_HOST_RUNS=1 (ORC-349)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4194, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    await expect(startFactory({ home, log: () => {}, env: {} })).rejects.toThrow(/FACTORY_ALLOW_HOST_RUNS=1/);
  });

  it('launches no run on a configuration that would block every ticket, and says why on /health (ORC-350)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4176, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    const logs: string[] = [];
    // Runs on the host, verify not allowed there, no GitHub App: every verified ticket would be blocked.
    const app = await startFactory({ home, log: (m) => void logs.push(m), env: { FACTORY_ALLOW_HOST_RUNS: '1' } });
    try {
      const res = await fetch('http://127.0.0.1:4176/health');
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toMatchObject({ ok: false, store: 'ok', takingTickets: false });
      expect(body.configProblems.slice(0, 2)).toEqual([
        'verify cannot run: no sandbox (FACTORY_CONTAINER_CLI) and no FACTORY_ALLOW_HOST_VERIFY=1',
        'publication impossible: it needs the sandboxes and the GitHub App',
      ]);
      // No budget in factory.yml: refused as `factory validate` refuses it.
      expect(body.configProblems[2]).toMatch(/^factory\.yml: budgets\.per_step_tokens\./);
      expect(logs).toContain('Invalid configuration, no run is launched until it is fixed and the factory restarted: verify cannot run: no sandbox (FACTORY_CONTAINER_CLI) and no FACTORY_ALLOW_HOST_VERIFY=1');
    } finally {
      await app.stop();
    }
  });

  it('serves /health while it takes tickets (ORC-350)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4175, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    const app = await startFactory({ home, fakeRunner: true, log: () => {}, env: {} });
    try {
      const res = await fetch('http://127.0.0.1:4175/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, store: 'ok', takingTickets: true, configProblems: [], linearConnected: false });
    } finally {
      await app.stop();
    }
  });

  it("guards the dashboard with the GitHub sign-in of the factory's App on a non-loopback host", async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4195, host: '0.0.0.0', publicUrl: 'https://factory.example', relay: { kind: 'none' }, projects: [], limits: {} });
    writeFileSync(join(home, 'factory.yml'), 'dashboard: { logins: [armand] }\n');
    const app = await startFactory({ home, fakeRunner: true, log: () => {}, env: { GH_APP_CLIENT_ID: 'Iv1.client', GH_APP_CLIENT_SECRET: 'client-secret', FACTORY_UI_PASSWORD: 'pw' } });
    try {
      expect((await fetch('http://127.0.0.1:4195/api/state')).status).toBe(401);
      // No password opens it any more.
      const auth = { authorization: `Basic ${Buffer.from('x:pw').toString('base64')}` };
      expect((await fetch('http://127.0.0.1:4195/api/state', { headers: auth })).status).toBe(401);
      // The health check and the diagnosis too (ORC-350): what blocks a ticket is the operators'.
      expect((await fetch('http://127.0.0.1:4195/health')).status).toBe(401);
      expect((await fetch('http://127.0.0.1:4195/tickets/REL-1/diagnosis')).status).toBe(401);
      // A page sends the browser to GitHub, to the App's authorization, coming back to the public URL.
      const page = await fetch('http://127.0.0.1:4195/', { headers: { accept: 'text/html' }, redirect: 'manual' });
      expect(page.status).toBe(302);
      const to = new URL(page.headers.get('location')!);
      expect(to.origin + to.pathname).toBe('https://github.com/login/oauth/authorize');
      expect(to.searchParams.get('client_id')).toBe('Iv1.client');
      expect(to.searchParams.get('redirect_uri')).toBe('https://factory.example/auth/github/callback');
    } finally {
      await app.stop();
    }
  });

  // Every inbound webhook, as the daemon wires it (ORC-222): no body reaches the inbox unless signed with its secret, and fresh when
  // the provider dates it. The checks themselves are tested with each ingest; here, that each route and the relay go through them.
  describe('signed webhooks (ORC-222)', () => {
    const reaction = (id: string, at = Date.now()) => ({ type: 'Reaction', action: 'create', webhookTimestamp: at, data: { id } });
    const tenMinutesAgo = () => Date.now() - 10 * 60_000;
    const boot = (port: number, relay: Parameters<typeof saveInstance>[1]['relay'], o: { env?: NodeJS.ProcessEnv; log?: (m: string) => void } = {}) => {
      const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
      saveInstance(home, { port, host: '127.0.0.1', relay, projects: [], limits: {} });
      saveSecrets(home, { linear: { clientId: 'cid', clientSecret: 'cs', webhookSecret: 'linear-secret' } });
      return startFactory({ home, fakeRunner: true, log: o.log ?? (() => {}), env: o.env ?? {} });
    };

    it('refuses on each webhook route a body unsigned, signed with another secret, or stale, and takes a signed fresh one', async () => {
      const app = await boot(4166, { kind: 'none' }, { env: { GH_WEBHOOK_SECRET: 'github-secret' } });
      try {
        const post = (path: string, { raw, headers }: { raw: string; headers: Record<string, string> }) =>
          fetch(`http://127.0.0.1:4166${path}`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', ...headers } }).then((r) => r.status);

        const fresh = signLinear(reaction('r1'), 'linear-secret');
        expect(await post('/webhooks/linear', { raw: fresh.raw, headers: {} })).toBe(401);
        expect(await post('/webhooks/linear', signLinear(reaction('r1'), 'another-secret'))).toBe(401);
        expect(await post('/webhooks/linear', signLinear(reaction('r1', tenMinutesAgo()), 'linear-secret'))).toBe(401);
        expect(await post('/webhooks/linear', fresh)).toBe(200);

        // GitHub dates no delivery: the signature alone.
        const ping = { zen: 'Keep it logically awesome.', hook_id: 1 };
        const signed = githubDelivery('ping', ping, 'github-secret');
        const { 'x-hub-signature-256': _signature, ...unsigned } = signed.headers;
        expect(await post('/webhooks/github', { raw: signed.raw, headers: unsigned })).toBe(401);
        expect(await post('/webhooks/github', githubDelivery('ping', ping, 'another-secret'))).toBe(401);
        expect(await post('/webhooks/github', signed)).toBe(200);
      } finally {
        await app.stop();
      }
    });

    it('refuses a webhook the smee relay brings unsigned, signed with another secret or stale, and takes a signed fresh one', async () => {
      const relayed = (d: { raw: string; headers: Record<string, string> }) => ({ ...d.headers, body: JSON.parse(d.raw) });
      // The signed fresh one first: were it refused, its rejection would be logged before the others are read.
      const messages = [
        relayed(signLinear(reaction('r1'), 'linear-secret')),
        { body: reaction('r2') },
        relayed(signLinear(reaction('r3'), 'another-secret')),
        relayed(signLinear(reaction('r4', tenMinutesAgo()), 'linear-secret')),
      ];
      let served = false;
      const sse = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        // Once: a reconnection of the relay brings nothing again.
        if (!served) for (const m of messages) res.write(`data: ${JSON.stringify(m)}\n\n`);
        served = true;
      });
      await new Promise<void>((resolve, reject) => sse.once('error', reject).listen(0, '127.0.0.1', resolve));
      const logs: string[] = [];
      const app = await boot(4165, { kind: 'smee', url: `http://127.0.0.1:${(sse.address() as AddressInfo).port}/chan` }, { log: (m) => void logs.push(m) });
      try {
        const relayLogs = () => logs.filter((m) => m.startsWith('relay: webhook'));
        await vi.waitFor(() => expect(relayLogs().length).toBeGreaterThanOrEqual(3), { timeout: 5_000 });
        expect(relayLogs()).toEqual(Array(3).fill(expect.stringMatching(/^relay: webhook rejected with 401/)));
      } finally {
        await app.stop();
        sse.closeAllConnections();
        sse.close();
      }
    });
  });
});
