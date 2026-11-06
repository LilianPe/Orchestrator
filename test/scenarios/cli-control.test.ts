import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runStatusCommand, runStopCommand, type ControlDeps } from '../../src/cli/control.js';
import { EventBus } from '../../src/core/bus.js';
import { newTicketState } from '../../src/core/types.js';
import { createApp } from '../../src/server/app.js';
import { RUN_LEASE_MS } from '../../src/store/types.js';
import { createHarness, heldRun } from '../helpers/harness.js';

type H = ReturnType<typeof createHarness>;

/** The two commands against the daemon's own API, in this process, as ORC-220's criterion 4 asks. */
function control(h: H): ControlDeps & { lines: string[] } {
  const app = createApp({
    store: h.store,
    bus: new EventBus(),
    clock: h.clock,
    submit: (e) => h.orch.accept(e),
    isPaused: () => h.orch.isPaused(),
    blockTicket: async () => {},
    askQuestion: async () => {},
    linearWebhook: () => ({ status: 200 }),
    githubWebhook: async () => ({ status: 200 }),
    linearConnected: () => true,
    tracker: h.tracker,
    capacity: () => ({ dev: { used: 1, total: 3 }, questions: { used: 0, total: 2 } }),
    transcriptsDir: mkdtempSync(join(tmpdir(), 'factory-cli-')),
  });
  const lines: string[] = [];
  return { api: 'http://127.0.0.1:4100', headers: {}, out: (l) => void lines.push(l), fetch: (url, init) => app.request(url, init), lines };
}

describe('factory status and factory stop (ORC-220)', () => {
  it('status shows a run under way: its ticket, its job, since when', async () => {
    const h = createHarness();
    const runId = await heldRun(h);
    await h.advance(5 * 60_000);
    const c = control(h);
    expect(await runStatusCommand(c, h.clock.now())).toBe(0);
    expect(c.lines[0]).toContain('places dev 1/3');
    expect(c.lines).toContain('  REL-1  dev  Export CSV');
    expect(c.lines).toContain(`    run ${runId} : dev, depuis 5 min, 0.00 $`);
  });

  it('status tells a lease expired that nothing took up yet, and a blocked ticket its reason', async () => {
    const h = createHarness();
    const runId = await heldRun(h);
    h.clock.advance(RUN_LEASE_MS + 1);
    const c = control(h);
    await runStatusCommand(c, h.clock.now());
    expect(c.lines.some((l) => l.includes(runId) && l.includes('bail expiré'))).toBe(true);
    await runStopCommand(c, 'REL-1');
    await h.orch.drained();
    c.lines.length = 0;
    await runStatusCommand(c, h.clock.now());
    expect(c.lines).toContain('  REL-1  dev (bloqué)  Export CSV');
    expect(c.lines).toContain('    Arrêté à la demande');
  });

  it('stop goes to the project holding the ticket, not to a copy that only waited for its repo (ORC-316)', async () => {
    const copy = (projectId: string, patch: object) => ({ ...newTicketState(projectId, 'REL-1', 'T', 'dev', 1), ...patch });
    const tickets = [copy('api', { delegated: true, blocked: true, awaitingRepo: ['api', 'web'] }), copy('web', { delegated: true })];
    const asked: string[] = [];
    const fetch = (url: string) => {
      asked.push(url);
      return Response.json(url.endsWith('/api/state') ? { tickets } : {});
    };
    expect(await runStopCommand({ api: 'http://d', headers: {}, out: () => {}, fetch }, 'REL-1')).toBe(0);
    expect(asked.at(-1)).toBe('http://d/api/tickets/web/REL-1/stop');
  });

  it('stop stops the run, one the daemon reattached to included', async () => {
    const h = createHarness();
    const runId = await heldRun(h);
    await h.restart({ mode: 'brutal' });
    const c = control(h);
    expect(await runStopCommand(c, 'REL-1')).toBe(0);
    expect(c.lines).toEqual(['Arrêt demandé pour REL-1.']);
    await h.orch.drained();
    expect((await h.store.getRun(runId))!.status).toBe('stopped');
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Arrêté à la demande' });
    expect((await h.ticket()).activeRunId).toBeUndefined();
  });

  it('stop refuses a ticket the factory does not know', async () => {
    const c = control(createHarness());
    expect(await runStopCommand(c, 'REL-9')).toBe(1);
    expect(c.lines[0]).toContain('REL-9 inconnu');
  });

  it('says what to do when the daemon is down or asks for its password', async () => {
    const lines: string[] = [];
    const deps = { api: 'http://127.0.0.1:1', headers: {}, out: (l: string) => void lines.push(l) };
    expect(await runStatusCommand({ ...deps, fetch: async () => Promise.reject(new Error('fetch failed')) })).toBe(1);
    expect(lines.at(-1)).toContain('factory up');
    expect(await runStopCommand({ ...deps, fetch: async () => new Response('', { status: 401 }) }, 'REL-1')).toBe(1);
    expect(lines.at(-1)).toContain('FACTORY_UI_PASSWORD');
  });
});
