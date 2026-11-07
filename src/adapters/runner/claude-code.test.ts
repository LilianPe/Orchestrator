import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeAgentRuntimeContract, drain, type AgentScript } from '../../../test/contracts/agent-runtime.contract.js';
import { ContainerSandboxProvider } from '../sandbox/docker-rootless.js';
import { FakeSandboxProvider } from '../sandbox/fake.js';
import type { SandboxProvider } from '../sandbox/types.js';
import { buildClaudeArgs, childEnv, ClaudeCodeRunner, liveDir, worktreeReader } from './claude-code.js';
import type { RunRequest } from './types.js';

const fx = (n: string) => join(import.meta.dirname, 'fixtures', n);

/** The worktree reads on the host that returned: `execCmd` as it is, counted once its answer came (ORC-325). */
const hostReads = vi.hoisted(() => ({ done: 0 }));
vi.mock('../exec.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../exec.js')>();
  return {
    ...real,
    execCmd: async (...args: Parameters<typeof real.execCmd>) => {
      const out = await real.execCmd(...args);
      if (args[1].some((a) => a.includes('git write-tree'))) hostReads.done++;
      return out;
    },
  };
});

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
  it('passes the effort of the step, and none for a job without one (ORC-136)', () => {
    const args = buildClaudeArgs(req({ effort: 'medium' }));
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'medium']);
    expect(buildClaudeArgs(req())).not.toContain('--effort');
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

