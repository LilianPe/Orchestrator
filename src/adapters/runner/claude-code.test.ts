import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeAgentRuntimeContract, drain, type AgentScript } from '../../../test/contracts/agent-runtime.contract.js';
import { ContainerSandboxProvider } from '../sandbox/docker-rootless.js';
import { FakeSandboxProvider } from '../sandbox/fake.js';
import type { SandboxProvider } from '../sandbox/types.js';
import { buildClaudeArgs, childEnv, ClaudeCodeRunner, liveDir } from './claude-code.js';
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

/**
 * The provider's real command without its engine: the same carriers and the same `sh`, run here. The command
 * stands for `claude`, which gives its env to its hooks: it asks the pack's hook about each file and writes the answers.
 */
class NoEngine extends ContainerSandboxProvider {
  override spawnCommand(...args: Parameters<ContainerSandboxProvider['spawnCommand']>) {
    const { command, env } = super.spawnCommand(...args);
    return { command: command.slice(command.indexOf(args[0]) + 1), env };
  }
}
const ASKS_THE_HOOK = `
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const denied = (file_path) => spawnSync(process.execPath, [process.env.PROBE_HOOK], { input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path } }), encoding: 'utf8' }).stdout.includes('"deny"');
const { PROBE_OUT, PROBE_BIG, PROBE_FROZEN } = process.env;
const carriers = Object.keys(process.env).filter((k) => k.startsWith('FACTORY_SANDBOX_ENV_'));
writeFileSync(PROBE_OUT, JSON.stringify({ big: denied(PROBE_BIG), frozen: denied(PROBE_FROZEN), carriers }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 1, result: 'ok' }));
`;

describe('the settings of the read guard, through the allowlist of a sandbox (ORC-279)', () => {
  // A path with a space and an accent: the list goes through the carrier and the `sh` as JSON.
  async function probe(run: (frozen: string) => Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'factory dé-'));
    const [big, frozen, script, out] = ['big.ts', 'frozen.test.ts', 'probe.mjs', 'out.json'].map((n) => join(dir, n)) as [string, string, string, string];
    writeFileSync(big, 'x\n'.repeat(200));
    writeFileSync(frozen, 'x\n'.repeat(200));
    writeFileSync(script, ASKS_THE_HOOK);
    const exec = async (_cmd: string, args: string[]) => ({ stdout: args[0] === 'run' ? 'c1\n' : '', stderr: '', code: 0 });
    const sandboxes = new NoEngine({ cli: 'docker', image: 'factory-runner:1', uid: 1000, gid: 1000, exec });
    await sandboxes.create({ runId: 'r', ticketId: 'ORC-1', workspacePath: '/w', network: 'none', requirements: { minLevel: 'L3', browser: false, services: [] }, mounts: [] });
    const r = new ClaudeCodeRunner({ transcriptsDir: mkdtempSync(join(tmpdir(), 'factory-tr-')), command: [process.execPath, script], sandboxes });
    const env = { PROBE_HOOK: join(import.meta.dirname, '../../../packs/standard/hooks/pre-tool-use.mjs'), PROBE_OUT: out, PROBE_BIG: big, PROBE_FROZEN: frozen, FACTORY_REFUSALS_LOG: join(dir, 'refusals.jsonl'), FACTORY_TICKET: 'ORC-1', ...run(frozen) };
    expect(await r.start(req({ sandboxId: 'c1', cwd: '/work' }, env)).done).toMatchObject({ outcome: 'success' });
    return JSON.parse(readFileSync(out, 'utf8')) as { big: boolean; frozen: boolean; carriers: string[] };
  }

  it('reach the hook in the container under their own names', async () => {
    // A threshold under the 200 lines of the files: only the run's variable can make the hook refuse.
    const seen = await probe((frozen) => ({ FACTORY_READ_MAX_LINES: '100', FACTORY_FULL_READ_PATHS: JSON.stringify([frozen]) }));
    expect(seen).toEqual({ big: true, frozen: false, carriers: [] });
  });

  it('are what changes the answer: without them, the 350 of the hook lets both through', async () => {
    expect(await probe(() => ({}))).toEqual({ big: false, frozen: false, carriers: [] });
  });

  it('never come from the daemon: its own FACTORY_* stay out of the container', async () => {
    vi.stubEnv('FACTORY_READ_MAX_LINES', '100');
    expect(await probe(() => ({}))).toEqual({ big: false, frozen: false, carriers: [] });
  });
});

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

