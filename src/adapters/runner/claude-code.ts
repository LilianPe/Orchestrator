import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { addTokens, NO_TOKENS, type RunOutcome, type TokenUsage } from '../../core/types.js';
import { systemEnv } from '../exec.js';
import { Channel } from './channel.js';
import { parseStreamLine, parseUsage } from './stream-parser.js';
import { maskTranscriptLine, transcriptSecrets } from './transcript.js';
import type { SandboxProvider } from '../sandbox/types.js';
import type { AttachRequest, RunHandle, RunRequest, RunResult, Runner, RunStreamEvent } from './types.js';

export interface ClaudeRunnerOptions {
  transcriptsDir: string;
  command?: string[];
  killGraceMs?: number;
  /** Secrets held outside the environment (the daemon's secrets file), masked like the environment's. */
  secrets?: () => readonly string[];
  /** Where a run with a `sandboxId` executes (ORC-204); without it such a run is refused, never run on the host. */
  sandboxes?: SandboxProvider;
  /** The token of the chosen Claude account (`claude.active`, ORC-211); without one, the daemon's `CLAUDE_CODE_OAUTH_TOKEN`. */
  claudeToken?: () => string | undefined;
}

/** The one credential a sandboxed `claude` gets (ORC-211): no API key, no other account, no gateway. */
const CLAUDE_TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * The factory's MCP (`POST /agent/mcp`, ORC-288). Claude Code expands `${VAR}` in a `--mcp-config`'s
 * url and headers from its own env (checked on 2.1.316): the run token stays out of the command line,
 * which the host's process list shows. Both variables come with the run's env (`agentEnv`).
 */
const FACTORY_MCP = JSON.stringify({
  mcpServers: { factory: { type: 'http', url: '${FACTORY_API}/mcp', headers: { Authorization: 'Bearer ${FACTORY_RUN_TOKEN}' } } },
});

export function buildClaudeArgs(req: RunRequest): string[] {
  const args = [
    '-p', req.prompt,
    '--output-format', 'stream-json',
    '--verbose',
    req.resume ? '--resume' : '--session-id', req.claudeSessionId,
    '--model', req.model,
    '--plugin-dir', req.pluginDir,
    '--settings', req.settingsPath,
    // Nothing of the repository's: no settings, hooks, skills, CLAUDE.md, nor .mcp.json, nor the account's
    // claude.ai connectors (ORC-128, measured on 2.1.306). Only the factory's MCP is loaded (ORC-188).
    '--setting-sources', '',
    '--strict-mcp-config',
    '--mcp-config', FACTORY_MCP,
    '--max-budget-usd', String(req.limits.usd),
  ];
  if (req.readOnly) args.push('--permission-mode', 'plan');
  return args;
}

/** The engine's CLI (`docker exec`) runs on the host with the daemon's env, for its own use: nothing of it enters the container but what `carried` names. */
const DAEMON_ONLY = /^(LINEAR_|FACTORY_|RELAIS_)/; // RELAIS_ : transition, à retirer (ORC-167)

function engineEnv(base: NodeJS.ProcessEnv, carriers: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !DAEMON_ONLY.test(k)) env[k] = v;
  return { ...env, ...carriers };
}

/**
 * What a run on the host gets of the daemon's env beyond the system (ORC-211), for `claude`, `git` and `gh`
 * to work. Everything else stays in the daemon.
 * Transition: `GH_TOKEN` until the agents stop pushing (ORC-125), `ANTHROPIC_API_KEY` until the host runs go (ORC-179).
 */
