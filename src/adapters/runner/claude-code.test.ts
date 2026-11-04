import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeAgentRuntimeContract, drain, type AgentScript } from '../../../test/contracts/agent-runtime.contract.js';
import { FakeSandboxProvider } from '../sandbox/fake.js';
import type { SandboxProvider } from '../sandbox/types.js';
import { buildClaudeArgs, childEnv, ClaudeCodeRunner } from './claude-code.js';
import type { RunRequest } from './types.js';

const fx = (n: string) => join(import.meta.dirname, 'fixtures', n);

function req(patch: Partial<RunRequest> = {}, env: Record<string, string> = {}): RunRequest {
  return {
    runId: `r-${Math.random().toString(36).slice(2)}`, cwd: process.cwd(), prompt: '/factory:dev\n\n## Ticket', claudeSessionId: 'uuid-1', resume: false,
    model: 'sonnet', pluginDir: '/pack', settingsPath: '/pack/settings.json', readOnly: false,
    limits: { turns: 50, durationMs: 10_000, usd: 5 }, env, ...patch,
  };
}

function runner(sandboxes?: FakeSandboxProvider) {
  const transcriptsDir = mkdtempSync(join(tmpdir(), 'factory-tr-'));
  return {
    transcriptsDir,
    r: new ClaudeCodeRunner({ transcriptsDir, command: [process.execPath, fx('fake-claude.mjs')], killGraceMs: 500, ...(sandboxes ? { sandboxes } : {}) }),
  };
}

async function sandbox() {
  const sandboxes = new FakeSandboxProvider();
  const { id } = await sandboxes.create({ runId: 'r', ticketId: 'ORC-1', workspacePath: '/w', network: 'claude-api', requirements: { minLevel: 'L3', browser: false, services: [] }, mounts: [] });
  return { sandboxes, id, spawnCommand: vi.spyOn(sandboxes, 'spawnCommand') };
}