/** ORC-220: the attempt's writer outlives the daemon that started it, which `start-and-die.ts` is, killed for real. */
describe('ClaudeCodeRunner attached to an attempt of a dead daemon', () => {
  const gated = (transcriptsDir: string) => ({ FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl'), FAKE_CLAUDE_GATE: join(transcriptsDir, 'gate') });
  const orphan = (transcriptsDir: string, runId: string, env: Record<string, string>) => {
    const died = spawnSync(process.execPath, ['--import', 'tsx', fx('start-and-die.ts'), transcriptsDir, runId, fx('fake-claude.mjs'), JSON.stringify(env)], { stdio: 'ignore' });
    expect(died.status === 0).toBe(false);
  };
  const attach = { limits: { turns: 50, durationMs: 60_000, usd: 5 }, elapsedMs: 0, env: {} };
  const writerDead = async (transcriptsDir: string, runId: string) => {
    const pid = Number(readFileSync(join(liveDir(transcriptsDir), runId, 'pid'), 'utf8').split(' ')[0]);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000 });
  };

  it('follows it from now on: only the new events, the real result, a whole transcript, once', { timeout: 30_000 }, async () => {
    const { r, transcriptsDir } = runner();
    orphan(transcriptsDir, 'r-alive', gated(transcriptsDir));
    await vi.waitFor(() => expect(readFileSync(join(liveDir(transcriptsDir), 'r-alive', 'stream'), 'utf8').trim().split('\n')).toHaveLength(4), { timeout: 5_000 });
    const h = r.attach({ ...attach, runId: 'r-alive' })!;
    expect(h).toBeDefined();
    writeFileSync(join(transcriptsDir, 'gate'), '');
    const events = await drain(h.events);
    // The lines before the kill were relayed by the dead daemon, or are lost to the relay: never twice.
    expect(events.map((e) => e.kind)).toEqual(['result']);
    expect(await h.done).toEqual({ outcome: 'success', costUsd: 0.42, turns: 3, lastText: 'PR ouverte.', tokens: { input: 20, output: 400, cacheRead: 9000, cacheCreation: 1000 } });
    expect(readFileSync(join(transcriptsDir, 'r-alive.jsonl'), 'utf8').trim().split('\n')).toHaveLength(5);
    expect(existsSync(join(liveDir(transcriptsDir), 'r-alive'))).toBe(false);
  });

  it('takes the result of an attempt that ended while no daemon read it', { timeout: 30_000 }, async () => {
    const { r, transcriptsDir } = runner();
    orphan(transcriptsDir, 'r-ended', { FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl') });
    await writerDead(transcriptsDir, 'r-ended');
    const h = r.attach({ ...attach, runId: 'r-ended' })!;
    expect(await drain(h.events)).toEqual([]);
    expect(await h.done).toMatchObject({ outcome: 'success', lastText: 'PR ouverte.' });
  });

  it('a result line wins over a duration spent during the cut: the attempt ended in time, whoever read it late', { timeout: 30_000 }, async () => {
    const { r, transcriptsDir } = runner();
    orphan(transcriptsDir, 'r-late', { FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl') });
    await writerDead(transcriptsDir, 'r-late');
    expect(await r.attach({ ...attach, runId: 'r-late', elapsedMs: 3_600_000 })!.done).toMatchObject({ outcome: 'success' });
  });

  it('a pid another process took since is no writer: nothing to take up, nothing to signal', { timeout: 30_000 }, async () => {
    const { r, transcriptsDir } = runner();
    orphan(transcriptsDir, 'r-reused', { FAKE_CLAUDE_SCRIPT: fx('stream-usage-no-result.jsonl') });
    await writerDead(transcriptsDir, 'r-reused');
    // This test's own process, under a start that is not its own: the pid is alive, and not the writer's.
    writeFileSync(join(liveDir(transcriptsDir), 'r-reused', 'pid'), `${process.pid} not-its-start`);
    expect(r.attach({ ...attach, runId: 'r-reused' })).toBeUndefined();
  });

  it('has nothing to take up from a writer dead without a result, nor from a run it never saw', { timeout: 30_000 }, async () => {
    const { r, transcriptsDir } = runner();
    orphan(transcriptsDir, 'r-cut', { FAKE_CLAUDE_SCRIPT: fx('stream-usage-no-result.jsonl') });
    await writerDead(transcriptsDir, 'r-cut');
    expect(r.attach({ ...attach, runId: 'r-cut' })).toBeUndefined();
    expect(existsSync(join(liveDir(transcriptsDir), 'r-cut'))).toBe(false);
    expect(r.attach({ ...attach, runId: 'r-never' })).toBeUndefined();
  });

  it('stops it, and counts the duration already spent', { timeout: 30_000 }, async () => {
    const { r, transcriptsDir } = runner();
    const hanging = { FAKE_CLAUDE_SCRIPT: fx('stream-usage-no-result.jsonl'), FAKE_CLAUDE_HANG: '1' };
    orphan(transcriptsDir, 'r-stop', hanging);
    const stopped = r.attach({ ...attach, runId: 'r-stop' })!;
    stopped.stop();
    expect(await stopped.done).toMatchObject({ outcome: 'stopped' });
    orphan(transcriptsDir, 'r-over', hanging);
    expect(await r.attach({ ...attach, runId: 'r-over', elapsedMs: 60_000 })!.done).toMatchObject({ outcome: 'limit' });
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
    spawnCommand.mockImplementation((_, argv, o) => ({ command: argv.slice(2), env: o!.env! }));
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

  it('spawns the engine CLI with what the provider says, never with the env of the container (ORC-211)', async () => {
    vi.stubEnv('HOME', '/daemon-home');
    const { sandboxes, id, spawnCommand } = await sandbox();
    const { r, transcriptsDir } = runner(sandboxes);
    const dump = join(transcriptsDir, 'cli-env.json').replaceAll('\\', '/');
    spawnCommand.mockReturnValue({ command: [process.execPath, '-e', `require('fs').writeFileSync('${dump}', JSON.stringify(process.env))`], env: { FACTORY_SANDBOX_ENV_0: 'carried' } });
    await r.start(req({ sandboxId: id, cwd: '/work' }, { HOME: '/tmp/setup-home', DOCKER_HOST: 'tcp://evil:1', XDG_RUNTIME_DIR: '/moved' })).done;
    const env = JSON.parse(readFileSync(dump, 'utf8')) as Record<string, string>;
    expect(env['FACTORY_SANDBOX_ENV_0']).toBe('carried');
    expect(env['HOME']).toBe('/daemon-home');
    // Not absent: the CLI keeps the daemon's own, which a CI sets.
    expect(env['DOCKER_HOST']).not.toBe('tcp://evil:1');
    expect(env['XDG_RUNTIME_DIR']).not.toBe('/moved');
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

  it('gives no run on the host a GitHub token (ORC-125), and keeps ANTHROPIC_API_KEY until the host runs go (ORC-179)', () => {
    expect(childEnv({ GH_TOKEN: 'g', GH_HOST: 'h', ANTHROPIC_API_KEY: 'k', SSH_AUTH_SOCK: '/s' }, {})).toEqual({ ANTHROPIC_API_KEY: 'k', SSH_AUTH_SOCK: '/s' });
  });

  it('the chosen account replaces any other login of the daemon', () => {
    expect(childEnv({ HOME: '/h', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'old' }, {}, 'chosen')).toEqual({ HOME: '/h', CLAUDE_CODE_OAUTH_TOKEN: 'chosen' });
  });

  it('drops variables left over from the old prefix', () => {
    const env = childEnv({ HOME: '/h', RELAIS_UI_PASSWORD: 'pw', RELAIS_HOME: '/old' }, {}); // transition, à retirer (ORC-167)
    expect(env).toEqual({ HOME: '/h' });
  });
});