const HOST_LOGIN = ['CLAUDE_CONFIG_DIR', CLAUDE_TOKEN, 'ANTHROPIC_API_KEY', 'GH_TOKEN', 'GH_HOST', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND'];

/** The env of a run on the host; `token`, the chosen account, replaces any other login. */
export function childEnv(base: NodeJS.ProcessEnv, run: Record<string, string>, token?: string): Record<string, string> {
  const env = systemEnv(base);
  for (const k of HOST_LOGIN) if (base[k] !== undefined) env[k] = base[k];
  if (token) {
    delete env['ANTHROPIC_API_KEY'];
    env[CLAUDE_TOKEN] = token;
  }
  return { ...env, ...run };
}

/**
 * Where the running attempts' raw output is kept (ORC-220), per run: `stream`, `stderr`, `pid`. A file, not a
 * pipe, so the process that writes it (`docker exec`, or `claude` on the host) outlives a killed daemon, and the
 * next one reads on. On the host only, out of any sandbox's reach: the agent can forge no result in it. Unmasked,
 * so the daemon's alone (0700), and removed with the attempt; what a crash leaves is purged at 30 days.
 */
export const liveDir = (transcriptsDir: string): string => join(transcriptsDir, 'live');

/** How often the stream file is read for what the attempt wrote since: the relay (SSE, Linear) needs no better. */
const POLL_MS = 250;

/** The process that writes an attempt's stream. */
interface Writer {
  pid: number;
  /** When the platform tells it (`startTime`). */
  start: string | undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Not ours to signal is still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** When the process started, as the kernel counts it: a pid taken by another process since has another. Linux only: elsewhere, unknown. */
function startTime(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop()!.split(' ')[19];
  } catch {
    return undefined;
  }
}

/** The pid file: `<pid> <start>`, the start when the platform tells it. */
function readWriter(file: string): Writer | undefined {
  if (!existsSync(file)) return undefined;
  const [pid, start] = readFileSync(file, 'utf8').split(' ');
  return { pid: Number(pid), start };
}

/** Alive, and still that process. */
function writerAlive(w: Writer): boolean {
  return pidAlive(w.pid) && (w.start === undefined || w.start === startTime(w.pid));
}

function hasResultLine(text: string): boolean {
  return text.split('\n').some((line) => parseStreamLine(line).some((e) => e.kind === 'result'));
}

/** What `follow` needs of an attempt, started now or by an earlier process. */
interface Followed {
  runId: string;
  limits: RunRequest['limits'];
  secrets: readonly string[];
  remainingMs: number;
  /** Set on a start: it tells its own end. Absent, the attempt is taken up: what it wrote so far counts, and was relayed or is lost to the relay. */
  child?: ChildProcess;
  /** Taken up: watched by its pid, absent when it ended already. */
  writer?: Writer;
}

export class ClaudeCodeRunner implements Runner {
  constructor(private o: ClaudeRunnerOptions) {
    mkdirSync(liveDir(o.transcriptsDir), { recursive: true, mode: 0o700 });
  }

  start(req: RunRequest): RunHandle {
    // Masked as read: the transcript, the stream events (SSE, Linear) and the final text never
    // hold a secret value the daemon or the run knows of.
    const secrets = transcriptSecrets({ ...process.env, ...req.env }, this.o.secrets?.());
    const chosen = this.o.claudeToken?.();
    let env = childEnv(process.env, req.env, chosen);
    let argv = [...(this.o.command ?? ['claude']), ...buildClaudeArgs(req)];
    let cwd = req.cwd;
    if (req.sandboxId !== undefined) {
      try {
        if (!this.o.sandboxes) throw new Error(`run ${req.runId} asks for sandbox ${req.sandboxId} but the runner has no sandbox provider`);
        // The allowlist of the runner (ORC-211): the run's variables and the account's token, nothing else.
        const token = chosen ?? process.env[CLAUDE_TOKEN];
        const { PATH: sandboxPath, ...run } = req.env;
        const named = { ...run, ...(token ? { [CLAUDE_TOKEN]: token } : {}) };
        // req.env.PATH is the sandbox's: the host's `docker` is found on the daemon's, the command in
        // the container gets it through `env` (no secret in it, so on the command line is fine).
        const inner = sandboxPath !== undefined ? ['env', `PATH=${sandboxPath}`, ...argv] : argv;
        // The host process (`docker exec`) gets what the provider says, never the container's env as it is.
        const spawned = this.o.sandboxes.spawnCommand(req.sandboxId, inner, { cwd: req.cwd, env: named });
        argv = spawned.command;
        env = engineEnv(process.env, spawned.env);
        cwd = process.cwd(); // req.cwd is a path in the sandbox
      } catch (e) {
        return failed(maskTranscriptLine(e instanceof Error ? e.message : String(e), secrets));
      }
    }
    const [cmd, ...args] = argv;
    const dir = this.dir(req.runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const out = openSync(join(dir, 'stream'), 'a', 0o600);
    const err = openSync(join(dir, 'stderr'), 'a', 0o600);
    let child: ChildProcess;
    try {
      child = spawn(cmd!, args, { cwd, env, stdio: ['ignore', out, err], detached: true });
    } finally {
      closeSync(out);
      closeSync(err);
    }
    if (child.pid !== undefined) writeFileSync(join(dir, 'pid'), [child.pid, startTime(child.pid)].filter((x) => x !== undefined).join(' '), { mode: 0o600 });
    return this.follow({ runId: req.runId, limits: req.limits, secrets, remainingMs: req.limits.durationMs, child });
  }

  /**
   * The attempt's writer still lives, or it ended with a result line while no daemon read it: followed
   * from there. Anything else left of it is dropped: its step starts again.
   */
  attach(req: AttachRequest): RunHandle | undefined {
    const dir = this.dir(req.runId);
    if (!existsSync(join(dir, 'stream'))) return undefined;
    const read = readWriter(join(dir, 'pid'));
    const writer = read && writerAlive(read) ? read : undefined;
    if (!writer && !hasResultLine(readFileSync(join(dir, 'stream'), 'utf8'))) {
      rmSync(dir, { recursive: true, force: true });
      return undefined;
    }
    const secrets = transcriptSecrets({ ...process.env, ...req.env }, this.o.secrets?.());
    return this.follow({ runId: req.runId, limits: req.limits, secrets, remainingMs: req.limits.durationMs - req.elapsedMs, ...(writer ? { writer } : {}) });
  }

  private dir(runId: string): string {
    return join(liveDir(this.o.transcriptsDir), runId);
  }

  private follow(a: Followed): RunHandle {
    const dir = this.dir(a.runId);
    const pid = a.child?.pid ?? a.writer?.pid;
    // Taken up, the whole stream is read again: the transcript is written anew from it.
    const transcript = createWriteStream(join(this.o.transcriptsDir, `${a.runId}.jsonl`), { flags: a.child ? 'a' : 'w' });
    const ch = new Channel<RunStreamEvent>();
    let assistantTurns = 0;
    let lastText = '';
    let transcriptError = '';
    let result: Extract<RunStreamEvent, { kind: 'result' }> | undefined;
    // Usage of each model message as it streams, by message id (its lines repeat it): the tokens of a
    // run that ends without a result line (stopped, capped, killed) are not lost (ORC-235).
    const usage = new Map<string, TokenUsage>();
    let stopped = false;
    let limited = false;

    // Sandboxed, this kills the `docker exec` client, not `claude` in the container: the orchestrator
    // destroys the sandbox at the end of the run, which ends it.
    const signal = (sig: NodeJS.Signals) => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          process.kill(pid, sig);
        } catch {
          // already gone
        }
      }
    };
    let killTimer: NodeJS.Timeout | undefined;
    const interrupt = () => {
      signal('SIGINT');
      killTimer ??= setTimeout(() => signal('SIGKILL'), this.o.killGraceMs ?? 10_000);
      killTimer.unref();
    };
    transcript.on('error', (e) => (transcriptError = `\n[transcript] ${e.message}`));
    const limit = () => {
      if (limited || stopped) return;
      limited = true;
      interrupt();
    };
    const timer = setTimeout(limit, Math.max(0, a.remainingMs));

    const onLine = (unmasked: string, relayed: boolean) => {
      try {
        const line = maskTranscriptLine(unmasked, a.secrets);
        transcript.write(line + '\n');
        const raw = JSON.parse(line) as { type?: string; subtype?: string; message?: { id?: unknown; usage?: unknown } };
        if (raw?.type === 'assistant' && ++assistantTurns > a.limits.turns) limit();
        const used = raw?.type === 'assistant' && typeof raw.message?.id === 'string' ? parseUsage(raw.message.usage) : undefined;
        if (used) usage.set(raw.message!.id as string, used);
        if (raw?.type === 'result' && typeof raw.subtype === 'string' && raw.subtype.includes('max')) limited = true;
        for (const ev of parseStreamLine(line)) {
          if (ev.kind === 'text' && ev.text.trim()) lastText = ev.text;
          if (ev.kind === 'result') result = ev;
          if (relayed) ch.push(ev);
        }
      } catch {
        // a malformed line must never escape the handler; it stays in the transcript only
      }
    };

    let position = 0;
    let partial = '';
    const decoder = new StringDecoder('utf8');
    const chunk = Buffer.alloc(64 * 1024);
    /** Whole lines written since the last read; the last line of the stream, unterminated, comes at the end. */
    const read = (relayed: boolean) => {
      let fd: number;
      try {
        fd = openSync(join(dir, 'stream'), 'r');
      } catch {
        return;
      }
      try {
        for (let n = readSync(fd, chunk, 0, chunk.length, position); n > 0; n = readSync(fd, chunk, 0, chunk.length, position)) {
          position += n;
          const lines = (partial + decoder.write(chunk.subarray(0, n))).split('\n');
          partial = lines.pop()!;
          for (const line of lines) if (line) onLine(line, relayed);
        }
      } finally {
        closeSync(fd);
      }
    };
    if (!a.child) read(false);
    // Ended with a result while no daemon read it: the time since, the cut's, is no overrun.
    if (!a.child && result && !a.writer) clearTimeout(timer);

    const done = new Promise<RunResult>((resolve) => {
      let finished = false;
      const finish = (spawnError?: Error) => {
        if (finished) return;
        finished = true;
        clearInterval(poll);
        clearTimeout(timer);
        clearTimeout(killTimer);
        read(true);
        if (partial) onLine(partial, true);
        ch.close();
        let stderr = transcriptError;
        try {
          stderr = (readFileSync(join(dir, 'stderr'), 'utf8') + transcriptError).slice(-10_000);
        } catch {
          // nothing written
        }
        rmSync(dir, { recursive: true, force: true });
        const outcome: RunOutcome = stopped ? 'stopped' : limited ? 'limit' : result && !result.isError ? 'success' : 'failure';
        // It becomes the run's lastText, stored and posted to Linear: the stream's text is masked
        // already, stderr and a spawn error are masked here.
        const text = result?.text || lastText || maskTranscriptLine(spawnError ? spawnError.message : stderr.trim().slice(-2000), a.secrets);
        const tokens = result?.tokens ?? (usage.size ? [...usage.values()].reduce(addTokens, NO_TOKENS) : undefined);
        transcript.end(() => resolve({ outcome, costUsd: result?.costUsd ?? 0, turns: result?.turns ?? assistantTurns, lastText: text, ...(tokens ? { tokens } : {}), ...(spawnError ? { infra: true as const } : {}) }));
      };
      const poll = setInterval(() => {
        read(true);
        // Not its parent: its end is seen by its pid, once what it wrote is read.
        if (!a.child && (!a.writer || !writerAlive(a.writer))) finish();
      }, POLL_MS);
      poll.unref();
      a.child?.on('error', (err) => finish(err));
      a.child?.on('close', () => finish());
    });

    return {
      events: ch,
      done,
      stop: () => {
        if (stopped) return;
        stopped = true;
        interrupt();
      },
    };
  }
}

/** A run refused before any spawn: no events, a failure carrying why. */
function failed(lastText: string): RunHandle {
  const ch = new Channel<RunStreamEvent>();
  ch.close();
  return { events: ch, done: Promise.resolve({ outcome: 'failure', costUsd: 0, turns: 0, lastText, infra: true }), stop: () => {} };
}