const scripts: Record<AgentScript, Partial<RunRequest>> = {
  success: { env: { FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl') } },
  failure: { env: { FAKE_CLAUDE_SCRIPT: fx('stream-error.jsonl') } },
  hang: { env: { FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl'), FAKE_CLAUDE_HANG: '1' } },
  chatty: { env: { FAKE_CLAUDE_SCRIPT: fx('stream-many-turns.jsonl'), FAKE_CLAUDE_HANG: '1' } },
  unlaunchable: { cwd: join(mkdtempSync(join(tmpdir(), 'factory-contract-')), 'missing') },
};

const shared = runner().r;
describeAgentRuntimeContract('ClaudeCodeRunner (fake claude CLI)', () => ({ runtime: shared, script: (name) => scripts[name] }));

describe('buildClaudeArgs', () => {
  it('starts a new session', () => {
    expect(buildClaudeArgs(req())).toEqual([
      '-p', '/factory:dev\n\n## Ticket', '--output-format', 'stream-json', '--verbose', '--session-id', 'uuid-1', '--model', 'sonnet',
      '--plugin-dir', '/pack', '--settings', '/pack/settings.json', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', expect.any(String), '--max-budget-usd', '5',
    ]);
  });
  it("loads the factory's MCP only, its token read from the run's env, never on the command line (ORC-288)", () => {
    const args = buildClaudeArgs(req({}, { FACTORY_RUN_TOKEN: 'tok-secret', FACTORY_API: 'http://127.0.0.1:4100/agent' }));
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]!)).toEqual({
      mcpServers: { factory: { type: 'http', url: '${FACTORY_API}/mcp', headers: { Authorization: 'Bearer ${FACTORY_RUN_TOKEN}' } } },
    });
    expect(args.join(' ')).not.toContain('tok-secret');
  });
  it('resumes read-only', () => {
    const args = buildClaudeArgs(req({ resume: true, readOnly: true }));
    expect(args.slice(5, 7)).toEqual(['--resume', 'uuid-1']);
    expect(args.slice(-2)).toEqual(['--permission-mode', 'plan']);
    expect(args).not.toContain('--bare');
  });
});

describe('ClaudeCodeRunner', () => {
  it('streams events, writes the transcript and succeeds', async () => {
    const { r, transcriptsDir } = runner();
    const argsFile = join(transcriptsDir, 'args.txt');
    const rq = req({}, { FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl'), FAKE_CLAUDE_ARGS: argsFile });
    const h = r.start(rq);
    const events = await drain(h.events);
    expect(events.map((e) => e.kind)).toEqual(['init', 'text', 'tool', 'tool_result', 'text', 'result']);
    expect(await h.done).toEqual({
      outcome: 'success', costUsd: 0.42, turns: 3, lastText: 'PR ouverte.', tokens: { input: 20, output: 400, cacheRead: 9000, cacheCreation: 1000 },
    });
    expect(readFileSync(join(transcriptsDir, `${rq.runId}.jsonl`), 'utf8').trim().split('\n')).toHaveLength(5);
    expect(JSON.parse(readFileSync(argsFile, 'utf8'))).toContain('--setting-sources');
  });

  it('keeps the usage of the streamed messages when a run ends without a result line (ORC-235)', async () => {
    const { r } = runner();
    const h = r.start(req({}, { FAKE_CLAUDE_SCRIPT: fx('stream-usage-no-result.jsonl'), FAKE_CLAUDE_HANG: '1' }));
    const events: string[] = [];
    for await (const e of h.events) {
      events.push(e.kind);
      if (events.length === 5) h.stop();
    }
    // msg_1 counted once, with its last usage line.
    expect(await h.done).toMatchObject({ outcome: 'stopped', tokens: { input: 30, output: 37, cacheRead: 3000, cacheCreation: 100 } });
  });

  it('reports failure on an error result', async () => {
    const { r } = runner();
    const h = r.start(req({}, { FAKE_CLAUDE_SCRIPT: fx('stream-error.jsonl') }));
    await drain(h.events);
    const done = await h.done;
    expect(done).toMatchObject({ outcome: 'failure', lastText: 'Je tente.' });
    // The agent's failure, not the runner's (ORC-289).
    expect(done).not.toHaveProperty('infra');
  });

  it('marks a spawn error as the infrastructure (ORC-289)', async () => {
    const { r } = runner();
    const h = r.start(req({ cwd: join(mkdtempSync(join(tmpdir(), 'factory-tr-')), 'missing') }));
    await drain(h.events);
    expect(await h.done).toMatchObject({ outcome: 'failure', infra: true });
  });
});

describe('ClaudeCodeRunner in a sandbox (ORC-204)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('names the token of the chosen account, whatever login the daemon holds', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'daemon-login');
    const { sandboxes, id, spawnCommand } = await sandbox();
    const transcriptsDir = mkdtempSync(join(tmpdir(), 'factory-tr-'));
    const r = new ClaudeCodeRunner({ transcriptsDir, command: [process.execPath, fx('fake-claude.mjs')], sandboxes, claudeToken: () => 'chosen-account' });
    await r.start(req({ sandboxId: id, cwd: '/work' }, { FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl') })).done;
    const [, , opts] = spawnCommand.mock.calls[0]! as Parameters<SandboxProvider['spawnCommand']>;
    expect(opts!.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'chosen-account' });
  });

  it('names no credential at all when there is none, and the API key never', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gateway');
    const { sandboxes, id, spawnCommand } = await sandbox();
    const { r } = runner(sandboxes);
    await r.start(req({ sandboxId: id, cwd: '/work' }, { FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl') })).done;
    const [, , opts] = spawnCommand.mock.calls[0]! as Parameters<SandboxProvider['spawnCommand']>;
    expect(opts!.env).toEqual({ FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl') });
  });

  it('runs claude through spawnCommand, naming the run env and the account token only', async () => {
    vi.stubEnv('SOME_DAEMON_VAR', 'leak');
    vi.stubEnv('GH_TOKEN', 'ghp_leak');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-test');
    const { sandboxes, id, spawnCommand } = await sandbox();
    const { r } = runner(sandboxes);
    const runEnv = { FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl'), FACTORY_RUN_TOKEN: 't' };
    // cwd is a sandbox path: the host spawn must not use it.
    const rq = req({ sandboxId: id, cwd: '/work' }, runEnv);
    const h = r.start(rq);
    expect((await drain(h.events)).map((e) => e.kind)).toEqual(['init', 'text', 'tool', 'tool_result', 'text', 'result']);
    expect(await h.done).toMatchObject({ outcome: 'success', lastText: 'PR ouverte.' });
    expect(spawnCommand).toHaveBeenCalledOnce();
    const [sid, argv, opts] = spawnCommand.mock.calls[0]! as Parameters<SandboxProvider['spawnCommand']>;
    expect(sid).toBe(id);
    expect(argv).toEqual([process.execPath, fx('fake-claude.mjs'), ...buildClaudeArgs(rq)]);
    expect(opts).toEqual({ cwd: '/work', env: { ...runEnv, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test' } });
  });

  it('spawns the engine CLI with the daemon PATH, and hands the sandbox PATH to the command in the container', async () => {
    vi.stubEnv('PATH', process.env['PATH'] + '-daemon');
    const { sandboxes, id, spawnCommand } = await sandbox();
    // The fake runs on the host: it drops the `env PATH=...` prefix a real engine runs in the container.
    spawnCommand.mockImplementation((_, argv) => argv.slice(2));
    const { r, transcriptsDir } = runner(sandboxes);
    const pathFile = join(transcriptsDir, 'path.txt');
    const runEnv = { FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl'), FAKE_CLAUDE_PATH: pathFile, PATH: '/factory/bin:/usr/bin' };
    const rq = req({ sandboxId: id, cwd: '/work' }, runEnv);
    expect(await r.start(rq).done).toMatchObject({ outcome: 'success' });
    const [, argv, opts] = spawnCommand.mock.calls[0]! as Parameters<SandboxProvider['spawnCommand']>;
    expect(argv).toEqual(['env', 'PATH=/factory/bin:/usr/bin', process.execPath, fx('fake-claude.mjs'), ...buildClaudeArgs(rq)]);
    expect(opts!.env).not.toHaveProperty('PATH');
    expect(readFileSync(pathFile, 'utf8')).toBe(process.env['PATH']);
  });

  it('refuses a sandboxed run without a sandbox provider, spawning nothing', async () => {
    const { r, transcriptsDir } = runner();
    const argsFile = join(transcriptsDir, 'args.txt');
    const h = r.start(req({ sandboxId: 'sbx-1' }, { FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl'), FAKE_CLAUDE_ARGS: argsFile }));
    expect(await drain(h.events)).toEqual([]);
    expect(await h.done).toMatchObject({ outcome: 'failure', lastText: expect.stringContaining('sandbox'), infra: true });
    expect(existsSync(argsFile)).toBe(false);
  });

  it('fails the run on an unknown sandbox', async () => {
    const { sandboxes } = await sandbox();
    const { r } = runner(sandboxes);
    const h = r.start(req({ sandboxId: 'sbx-404' }, { FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl') }));
    await drain(h.events);
    expect(await h.done).toMatchObject({ outcome: 'failure', lastText: expect.stringContaining('sbx-404'), infra: true });
  });
});

describe('childEnv: a run on the host (ORC-211)', () => {
  it('keeps the system, its login and the run variables, nothing else of the daemon', () => {
    const env = childEnv(
      {
        HOME: '/h', PATH: '/bin', LANG: 'fr_FR.UTF-8', LC_ALL: 'C', TMPDIR: '/t', GIT_AUTHOR_NAME: 'n',
        CLAUDE_CODE_OAUTH_TOKEN: 'c',
        AWS_SECRET_ACCESS_KEY: 'a', GITHUB_TOKEN: 'gt', NPM_TOKEN: 'n', DATABASE_URL: 'postgres://u:p@h/d', ANTHROPIC_BASE_URL: 'https://gateway', SOME_DAEMON_VAR: 'v',
        LINEAR_API_KEY: 'lin', LINEAR_TOKEN: 'x', FACTORY_HOME: '/data', FACTORY_UI_PASSWORD: 'pw', FACTORY_SECRET: 's',
      },
      { FACTORY_API: 'http://127.0.0.1:4100/agent', FACTORY_RUN_TOKEN: 't', FACTORY_TICKET: 'REL-1', FACTORY_KNOWLEDGE: '', FACTORY_ROOT: '/app', PATH: '/app/bin:/bin' },
    );
    expect(env).toEqual({
      HOME: '/h', PATH: '/app/bin:/bin', LANG: 'fr_FR.UTF-8', LC_ALL: 'C', TMPDIR: '/t', GIT_AUTHOR_NAME: 'n',
      CLAUDE_CODE_OAUTH_TOKEN: 'c',
      FACTORY_API: 'http://127.0.0.1:4100/agent', FACTORY_RUN_TOKEN: 't', FACTORY_TICKET: 'REL-1', FACTORY_KNOWLEDGE: '', FACTORY_ROOT: '/app',
    });
  });

  it('keeps GH_TOKEN and ANTHROPIC_API_KEY on the host until the agents stop pushing (ORC-125) and the host runs go (ORC-179)', () => {
    expect(childEnv({ GH_TOKEN: 'g', ANTHROPIC_API_KEY: 'k' }, {})).toEqual({ GH_TOKEN: 'g', ANTHROPIC_API_KEY: 'k' });
  });

  it('the chosen account replaces any other login of the daemon', () => {
    expect(childEnv({ HOME: '/h', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'old' }, {}, 'chosen')).toEqual({ HOME: '/h', CLAUDE_CODE_OAUTH_TOKEN: 'chosen' });
  });

  it('drops variables left over from the old prefix', () => {
    const env = childEnv({ HOME: '/h', RELAIS_UI_PASSWORD: 'pw', RELAIS_HOME: '/old' }, {}); // transition, à retirer (ORC-167)
    expect(env).toEqual({ HOME: '/h' });
  });
});