describe('ClaudeCodeRunner: caps and stagnation of the build (ORC-136)', () => {
  const assistant = (id: string, usage = { input_tokens: 10, output_tokens: 10 }) => JSON.stringify({ type: 'assistant', message: { id, usage, content: [{ type: 'text', text: id }] } });
  const script = (...lines: string[]) => {
    const f = join(mkdtempSync(join(tmpdir(), 'factory-stream-')), 'stream.jsonl');
    writeFileSync(f, lines.join('\n') + '\n');
    return f;
  };
  const bashFails = (id: string, output = 'Exit code 1\nboom (12ms)') => [
    JSON.stringify({ type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: output }] } }),
  ];
  function gitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'factory-loop-'));
    const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });
    git('init', '-q');
    writeFileSync(join(dir, 'a.ts'), 'a\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    return dir;
  }
  const repeats = { repeats: 3 };
  /**
   * What a negative case must have seen before it says nothing happened: every line relayed, then `before`, then a stop.
   * A fixed timer passed a loaded machine before the lines were even read, and the case checked nothing (ORC-325).
   */
  const stopAfter = async (h: ReturnType<ClaudeCodeRunner['start']>, count: number, before: () => Promise<void> = async () => {}) => {
    let n = 0;
    for await (const _ of h.events) {
      if (++n !== count) continue;
      await before();
      h.stop();
    }
    expect(n).toBe(count);
    return h.done;
  };
  /** `count` reads returned, then a macrotask: the run's own promise chain after the last one has run out. */
  const reads = (done: () => number, count: number) => async () => {
    await vi.waitFor(() => expect(done()).toBe(count), { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 0));
  };
  /** The events of three failed `npm test`: a tool call and its result each. */
  const FAILURES_EVENTS = 6;

  it('counts a model message once, however many lines it streams on', async () => {
    const { r } = runner();
    const lines = ['m1', 'm1', 'm1', 'm2', 'm2'].map((id) => assistant(id));
    // The agent ends by itself once its lines are written, without a result line: no timer, no stop to hide a limit (ORC-325).
    const h = r.start(req({ limits: { turns: 2, durationMs: 10_000, usd: 5 } }, { FAKE_CLAUDE_SCRIPT: script(...lines) }));
    expect(await h.done).toMatchObject({ outcome: 'failure', turns: 2 });
  });

  it('stops past the cap of turns of the step', async () => {
    const { r } = runner();
    const lines = ['m1', 'm2', 'm3'].map((id) => assistant(id));
    const h = r.start(req({ limits: { turns: 2, durationMs: 10_000, usd: 5 } }, { FAKE_CLAUDE_SCRIPT: script(...lines), FAKE_CLAUDE_HANG: '1' }));
    expect(await h.done).toMatchObject({ outcome: 'limit' });
  });

  it('stops past the cap of tokens, cache reads left out', async () => {
    const { r } = runner();
    const cached = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1_000_000 };
    // Ends by itself, as above: a limit would show, where a stop would win over it.
    const under = r.start(req({ limits: { turns: 50, durationMs: 10_000, usd: 5, tokens: 100 } }, { FAKE_CLAUDE_SCRIPT: script(assistant('m1', cached)) }));
    expect(await under.done).toMatchObject({ outcome: 'failure' });
    const over = r.start(req({ limits: { turns: 50, durationMs: 10_000, usd: 5, tokens: 100 } }, { FAKE_CLAUDE_SCRIPT: script(assistant('m1', { input_tokens: 60, output_tokens: 60 })), FAKE_CLAUDE_HANG: '1' }));
    expect(await over.done).toMatchObject({ outcome: 'limit' });
  });

  it('stops at the third same failure on an unchanged worktree, and tells what it saw', async () => {
    const { r } = runner();
    const lines = [...bashFails('t1'), ...bashFails('t2', 'Exit code 1\nboom (99ms)'), ...bashFails('t3')];
    // Three real fingerprints of the worktree (git) before the third failure: under load they took past the default cap of
    // 10 s, which ended the run first (ORC-325); this test took 12.9 s then. The cap is no subject here: 30 s, half the unit
    // project's testTimeout (vitest.config.ts), so a missed loop still ends on the cap and the assertion says what is missing.
    const limits = { ...req().limits, durationMs: 30_000 };
    const h = r.start(req({ cwd: gitRepo(), stagnation: repeats, limits }, { FAKE_CLAUDE_SCRIPT: script(...lines), FAKE_CLAUDE_HANG: '1' }));
    expect(await h.done).toMatchObject({ outcome: 'limit', stagnation: { kind: 'loop', command: 'npm test', count: 3 } });
  });

  it('a worktree that changes between the failures is work, not a loop', async () => {
    // `tree` answers another content each time, as a worktree the agent edits.
    let n = 0;
    const edits = new FakeSandboxProvider();
    const { id } = await edits.create({ runId: 'r', ticketId: 'ORC-1', workspacePath: '/w', network: 'none', requirements: { minLevel: 'L3', browser: false, services: [] }, mounts: [] });
    vi.spyOn(edits, 'exec').mockImplementation(async () => ({ stdout: `tree-${n++}\n`, stderr: '', code: 0 }));
    const sandboxed = runner(edits).r;
    const lines = [...bashFails('t1'), ...bashFails('t2'), ...bashFails('t3')];
    const h = sandboxed.start(req({ sandboxId: id, cwd: '/work', stagnation: repeats }, { FAKE_CLAUDE_SCRIPT: script(...lines), FAKE_CLAUDE_HANG: '1' }));
    const ended = await stopAfter(h, FAILURES_EVENTS, reads(() => n, 3));
    expect(ended).toMatchObject({ outcome: 'stopped' });
    expect(ended).not.toHaveProperty('stagnation');
  });

  it('in a sandbox, reads the worktree in it: never on the host', async () => {
    const edits = new FakeSandboxProvider();
    const { id } = await edits.create({ runId: 'r', ticketId: 'ORC-1', workspacePath: '/w', network: 'none', requirements: { minLevel: 'L3', browser: false, services: [] }, mounts: [] });
    const exec = vi.spyOn(edits, 'exec').mockImplementation(async () => ({ stdout: 'same\n', stderr: '', code: 0 }));
    const lines = [...bashFails('t1'), ...bashFails('t2'), ...bashFails('t3')];
    const h = runner(edits).r.start(req({ sandboxId: id, cwd: '/work', stagnation: repeats }, { FAKE_CLAUDE_SCRIPT: script(...lines), FAKE_CLAUDE_HANG: '1' }));
    expect(await h.done).toMatchObject({ outcome: 'limit', stagnation: { kind: 'loop', tree: 'same' } });
    expect(exec.mock.calls[0]!.slice(0, 1)).toEqual([id]);
    expect(exec.mock.calls[0]![2]).toEqual({ cwd: '/work' });
  });

  it('tracks nothing without a fingerprint of the worktree, nor on a version without the bound', async () => {
    const { r } = runner();
    const lines = [...bashFails('t1'), ...bashFails('t2'), ...bashFails('t3')];
    const before = hostReads.done;
    const outside = r.start(req({ cwd: mkdtempSync(join(tmpdir(), 'factory-nogit-')), stagnation: repeats }, { FAKE_CLAUDE_SCRIPT: script(...lines), FAKE_CLAUDE_HANG: '1', GIT_CEILING_DIRECTORIES: tmpdir() }));
    expect(await stopAfter(outside, FAILURES_EVENTS, reads(() => hostReads.done - before, 3))).not.toHaveProperty('stagnation');
    // Without the bound, nothing is read: the lines all relayed, the count of reads has not moved.
    const older = r.start(req({ cwd: gitRepo() }, { FAKE_CLAUDE_SCRIPT: script(...lines), FAKE_CLAUDE_HANG: '1' }));
    expect(await stopAfter(older, FAILURES_EVENTS)).not.toHaveProperty('stagnation');
    expect(hostReads.done - before).toBe(3);
  });

  it('says once per run that the worktree cannot be read, masked, and the run ends as before', async () => {
    const { sandboxes, id } = await sandbox();
    const exec = vi.spyOn(sandboxes, 'exec').mockImplementation(async () => ({ stdout: '', stderr: "fatal: detected dubious ownership, token hunter2-secret-value\nthe content of a file\n", code: 128 }));
    const log = vi.fn();
    const r = new ClaudeCodeRunner({ transcriptsDir: mkdtempSync(join(tmpdir(), 'factory-tr-')), command: [process.execPath, fx('fake-claude.mjs')], killGraceMs: 500, sandboxes, log, secrets: () => ['hunter2-secret-value'] });
    const lines = [...bashFails('t1'), ...bashFails('t2'), ...bashFails('t3')];
    const run = async (runId: string) => {
      exec.mockClear();
      // A cap above the wait, both under the test's 60 s: the run must not end on its cap before its three reads (ORC-325).
      const h = r.start(req({ runId, sandboxId: id, cwd: '/work', stagnation: repeats, limits: { ...req().limits, durationMs: 40_000 } }, { FAKE_CLAUDE_SCRIPT: script(...lines), FAKE_CLAUDE_HANG: '1' }));
      await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(3), { timeout: 20_000 });
      h.stop();
      return h.done;
    };
    const ended = await run('r-unread');
    expect(ended).toMatchObject({ outcome: 'stopped' });
    expect(ended).not.toHaveProperty('stagnation');
    expect(log).toHaveBeenCalledOnce();
    const said = log.mock.calls[0]![0] as string;
    expect(said).toContain('r-unread');
    expect(said).toContain('code 128');
    expect(said).toContain('dubious ownership');
    expect(said).not.toContain('hunter2-secret-value');
    expect(said).not.toContain('the content of a file');
    await run('r-unread-2');
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]![0]).toContain('r-unread-2');
  });

  describe('worktreeReader', () => {
    const reader = (exec: SandboxProvider['exec']) => {
      const said: string[] = [];
      return { said, read: worktreeReader({ exec }, { runId: 'r1', sandboxId: 'c1', cwd: '/work' }, (m) => said.push(m)) };
    };

    it('gives the tree and says nothing when it reads', async () => {
      const { said, read } = reader(async () => ({ stdout: 'abc\n', stderr: 'a warning\n', code: 0 }));
      expect(await read()).toBe('abc');
      expect(said).toEqual([]);
    });

    it('a read that fails after one that worked is said too, and only once', async () => {
      const exec = vi.fn<SandboxProvider['exec']>(async () => ({ stdout: '', stderr: '', code: 124 }));
      exec.mockResolvedValueOnce({ stdout: 'abc\n', stderr: '', code: 0 });
      const { said, read } = reader(exec);
      expect(await read()).toBe('abc');
      expect(await read()).toBeUndefined();
      expect(await read()).toBeUndefined();
      expect(said).toHaveLength(1);
      expect(said[0]).toContain('code 124');
    });

    it('says it of an exit 0 with no tree, and of an engine that refuses the exec', async () => {
      const empty = reader(async () => ({ stdout: '\n', stderr: '', code: 0 }));
      expect(await empty.read()).toBeUndefined();
      expect(empty.said[0]).toContain('code 0');
      const refused = reader(async () => {
        throw new Error('container sandbox: no live container c1\nmore');
      });
      expect(await refused.read()).toBeUndefined();
      expect(refused.said[0]).toContain('no live container c1');
      expect(refused.said[0]).not.toContain('more');
    });

    it('keeps the line short: a log, not a dump', async () => {
      const { said, read } = reader(async () => ({ stdout: '', stderr: 'x'.repeat(5000), code: 1 }));
      await read();
      expect(said[0]!.length).toBeLessThan(500);
    });
  });

  it('stops an agent that writes nothing any more, and tells it was silent', async () => {
    const { r } = runner();
    const h = r.start(req({ stagnation: { silentMs: 400 } }, { FAKE_CLAUDE_SCRIPT: script(assistant('m1')), FAKE_CLAUDE_HANG: '1' }));
    expect(await h.done).toMatchObject({ outcome: 'limit', stagnation: { kind: 'silent', silentMs: 400 } });
  });

  it('an agent that keeps writing is not silent', async () => {
    const { r, transcriptsDir } = runner();
    const rq = req({ stagnation: { silentMs: 600 } }, { FAKE_CLAUDE_SCRIPT: script(assistant('m1')), FAKE_CLAUDE_HANG: '1' });
    const h = r.start(rq);
    // The stream file of the attempt written to, as the agent does: its date is the witness.
    const stream = join(liveDir(transcriptsDir), rq.runId, 'stream');
    const writing = setInterval(() => appendFileSync(stream, `${assistant('m1')}\n`), 100);
    setTimeout(() => {
      clearInterval(writing);
      h.stop();
    }, 1_500).unref();
    expect(await h.done).toMatchObject({ outcome: 'stopped' });
    expect(await h.done).not.toHaveProperty('stagnation');
  });

  it('a process that dies without a result line (its container killed) is the infrastructure, not the agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-killed-'));
    const killed = join(dir, 'killed.mjs');
    writeFileSync(killed, `console.log(${JSON.stringify(assistant('m1'))});\nsetTimeout(() => process.kill(process.pid, 'SIGKILL'), 50);\nsetInterval(() => {}, 1000);\n`);
    const r = new ClaudeCodeRunner({ transcriptsDir: mkdtempSync(join(tmpdir(), 'factory-tr-')), command: [process.execPath, killed] });
    expect(await r.start(req()).done).toMatchObject({ outcome: 'failure', infra: true });
  });

  it('a stop, or a cap, without a result line stays what it is', async () => {
    const { r } = runner();
    const stopped = r.start(req({}, { FAKE_CLAUDE_SCRIPT: script(assistant('m1')), FAKE_CLAUDE_HANG: '1' }));
    stopped.stop();
    expect(await stopped.done).not.toHaveProperty('infra');
    const capped = r.start(req({ limits: { turns: 50, durationMs: 200, usd: 5 } }, { FAKE_CLAUDE_SCRIPT: script(assistant('m1')), FAKE_CLAUDE_HANG: '1' }));
    const done = await capped.done;
    expect(done).toMatchObject({ outcome: 'limit' });
    expect(done).not.toHaveProperty('infra');
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

  it('follows it from now on: only the new events, the real result, a whole transcript, once', async () => {
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

  it('takes the result of an attempt that ended while no daemon read it', async () => {
    const { r, transcriptsDir } = runner();
    orphan(transcriptsDir, 'r-ended', { FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl') });
    await writerDead(transcriptsDir, 'r-ended');
    const h = r.attach({ ...attach, runId: 'r-ended' })!;
    expect(await drain(h.events)).toEqual([]);
    expect(await h.done).toMatchObject({ outcome: 'success', lastText: 'PR ouverte.' });
  });

  it('a result line wins over a duration spent during the cut: the attempt ended in time, whoever read it late', async () => {
    const { r, transcriptsDir } = runner();
    orphan(transcriptsDir, 'r-late', { FAKE_CLAUDE_SCRIPT: fx('stream-success.jsonl') });
    await writerDead(transcriptsDir, 'r-late');
    expect(await r.attach({ ...attach, runId: 'r-late', elapsedMs: 3_600_000 })!.done).toMatchObject({ outcome: 'success' });
  });

  it('a pid another process took since is no writer: nothing to take up, nothing to signal', async () => {
    const { r, transcriptsDir } = runner();
    orphan(transcriptsDir, 'r-reused', { FAKE_CLAUDE_SCRIPT: fx('stream-usage-no-result.jsonl') });
    await writerDead(transcriptsDir, 'r-reused');
    // This test's own process, under a start that is not its own: the pid is alive, and not the writer's.
    writeFileSync(join(liveDir(transcriptsDir), 'r-reused', 'pid'), `${process.pid} not-its-start`);
    expect(r.attach({ ...attach, runId: 'r-reused' })).toBeUndefined();
  });

  it('has nothing to take up from a writer dead without a result, nor from a run it never saw', async () => {
    const { r, transcriptsDir } = runner();
    orphan(transcriptsDir, 'r-cut', { FAKE_CLAUDE_SCRIPT: fx('stream-usage-no-result.jsonl') });
    await writerDead(transcriptsDir, 'r-cut');
    expect(r.attach({ ...attach, runId: 'r-cut' })).toBeUndefined();
    expect(existsSync(join(liveDir(transcriptsDir), 'r-cut'))).toBe(false);
    expect(r.attach({ ...attach, runId: 'r-never' })).toBeUndefined();
  });

  it('watches the silence of what it takes up (ORC-136)', async () => {
    const { r, transcriptsDir } = runner();
    orphan(transcriptsDir, 'r-silent', { FAKE_CLAUDE_SCRIPT: fx('stream-usage-no-result.jsonl'), FAKE_CLAUDE_HANG: '1' });
    expect(await r.attach({ ...attach, runId: 'r-silent', stagnation: { silentMs: 300 } })!.done).toMatchObject({ outcome: 'limit', stagnation: { kind: 'silent', silentMs: 300 } });
  });

  it('stops it, and counts the duration already spent', async () => {
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
