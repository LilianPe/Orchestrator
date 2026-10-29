import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PrPoller } from '../adapters/forge/pr-poller.js';
import { Orchestrator } from '../core/orchestrator.js';
import { TimerService } from '../runtime/timers.js';
import { saveInstance, saveSecrets } from '../config/instance.js';
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
    expect(runSettings.permissions.deny).toContain(`Read(/${home}/secrets.json)`);
    await app.stop();
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

  it('refuses to start on an invalid factory.yml, naming the key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4192, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    writeFileSync(join(home, 'factory.yml'), 'github: { app_id: 456, private_key: env:GH_APP_KEY }\n');
    await expect(startFactory({ home, fakeRunner: true, log: () => {}, env: {} })).rejects.toThrow(/github\.private_key : la variable d’environnement GH_APP_KEY/);
  });

  it('plans the reconciliation of each project in the store at start, once (ORC-185)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    const repo = mkdtempSync(join(tmpdir(), 'factory-repo-'));
    saveInstance(home, { port: 4193, host: '127.0.0.1', relay: { kind: 'none' }, projects: [{ id: 'p', repoPath: repo, linearTeamKey: 'REL' }], limits: {} });
    for (let start = 0; start < 2; start++) {
      const app = await startFactory({ home, fakeRunner: true, log: () => {}, env: {} });
      await app.stop();
    }
    const store = new SqliteStore(join(home, 'factory.db'));
    const planned = (await store.dueTimers(Number.MAX_SAFE_INTEGER)).filter((t) => t.kind === 'reconcile');
    store.close();
    expect(planned.map((t) => [t.projectId, t.key])).toEqual([['p', '_reconcile:reconcile']]);
  });

  it('falls back to the gh CLI when no GitHub App is configured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4189, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    const logs: string[] = [];
    const app = await startFactory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: {} });
    await app.stop();
    expect(logs.some((m) => m.includes('CLI gh'))).toBe(true);
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
    expect(logs).toContain('transcripts : 1 supprimé(s) après 30 jours');
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
  }, 4000);

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
    expect(logs.some((m) => m.includes('secret de webhook') && m.includes('refusé'))).toBe(warns);
  });

  it('TrackerSwitch explains how to connect', async () => {
    await expect(new TrackerSwitch(4100).getIssue('REL-1')).rejects.toThrow('Linear non connecté : ouvrez http://localhost:4100/oauth/start');
  });

  it('refuses a non-loopback host without FACTORY_UI_PASSWORD', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4196, host: '0.0.0.0', relay: { kind: 'none' }, projects: [], limits: {} });
    await expect(startFactory({ home, fakeRunner: true, log: () => {}, env: {} })).rejects.toThrow(/FACTORY_UI_PASSWORD/);
  });

  it('protects the API with the UI password on a non-loopback host', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4195, host: '0.0.0.0', relay: { kind: 'none' }, projects: [], limits: {} });
    const app = await startFactory({ home, fakeRunner: true, log: () => {}, env: { FACTORY_UI_PASSWORD: 'pw' } });
    try {
      expect((await fetch('http://127.0.0.1:4195/api/state')).status).toBe(401);
      const auth = { authorization: `Basic ${Buffer.from('x:pw').toString('base64')}` };
      expect((await fetch('http://127.0.0.1:4195/api/state', { headers: auth })).status).toBe(200);
    } finally {
      await app.stop();
    }
  });
});
