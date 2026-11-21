import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { githubDelivery } from '../../test/helpers/github-webhook.js';
import { signLinear } from '../../test/helpers/linear-webhook.js';
import { Daemon, type DaemonDeps } from '../runtime/daemon.js';
import type { TicketState } from '../core/types.js';
import type { RunRecord } from '../store/types.js';
import { TimerService } from '../runtime/timers.js';
import { oldInstanceFileWarnings, saveInstance, saveSecrets, validatorWarnings, type LinearSecrets } from '../config/instance.js';
import { LINEAR_NEEDS_SECRETS_KEY } from '../config/secrets-file.js';
import { defaultWorkflow } from '../presets/workflow.js';
import { createMissingStatuses, startFactory, type BootOptions } from './bootstrap.js';
import { runStatusCommand } from '../cli/control.js';
import { MemoryStore } from '../store/memory-store.js';
import { oldDatabaseWarnings } from '../store/old-databases.js';
import { TrackerSwitch } from './tracker-switch.js';

/** A start on a MemoryStore of its own, Postgres being the instance's only store (ORC-178): test/integration/open-store.test.ts starts on it. */
const startOnMemory = (o: BootOptions) => startFactory({ store: new MemoryStore(), ...o });

/** The daemon's `secrets_key`, from its environment: Linear's tokens are never written in clear (ORC-470). */
const KEY_ENV = { FACTORY_SECRETS_KEY: 'k'.repeat(44) };
/** Linear's values in `home`'s secrets.json, sealed with the `secrets_key` factory.yml names, read from `KEY_ENV`. */
function storeLinear(home: string, linear: LinearSecrets): void {
  appendFileSync(join(home, 'factory.yml'), 'secrets_key: env:FACTORY_SECRETS_KEY\n');
  saveSecrets(home, { linear }, KEY_ENV.FACTORY_SECRETS_KEY);
}

