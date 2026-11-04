import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { addTokens, NO_TOKENS, type RunOutcome, type TokenUsage } from '../../core/types.js';
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
}

/** Daemon variables a sandboxed `claude` needs to authenticate; the rest of the host env stays out of the container. */
const SANDBOX_AUTH = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'];

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

/**
 * Variables the daemon sets for a run; every other FACTORY_* (and every LINEAR_*) stays in the daemon.
 * The old prefix is still filtered so a secret left in the daemon's shell never reaches a run.
 */
const DAEMON_ONLY = /^(LINEAR_|FACTORY_|RELAIS_)/; // RELAIS_ : transition, à retirer (ORC-167)

export function childEnv(base: NodeJS.ProcessEnv, run: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !DAEMON_ONLY.test(k)) env[k] = v;
  return { ...env, ...run };
}

/**
 * Where the running attempts' raw output is kept (ORC-220), per run: `stream`, `stderr`, `pid`. A file, not a
 * pipe, so the process that writes it (`docker exec`, or `claude` on the host) outlives a killed daemon, and the
 * next one reads on. On the host only, out of any sandbox's reach: the agent can forge no result in it. Unmasked,
 * so the daemon's alone (0700), and removed with the attempt; what a crash leaves is purged at 30 days.
 */
export const liveDir = (transcriptsDir: string): string => join(transcriptsDir, 'live');

/** How often the stream file is read for what the attempt wrote since. */
const POLL_MS = 50;

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
function readWriter(file: string): { pid: number; start: string | undefined } | undefined {
  if (!existsSync(file)) return undefined;
  const [pid, start] = readFileSync(file, 'utf8').split(' ');
  return { pid: Number(pid), start };
}

/** Alive, and still that process. */
function writerAlive(w: { pid: number; start: string | undefined }): boolean {
  return pidAlive(w.pid) && (w.start === undefined || w.start === startTime(w.pid));
}

function hasResultLine(text: string): boolean {
  return text.split('\n').some((line) => {
    try {
      return (JSON.parse(line) as { type?: string })?.type === 'result';
    } catch {
      return false;
    }
  });
}

/** What `follow` needs of an attempt, started now or by an earlier process. */
interface Followed {
  runId: string;
  limits: RunRequest['limits'];
  secrets: readonly string[];
  remainingMs: number;
  /** Set on a start: it tells its own end. Otherwise `writer` is watched. */
  child?: ChildProcess;
  writer?: { pid: number; start: string | undefined };
  /** Taken up: what the attempt wrote so far counts, and was relayed or is lost to the relay. */
  attached: boolean;
}

export class ClaudeCodeRunner implements Runner {
  constructor(private o: ClaudeRunnerOptions) {
    mkdirSync(liveDir(o.transcriptsDir), { recursive: true, mode: 0o700 });
  }

  start(req: RunRequest): RunHandle {
    // Masked as read: the transcript, the stream events (SSE, Linear) and the final text never
    // hold a secret value the daemon or the run knows of.
    const secrets = transcriptSecrets({ ...process.env, ...req.env }, this.o.secrets?.());
    let env = childEnv(process.env, req.env);
    let argv = [...(this.o.command ?? ['claude']), ...buildClaudeArgs(req)];
    let cwd = req.cwd;
    if (req.sandboxId !== undefined) {
      try {
        if (!this.o.sandboxes) throw new Error(`run ${req.runId} asks for sandbox ${req.sandboxId} but the runner has no sandbox provider`);
        const named = Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'PATH' && (k in req.env || SANDBOX_AUTH.includes(k))));
        // req.env.PATH is the sandbox's: the host's `docker` is found on the daemon's, the command in
        // the container gets it through `env` (no secret in it, so on the command line is fine).
        const inner = req.env['PATH'] !== undefined ? ['env', `PATH=${req.env['PATH']}`, ...argv] : argv;
        // The host process (`docker exec`) gets the values in its env; the command only names them.
        argv = this.o.sandboxes.spawnCommand(req.sandboxId, inner, { cwd: req.cwd, env: named });
        env = childEnv(process.env, named);
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
    return this.follow({ runId: req.runId, limits: req.limits, secrets, remainingMs: req.limits.durationMs, child, attached: false });
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
    return this.follow({ runId: req.runId, limits: req.limits, secrets, remainingMs: req.limits.durationMs - req.elapsedMs, ...(writer ? { writer } : {}), attached: true });
  }

  private dir(runId: string): string {
    return join(liveDir(this.o.transcriptsDir), runId);
  }

  private follow(a: Followed): RunHandle {
    const dir = this.dir(a.runId);
    const pid = a.child?.pid ?? a.writer?.pid;
    // Taken up, the whole stream is read again: the transcript is written anew from it.
    const transcript = createWriteStream(join(this.o.transcriptsDir, `${a.runId}.jsonl`), { flags: a.attached ? 'w' : 'a' });
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
    if (a.attached) read(false);
    // Ended with a result while no daemon read it: the time since, the cut's, is no overrun.
    if (a.attached && result && !a.writer) clearTimeout(timer);

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