describe('bootstrap', () => {
  it('starts without Linear, serves state and stops cleanly', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4199, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    const app = await startOnMemory({ home, fakeRunner: true, log: () => {} });
    expect(app.url).toBe('http://localhost:4199');
    const state = await (await fetch('http://127.0.0.1:4199/api/state')).json();
    expect(state).toMatchObject({ linearConnected: false, paused: false, tickets: [] });
    // No run settings written for the host: a run reads the pack's own, in its sandbox (ORC-179).
    expect(existsSync(join(home, 'run-settings.json'))).toBe(false);
    await app.stop();
  });

  it('starts beside a relais.db or factory.db left from SQLite without opening it, and names each to archive (ORC-178)', async () => { // transition, à retirer
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4171, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    // Not a SQLite file: a start that opened one would fail on it.
    writeFileSync(join(home, 'relais.db'), 'not a database'); // transition, à retirer
    writeFileSync(join(home, 'factory.db'), 'not a database either');
    const logs: string[] = [];
    const app = await startOnMemory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: {} });
    await app.stop();
    expect(logs.filter((m) => m.includes('left from the SQLite store, not read'))).toEqual(oldDatabaseWarnings(home));
    expect(oldDatabaseWarnings(home)).toHaveLength(2);
    expect(readFileSync(join(home, 'relais.db'), 'utf8')).toBe('not a database'); // transition, à retirer
  });

  it('refuses to start without factory.yml, a config.yaml beside it never read (ORC-199)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    writeFileSync(join(home, 'config.yaml'), 'port: 4170\nhost: 127.0.0.1\n');
    await expect(startOnMemory({ home, fakeRunner: true, log: () => {}, env: {} })).rejects.toThrow(/^no factory\.yml in FACTORY_HOME: .*never config\.yaml \(ORC-199\)/);
  });

  it('starts on factory.yml beside the files of the instance before it, without reading them, and names each to delete (ORC-199)', async () => { // transition, à retirer
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4170, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    // Neither parses: a start that read one would fail on it.
    writeFileSync(join(home, 'config.yaml'), 'port: nope\n');
    writeFileSync(join(home, 'run-settings.json'), 'not json');
    mkdirSync(join(home, 'logs'));
    const logs: string[] = [];
    const app = await startOnMemory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: {} });
    await app.stop();
    expect(app.url).toBe('http://localhost:4170');
    expect(logs.filter((m) => m.includes('not read') && !m.includes('SQLite'))).toEqual(oldInstanceFileWarnings(home));
    expect(oldInstanceFileWarnings(home)).toHaveLength(3);
  });

  it('refuses to start without FACTORY_DATABASE_URL: Postgres is the only store (ORC-178)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4172, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    await expect(startFactory({ home, fakeRunner: true, log: () => {}, env: {} })).rejects.toThrow(/^FACTORY_DATABASE_URL is not set/);
  });

  it('says at startup that no token budget caps a ticket, and only then (ORC-216)', async () => {
    const started = async (factoryYml?: string) => {
      const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
      saveInstance(home, { port: 4178, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
      if (factoryYml) appendFileSync(join(home, 'factory.yml'), factoryYml);
      const logs: string[] = [];
      const app = await startOnMemory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: {} });
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
    saveInstance(home, { port: 4190, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    const logs: string[] = [];
    const app = await startOnMemory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: { GH_APP_ID: '123', GH_APP_KEY: pem } });
    await app.stop();
    expect(logs.some((m) => m.includes('GitHub App 123'))).toBe(true);
    expect(logs.join('\n')).not.toContain('PRIVATE KEY');
  });

  it('takes the GitHub App from factory.yml, its key from the environment (ORC-209)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    saveInstance(home, { port: 4191, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    appendFileSync(join(home, 'factory.yml'), 'github: { app_id: 456, private_key: env:GH_APP_KEY }\n');
    const logs: string[] = [];
    const app = await startOnMemory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: { GH_APP_KEY: pem } });
    await app.stop();
    expect(logs.some((m) => m.includes('GitHub App 456'))).toBe(true);
  });

  it('takes the dev capacity from concurrency in factory.yml (ORC-203)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4179, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    appendFileSync(join(home, 'factory.yml'), 'concurrency: 1\n');
    const app = await startOnMemory({ home, fakeRunner: true, log: () => {} });
    try {
      const state = (await (await fetch('http://127.0.0.1:4179/api/state')).json()) as { capacity: { dev: { total: number } } };
      expect(state.capacity.dev.total).toBe(1);
    } finally {
      await app.stop();
    }
  });

  describe('the whole-read settings of a run (ORC-279)', () => {
    /** What bootstrap gave the daemon: its `recover` is the first thing to run with them. */
    const depsOf = async (port: number, yml?: string) => {
      const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
      saveInstance(home, { port, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
      if (yml) appendFileSync(join(home, 'factory.yml'), yml);
      let deps: DaemonDeps | undefined;
      const recover = vi.spyOn(Daemon.prototype, 'recover').mockImplementation(async function (this: Daemon) {
        deps = (this as unknown as { d: DaemonDeps }).d;
      });
      const app = await startOnMemory({ home, fakeRunner: true, log: () => {}, env: {} });
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
    saveInstance(home, { port: 4178, host: '127.0.0.1', relay: { kind: 'none' }, projects: [{ id: 'p', repoPath: repo, linearTeamKey: 'REL' }] });
    appendFileSync(join(home, 'factory.yml'), 'budgets: { max_turns: { build: 40 } }\n');
    let deps: DaemonDeps | undefined;
    const recover = vi.spyOn(Daemon.prototype, 'recover').mockImplementation(async function (this: Daemon) {
      deps = (this as unknown as { d: DaemonDeps }).d;
    });
    const logs: string[] = [];
    try {
      const app = await startOnMemory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: {} });
      await app.stop();
    } finally {
      recover.mockRestore();
    }
    expect(deps!.projects[0]!.workflow).toEqual(defaultWorkflow({ budgets: { maxTurns: { build: 40 } } }));
    expect(logs).toContain('p: Warning: .factory/workflow.yml is ignored: the workflow is the factory/default preset. Delete it; its setup and checks go in .factory/config.yml.');
  });

  it('refuses to start on a Claude token a header cannot carry, naming the variable (ORC-337)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4192, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    await expect(startOnMemory({ home, fakeRunner: true, log: () => {}, env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x\r\nX-Injected: 1' } })).rejects.toThrow(/^CLAUDE_CODE_OAUTH_TOKEN: the Claude token holds a character/);
  });

  describe('the server secrets of a systemd credential (ORC-398)', () => {
    const SEALED_YML = 'secret_sources: { creds: { kind: systemd-creds } }\ngithub: { app_id: 456, private_key: creds:github-key }\nsecrets_key: creds:secrets-key\n';

    it('takes the GitHub App key from it, and encrypts a plaintext secrets.json at the start with its key', async () => {
      const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
      const credentials = mkdtempSync(join(tmpdir(), 'factory-creds-'));
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      writeFileSync(join(credentials, 'github-key'), privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
      writeFileSync(join(credentials, 'secrets-key'), 'a-secrets-key-of-at-least-32-characters\n');
      saveInstance(home, { port: 4174, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
      // Written in clear before ORC-398.
      writeFileSync(join(home, 'secrets.json'), JSON.stringify({ linear: { clientId: 'c', clientSecret: 'linear-client-secret', webhookSecret: 'linear-webhook-secret', accessToken: 'linear-access-token' } }));
      appendFileSync(join(home, 'factory.yml'), SEALED_YML);
      const logs: string[] = [];
      const app = await startOnMemory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: { CREDENTIALS_DIRECTORY: credentials } });
      await app.stop();
      expect(logs.some((m) => m.includes('GitHub App 456'))).toBe(true);
      expect(logs).toContain('secrets.json: encrypted at rest with secrets_key');
      expect(readFileSync(join(home, 'secrets.json'), 'utf8')).not.toContain('linear-access-token');
      expect(logs.join('\n')).not.toContain('PRIVATE KEY');
    });

    it('refuses to start when the credential cannot be read, naming the key and its reference', async () => {
      const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
      saveInstance(home, { port: 4173, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
      appendFileSync(join(home, 'factory.yml'), SEALED_YML);
      await expect(startOnMemory({ home, fakeRunner: true, log: () => {}, env: {} })).rejects.toThrow(
        /the secret github\.private_key \(creds:github-key\) could not be read: CREDENTIALS_DIRECTORY is not set/,
      );
    });
  });

  it('refuses to start on an invalid factory.yml, naming the key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4192, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    appendFileSync(join(home, 'factory.yml'), 'github: { app_id: 456, private_key: env:GH_APP_KEY }\n');
    await expect(startOnMemory({ home, fakeRunner: true, log: () => {}, env: {} })).rejects.toThrow(/github\.private_key: the environment variable GH_APP_KEY/);
  });

  it('plans the reconciliation of each project in the store at start, once, and drops a removed project\'s (ORC-185)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    const project = (id: string, key: string) => ({ id, repoPath: mkdtempSync(join(tmpdir(), 'factory-repo-')), linearTeamKey: key });
    // The same store at each start, as the instance's database is.
    const store = new MemoryStore();
    const planned = async () => {
      const timers = (await store.dueTimers(Number.MAX_SAFE_INTEGER)).filter((t) => t.kind === 'reconcile').map((t) => [t.projectId, t.key]);
      return timers.sort();
    };
    const start = async (projects: ReturnType<typeof project>[]) => {
      saveInstance(home, { port: 4193, host: '127.0.0.1', relay: { kind: 'none' }, projects });
      const app = await startOnMemory({ home, fakeRunner: true, log: () => {}, env: {}, store });
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

  // ORC-200: nothing pauses or resumes the queue any more; a pause left from before would hold every launch for good.
  it('lifts a pause of the queue left from before the global pause was removed, and says so', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4177, host: '127.0.0.1', relay: { kind: 'none' }, projects: [{ id: 'p', repoPath: mkdtempSync(join(tmpdir(), 'factory-repo-')), linearTeamKey: 'REL' }] });
    const store = new MemoryStore();
    await store.setMeta('paused', '1');
    const logs: string[] = [];
    const app = await startOnMemory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: {}, store });
    try {
      await vi.waitFor(async () => expect(await store.getMeta('paused')).toBe('0'), { timeout: 5000, interval: 50 });
      expect(logs).toContain('The queue was paused, and nothing pauses it any more (ORC-200): it is resumed.');
    } finally {
      await app.stop();
    }
    // Once only: a queue not paused is left as it is.
    logs.length = 0;
    await (await startOnMemory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: {}, store })).stop();
    expect(logs.join('\n')).not.toContain('ORC-200');
  });

  it('starts without a GitHub App, warning that it reads no PR and publishes nothing: no gh fallback (ORC-181)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4189, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    const logs: string[] = [];
    const app = await startOnMemory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: {} });
    await app.stop();
    expect(logs).toContain(
      'Warning: no GitHub App (github.app_id and github.private_key in factory.yml, or GH_APP_ID and GH_APP_KEY): the factory reads no PR, publishes nothing and merges nothing.',
    );
    expect(logs.some((m) => m.includes('gh CLI'))).toBe(false);
  });

  it('purges the transcripts older than 30 days at start', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4186, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    const dir = join(home, 'transcripts');
    mkdirSync(dir, { recursive: true });
    const old = join(dir, 'r-old.jsonl');
    const recent = join(dir, 'r-recent.jsonl');
    for (const f of [old, recent]) writeFileSync(f, '{}\n');
    const t = (Date.now() - 31 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(old, t, t);
    const logs: string[] = [];
    const app = await startOnMemory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: {} });
    await app.stop();
    expect([existsSync(old), existsSync(recent)]).toEqual([false, true]);
    expect(logs).toContain('transcripts: 1 deleted after 30 days');
  });

  it('closes the store it opened when the start fails afterwards', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4185, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    const recover = vi.spyOn(Daemon.prototype, 'recover').mockRejectedValue(new Error('boom'));
    const close = vi.spyOn(MemoryStore.prototype, 'close');
    try {
      await expect(startOnMemory({ home, fakeRunner: true, log: () => {}, env: {} })).rejects.toThrow('boom');
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      recover.mockRestore();
      close.mockRestore();
    }
  });

  it('stops the server and the timers it started when the start fails after them', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4184, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    const worker = vi.spyOn(Daemon.prototype, 'startWorker').mockImplementation(() => {
      throw new Error('boom');
    });
    const timersStop = vi.spyOn(TimerService.prototype, 'stop');
    const close = vi.spyOn(MemoryStore.prototype, 'close');
    try {
      await expect(startOnMemory({ home, fakeRunner: true, log: () => {}, env: {} })).rejects.toThrow('boom');
      expect(timersStop).toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      worker.mockRestore();
      timersStop.mockRestore();
      close.mockRestore();
    }
    // The port is free again: a second start listens on it.
    const app = await startOnMemory({ home, fakeRunner: true, log: () => {}, env: {} });
    expect((await fetch('http://127.0.0.1:4184/api/state')).status).toBe(200);
    await app.stop();
  });

  it('ticks the daemon every minute until stopped', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4198, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    const tick = vi.spyOn(Daemon.prototype, 'tick').mockResolvedValue();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const app = await startOnMemory({ home, fakeRunner: true, log: () => {} });
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
    saveInstance(home, { port: 4197, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    const app = await startOnMemory({ home, fakeRunner: true, log: () => {} });
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
    saveInstance(home, { port, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    if (webhookSecret !== undefined) storeLinear(home, { clientId: 'cid', clientSecret: 'cs', webhookSecret });
    const logs: string[] = [];
    const app = await startOnMemory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: KEY_ENV });
    await app.stop();
    expect(logs.some((m) => m.includes('webhook secret') && m.includes('refused'))).toBe(warns);
  });

  it('warns at startup of each project whose spec gate no validator can pass: none designated, or a lone one (ORC-421)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    const repo = () => mkdtempSync(join(tmpdir(), 'factory-repo-'));
    const authz = (validators: string[]) => ({ maintainers: [], validators, githubLogins: {} });
    const projects = [
      { id: 'none', repoPath: repo(), linearTeamKey: 'AAA' },
      { id: 'lone', repoPath: repo(), linearTeamKey: 'BBB', authz: authz(['u-1']) },
      { id: 'two', repoPath: repo(), linearTeamKey: 'CCC', authz: authz(['u-1', 'u-2']) },
      // The replay of closed tickets approves its own specs.
      { id: 'ghost', repoPath: repo(), linearTeamKey: 'DDD', preset: 'factory/fantome' as const },
    ];
    saveInstance(home, { port: 4172, host: '127.0.0.1', relay: { kind: 'none' }, projects });
    const logs: string[] = [];
    const app = await startOnMemory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: {} });
    await app.stop();
    const warned = logs.filter((m) => m.includes('authz.validators'));
    expect(warned).toEqual(validatorWarnings(projects));
    expect(warned.map((m) => m.split(':')[1]!.trim())).toEqual(['none', 'lone']);
  });

  // ORC-444: Smee is the workstation's relay, started only in the development mode `factory init --dev` writes.
  describe('the Smee relay outside the development mode', () => {
    // A channel nobody answers: the relay only logs its retries.
    const smee = { kind: 'smee' as const, url: 'http://127.0.0.1:9/channel' };
    const startWith = async (dev: boolean | undefined) => {
      const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
      saveInstance(home, { port: 4171, host: '127.0.0.1', relay: smee, projects: [], ...(dev === undefined ? {} : { dev }) });
      const logs: string[] = [];
      const app = await startOnMemory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: {} });
      try {
        // The relay runs: its channel refuses it, and it says so.
        await vi.waitFor(() => expect(logs).toContain('relay: connection error, retrying'));
      } finally {
        await app.stop();
      }
      return logs;
    };

    it('refuses to start, naming public_url and factory init --dev', async () => {
      await expect(startWith(false)).rejects.toThrow(/relay: \{ kind: smee \}.*public_url.*factory init --dev/);
    });

    it('starts with the relay of a config written by factory init --dev', async () => {
      expect((await startWith(true)).filter((m) => m.includes('smee'))).toEqual([]);
    });

    it('starts a config written before the marker, warning of the refusal to come', async () => {
      expect((await startWith(undefined)).filter((m) => m.includes('smee'))).toEqual([expect.stringMatching(/^Warning: relay: \{ kind: smee \}.*dev: true.*factory init --dev/)]);
    });
  });

  describe('the statuses a connected team lacks, at start (ORC-457)', () => {
    const tracker = (team: string[], fail?: Error) => {
      const created: string[][] = [];
      return {
        created,
        teamStatuses: async () => team,
        ensureSetup: async (_key: string, states: Record<string, string | undefined>) => {
          if (fail) throw fail;
          const made = Object.values(states).filter((n): n is string => !!n && !team.includes(n));
          created.push(made);
          return made;
        },
      };
    };
    const project = { id: 'p', teamKey: 'REL', workflow: defaultWorkflow() };
    const ORC_170 = ['Todo', 'In Progress', 'AI Review', 'Human Review', 'Done'];

    it('creates « Spec » on a team connected before it was a default, as « Connect Linear » would, and says so', async () => {
      const t = tracker(ORC_170);
      const logs: string[] = [];
      await createMissingStatuses(t, [project], (l) => logs.push(l));
      expect(t.created).toEqual([['Spec']]);
      expect(logs).toEqual(['Linear REL: created Spec']);
    });

    it('writes nothing to a team that has them all, nor to one whose spec status is off', async () => {
      const t = tracker([...ORC_170, 'Spec']);
      await createMissingStatuses(t, [project], () => {});
      const off = tracker(ORC_170);
      await createMissingStatuses(off, [{ ...project, workflow: defaultWorkflow({ statuses: { spec_draft: 'off' } }) }], () => {});
      expect([...t.created, ...off.created]).toEqual([]);
    });

    it('a creation Linear refuses keeps the warning: a move to that status will fail', async () => {
      const logs: string[] = [];
      await createMissingStatuses(tracker(ORC_170, new Error('Linear answered 403')), [project], (l) => logs.push(l));
      expect(logs).toEqual(['Linear REL: « Spec » not created: Linear answered 403', expect.stringMatching(/^Warning: p: the Linear team REL has no status « Spec »/)]);
    });

    it('creates only « Spec », nor any label: another status the team lacks (a typo, one deleted on purpose) is warned of, as before', async () => {
      const t = tracker(['Todo', 'In Progress', 'Human Review', 'Done']);
      const logs: string[] = [];
      await createMissingStatuses(t, [project], (l) => logs.push(l));
      expect(t.created).toEqual([['Spec']]);
      expect(logs).toEqual(['Linear REL: created Spec', expect.stringMatching(/^Warning: p: the Linear team REL has no status « AI Review »,/)]);
    });
  });

  it('TrackerSwitch explains how to connect', async () => {
    await expect(new TrackerSwitch(4100).getIssue('REL-1')).rejects.toThrow('Linear not connected: open http://localhost:4100/oauth/start');
  });

  // ORC-399: off the loopback, the dashboard is reached through a GitHub sign-in alone; the shared password is gone.
  it("refuses a non-loopback host without the GitHub sign-in: the App's OAuth client, who is let in, an HTTPS public_url", async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    const client = { GH_APP_CLIENT_ID: 'Iv1.client', GH_APP_CLIENT_SECRET: 'client-secret' };
    const start = (env: NodeJS.ProcessEnv) => startOnMemory({ home, fakeRunner: true, log: () => {}, env });
    saveInstance(home, { port: 4196, host: '0.0.0.0', publicUrl: 'https://factory.example', relay: { kind: 'none' }, projects: [] });
    // The old password opens nothing any more.
    await expect(start({ FACTORY_UI_PASSWORD: 'pw' })).rejects.toThrow(/GitHub sign-in.*github\.client_id.*GH_APP_CLIENT_ID/);
    await expect(start(client)).rejects.toThrow(/dashboard: \{ logins, org, team \}/);
    appendFileSync(join(home, 'factory.yml'), 'dashboard: { logins: [armand] }\n');
    saveInstance(home, { port: 4196, host: '0.0.0.0', publicUrl: 'http://factory.example', relay: { kind: 'none' }, projects: [] });
    await expect(start(client)).rejects.toThrow(/public_url.*https/);
  });

  // ORC-470: on the loopback too, as soon as Linear is there: a linear section of factory.yml, or a secrets.json, sealed or not.
  it('refuses on the loopback without secrets_key beside Linear, before writing anything, and starts once it is set', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4171, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    const refusal = `${LINEAR_NEEDS_SECRETS_KEY}.`;
    const plain = JSON.stringify({ linear: { clientId: 'cid', clientSecret: 'canary-client-secret-470', webhookSecret: 'canary-webhook-secret-470' } });
    writeFileSync(join(home, 'secrets.json'), plain);
    await expect(startOnMemory({ home, fakeRunner: true, log: () => {}, env: {} })).rejects.toThrow(refusal);
    expect(readFileSync(join(home, 'secrets.json'), 'utf8')).toBe(plain);
    rmSync(join(home, 'secrets.json'));
    appendFileSync(join(home, 'factory.yml'), 'linear: { app_client_id: cid, client_secret: env:LINEAR_CLIENT_SECRET, webhook_secret: env:LINEAR_WEBHOOK_SECRET }\n');
    const env = { LINEAR_CLIENT_SECRET: 'canary-client-secret-470', LINEAR_WEBHOOK_SECRET: 'canary-webhook-secret-470' };
    await expect(startOnMemory({ home, fakeRunner: true, log: () => {}, env })).rejects.toThrow(refusal);
    expect(existsSync(join(home, 'secrets.json'))).toBe(false);
    // Set, the start goes on: Connect Linear writes its tokens sealed.
    storeLinear(home, { clientId: 'cid', clientSecret: '', webhookSecret: '' });
    const app = await startOnMemory({ home, fakeRunner: true, log: () => {}, env: { ...env, ...KEY_ENV } });
    await app.stop();
  });

  // ORC-398: exposed, secrets.json must be encrypted at rest; without Linear on the loopback, secrets_key stays optional.
  it('refuses a non-loopback host without secrets_key, naming it; starts on the loopback without it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    const env = { GH_APP_CLIENT_ID: 'Iv1.client', GH_APP_CLIENT_SECRET: 'client-secret' };
    appendFileSync(join(home, 'factory.yml'), 'dashboard: { logins: [armand] }\n');
    saveInstance(home, { port: 4197, host: '0.0.0.0', publicUrl: 'https://factory.example', relay: { kind: 'none' }, projects: [] });
    await expect(startOnMemory({ home, fakeRunner: true, log: () => {}, env })).rejects.toThrow(/outside this machine.*: set secrets_key in factory\.yml/);
    saveInstance(home, { port: 4197, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    const app = await startOnMemory({ home, fakeRunner: true, log: () => {}, env });
    await app.stop();
  });

  it('refuses to start real runs without a container engine, FACTORY_ALLOW_HOST_RUNS=1 or not (ORC-349, ORC-179)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4194, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    for (const env of [{}, { FACTORY_ALLOW_HOST_RUNS: '1' }, { FACTORY_ALLOW_HOST_RUNS: '1', FACTORY_ALLOW_HOST_VERIFY: '1' }]) {
      await expect(startOnMemory({ home, log: () => {}, env })).rejects.toThrow(/^FACTORY_CONTAINER_CLI is not set: the agents run only in a rootless container/);
    }
  });

  it('launches no run on a configuration that would block every ticket, and says why on /health (ORC-350)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4176, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    const logs: string[] = [];
    // No GitHub App: every verified ticket would be blocked. The engine is named, never asked for a run here.
    const app = await startOnMemory({ home, log: (m) => void logs.push(m), env: { FACTORY_CONTAINER_CLI: 'podman', FACTORY_RUNNER_IMAGE: 'factory-runner:test' } });
    try {
      const res = await fetch('http://127.0.0.1:4176/health');
      expect(res.status).toBe(503);
      // The state alone (ORC-405): the reasons are the start's log, and each ticket's diagnosis'.
      expect(await res.json()).toEqual({ ok: false, store: 'ok', takingTickets: false });
      // No budget in factory.yml: refused as `factory validate` refuses it.
      expect(logs.some((l) => /factory\.yml: budgets\.per_step_tokens\./.test(l))).toBe(true);
      expect(logs).toContain('Invalid configuration, no run is launched until it is fixed and the factory restarted: publication impossible: it needs the sandboxes and the GitHub App');
    } finally {
      await app.stop();
    }
  });

  it('serves /health while it takes tickets (ORC-350)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    saveInstance(home, { port: 4175, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    const app = await startOnMemory({ home, fakeRunner: true, log: () => {}, env: {} });
    try {
      const res = await fetch('http://127.0.0.1:4175/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, store: 'ok', takingTickets: true });
    } finally {
      await app.stop();
    }
  });

  it("guards the dashboard with the GitHub sign-in of the factory's App on a non-loopback host", async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-'));
    // Written with its trailing slash: the callback URL is the one the App declares all the same.
    saveInstance(home, { port: 4195, host: '0.0.0.0', publicUrl: 'https://factory.example/', relay: { kind: 'none' }, projects: [] });
    // secrets_key required off the loopback (ORC-398).
    appendFileSync(join(home, 'factory.yml'), 'dashboard: { logins: [armand] }\nsecrets_key: env:FACTORY_SECRETS_KEY\n');
    const env = { GH_APP_CLIENT_ID: 'Iv1.client', GH_APP_CLIENT_SECRET: 'client-secret', FACTORY_UI_PASSWORD: 'pw', FACTORY_SECRETS_KEY: 'k'.repeat(44) };
    const app = await startOnMemory({ home, fakeRunner: true, log: () => {}, env });
    try {
      expect((await fetch('http://127.0.0.1:4195/api/state')).status).toBe(401);
      // No password opens it any more.
      const auth = { authorization: `Basic ${Buffer.from('x:pw').toString('base64')}` };
      expect((await fetch('http://127.0.0.1:4195/api/state', { headers: auth })).status).toBe(401);
      // The diagnosis too (ORC-350): what blocks a ticket is the operators'. The health check is open, the state alone (ORC-405).
      expect((await fetch('http://127.0.0.1:4195/tickets/REL-1/diagnosis')).status).toBe(401);
      expect(await (await fetch('http://127.0.0.1:4195/health')).json()).toEqual({ ok: true, store: 'ok', takingTickets: true });
      // On the server, the CLI goes through the socket in FACTORY_HOME, the factory user's alone (ORC-405): no GitHub sign-in.
      if (process.platform !== 'win32') {
        const socket = join(home, 'cli', 'factory.sock');
        expect(statSync(socket).mode & 0o777).toBe(0o600);
        expect(statSync(join(home, 'cli')).mode & 0o777).toBe(0o700);
        const lines: string[] = [];
        const cli = { api: 'http://127.0.0.1:4195', socket, out: (l: string) => void lines.push(l) };
        expect(await runStatusCommand(cli)).toBe(0);
        expect(lines[0]).toBe('Linear: not connected · queue: 0 waiting');
      }
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
      saveInstance(home, { port, host: '127.0.0.1', relay, projects: [] });
      storeLinear(home, { clientId: 'cid', clientSecret: 'cs', webhookSecret: 'linear-secret' });
      return startOnMemory({ home, fakeRunner: true, log: o.log ?? (() => {}), env: { ...KEY_ENV, ...o.env } });
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
