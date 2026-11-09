import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { addTokens, NO_TOKENS, spentTokens, type OverBudget, type RunOutcome, type Stagnation, type TokenUsage } from '../../core/types.js';
import { execCmd, systemEnv } from '../exec.js';
import { Channel } from './channel.js';
import { failedCommand, LoopDetector, WORKTREE_TREE } from './stagnation.js';
import { parseStreamLine, parseUsage } from './stream-parser.js';
import { maskTranscriptLine, transcriptSecrets } from './transcript.js';
import type { SandboxProvider } from '../sandbox/types.js';
import type { AttachRequest, RunHandle, RunRequest, RunResult, Runner, RunStreamEvent, StagnationBounds } from './types.js';

export interface ClaudeRunnerOptions {
  transcriptsDir: string;
  command?: string[];
  killGraceMs?: number;
  /** Secrets held outside the environment (the daemon's secrets file), masked like the environment's. */
  secrets?: () => readonly string[];
  /** Where a run with a `sandboxId` executes (ORC-204); without it such a run is refused, never run on the host. */
  sandboxes?: SandboxProvider;
  /** The token of the chosen Claude account (`claude.active`, ORC-211): a run on the host logs in with it in place of the daemon's login. */
  claudeToken?: () => string | undefined;
  /**
   * Whether the egress proxy has a token to set on a sandboxed run's model calls (ORC-337), asked at each launch: with
   * one, the run gets a placeholder. Without the option, whether there is a chosen account, else the daemon's `CLAUDE_CODE_OAUTH_TOKEN`.
   */
  proxyHasToken?: () => boolean;
  /** The daemon's log. */
  log?: (message: string) => void;
}

/** How `claude` logs in (ORC-211): no API key, no other account, no gateway. */
const CLAUDE_TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * What a sandboxed `claude` gets in place of the account's token (ORC-337): it logs in by OAuth with it, and the
 * egress proxy swaps it for the real one on the way to the Claude API. Nothing of the account enters the sandbox.
 */
export const SANDBOX_CLAUDE_TOKEN = 'set-by-the-factory-egress-proxy';

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
    ...(req.effort ? ['--effort', req.effort] : []),
    '--plugin-dir', req.pluginDir,
    '--settings', req.settingsPath,
    // Nothing of the repository's: no settings, hooks, skills, CLAUDE.md, nor .mcp.json, nor the account's
    // claude.ai connectors (ORC-128, measured on 2.1.306). Only the factory's MCP is loaded (ORC-188).
    '--setting-sources', '',
    '--strict-mcp-config',
    '--mcp-config', FACTORY_MCP,
    // The only built-in tools the model is given (ORC-183): an AI review gets no write tool and no shell at all, whatever the settings allow.
    ...(req.tools ? ['--tools', req.tools.join(',')] : []),
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
 * What a run on the host gets of the daemon's env beyond the system (ORC-211), for `claude` and `git` to work.
 * Everything else stays in the daemon, `GH_TOKEN` among it: the factory publishes, and the agent has no token (ORC-125).
 * Transition: `ANTHROPIC_API_KEY` until the host runs go (ORC-179), and with them what `git fetch` reaches the forge by.
 */
const HOST_LOGIN = ['CLAUDE_CONFIG_DIR', CLAUDE_TOKEN, 'ANTHROPIC_API_KEY', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND'];

/**
 * A run on the host pushes nowhere (ORC-349): git rewrites every push URL, the ticket's remote or one the agent names, to
 * a transport it does not have, however the command names it. Fetches are left alone. A config, not a barrier: git skips
 * it for a remote with an explicit `pushurl`, and an agent under the daemon's user can undo it, as it can read the daemon's
 * secrets. The barrier is the sandbox.
 */
export const NO_PUSH = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.factory-no-push://.pushInsteadOf', GIT_CONFIG_VALUE_0: '' } as const;

/** The env of a run on the host; `token`, the chosen account, replaces any other login. */
export function childEnv(base: NodeJS.ProcessEnv, run: Record<string, string>, token?: string): Record<string, string> {
  const env: Record<string, string> = { ...systemEnv(base), ...NO_PUSH };
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

/**
 * Anthropic's list prices in dollars per million tokens, by model family: those of the models the pack runs (Claude Opus 5.5,
 * Sonnet 5.5, Haiku 5.5; price list of 2026-10). Cache reads are as listed, not a fixed share (Opus 5.5's are 5% of its input);
 * a cache write is 1.25 times the input. What a run cut before its result line cost (ORC-340): the CLI reports its cost on that line only.
 * ponytail: one generation's prices; update them with the price list. A model of no known family is priced as the dearest (Fable 5.1).
 */
const PRICES: [RegExp, { input: number; output: number; cacheRead: number }][] = [
  [/haiku/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  [/sonnet/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/opus/, { input: 4, output: 20, cacheRead: 0.2 }],
];
const DEAREST = { input: 10, output: 50, cacheRead: 0.25 };

/** An estimate of what `tokens` cost on `model`, for a run that ended without a result line to say it. */
export function estimateCostUsd(model: string | undefined, t: TokenUsage): number {
  const p = PRICES.find(([family]) => family.test(model ?? ''))?.[1] ?? DEAREST;
  return (t.input * p.input + t.cacheCreation * p.input * 1.25 + t.cacheRead * p.cacheRead + t.output * p.output) / 1_000_000;
}

const maxTokens = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: Math.max(a.input, b.input),
  output: Math.max(a.output, b.output),
  cacheRead: Math.max(a.cacheRead, b.cacheRead),
  cacheCreation: Math.max(a.cacheCreation, b.cacheCreation),
});

/** The CLI's result when the subscription's limit stops it, its reset in epoch seconds after the bar. Anchored: no other error text that names a limit. */
const USAGE_LIMIT_RESULT = /^Claude AI usage limit reached\|(\d{9,})$/;

/**
 * The subscription's usage limit (ORC-340), as the CLI says it: a `rate_limit_event` rejected, or the result `USAGE_LIMIT_RESULT`.
 * `resetAt` in ms, when it tells it. Undefined for any other line.
 */
function usageLimitOf(raw: { type?: string; is_error?: boolean; result?: unknown; rate_limit_info?: { status?: unknown; resetsAt?: unknown } }): RunResult['usageLimit'] {
  if (raw.type === 'rate_limit_event' && raw.rate_limit_info?.status === 'rejected') {
    const at = raw.rate_limit_info.resetsAt;
    return typeof at === 'number' ? { resetAt: at * 1000 } : {};
  }
  const at = raw.type === 'result' && raw.is_error && typeof raw.result === 'string' ? USAGE_LIMIT_RESULT.exec(raw.result.trim())?.[1] : undefined;
  return at ? { resetAt: Number(at) * 1000 } : undefined;
}

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
  /** Prices a run cut before its result line (`estimateCostUsd`). */
  model?: string | undefined;
  secrets: readonly string[];
  remainingMs: number;
  /** Set on a start: it tells its own end. Absent, the attempt is taken up: what it wrote so far counts, and was relayed or is lost to the relay. */
  child?: ChildProcess;
  /** Taken up: watched by its pid, absent when it ended already. */
  writer?: Writer;
  stagnation?: StagnationBounds | undefined;
  /** The content of the worktree, where the agent runs (`WORKTREE_TREE`); undefined when it cannot be read. Absent: no loop is tracked. */
  tree?: () => Promise<string | undefined>;
}

/** Seconds reading the worktree may take, for `timeout`, which kills it: past it, this failure is not counted. */
const TREE_TIMEOUT_S = 30;

/** What a warning takes of an stderr: its first line, cut. git names a path there, not what a file holds. */
const STDERR_LINE_MAX = 200;

/**
 * In the sandbox when the run has one: the host never runs git on a worktree the agent writes from there (ORC-203). Holds the fields it reads, not the request.
 * A read that fails only leaves that failure uncounted, and a detector that sees nothing looks like an agent that does not loop: `warn` says it, once per run.
 */
export function worktreeReader(sandboxes: Pick<SandboxProvider, 'exec'> | undefined, { runId, sandboxId, cwd }: Pick<RunRequest, 'runId' | 'sandboxId' | 'cwd'>, warn: (message: string) => void): () => Promise<string | undefined> {
  const argv = ['timeout', String(TREE_TIMEOUT_S), 'sh', '-c', WORKTREE_TREE];
  let warned = false;
  const unread = (code: number | undefined, stderr: string) => {
    if (warned) return;
    warned = true;
    warn(`Warning: run ${runId}: unreadable worktree (${code === undefined ? 'exec refused' : `code ${code}`}): ${stderr.split('\n')[0]!.trim().slice(0, STDERR_LINE_MAX)}. Its failures do not count for the loop detector.`);
  };
  return async () => {
    try {
      const read = await (sandboxId !== undefined ? sandboxes!.exec(sandboxId, argv, { cwd }) : execCmd(argv[0]!, argv.slice(1), { cwd }));
      const tree = read.code === 0 ? read.stdout.trim() : '';
      if (tree) return tree;
      unread(read.code, read.stderr);
    } catch (err) {
      unread(undefined, err instanceof Error ? err.message : String(err));
    }
    return undefined;
  };
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
        // The allowlist of the runner (ORC-211): the run's variables and a placeholder for the account's token, nothing else.
        // Without a token, none: `claude` says it is not logged in, clearer than the proxy's 401.
        const hasToken = this.o.proxyHasToken ? this.o.proxyHasToken() : !!(chosen ?? process.env[CLAUDE_TOKEN]);
        const { PATH: sandboxPath, ...run } = req.env;
        const named = { ...run, ...(hasToken ? { [CLAUDE_TOKEN]: SANDBOX_CLAUDE_TOKEN } : {}) };
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
    return this.follow({ runId: req.runId, limits: req.limits, model: req.model, secrets, remainingMs: req.limits.durationMs, child, stagnation: req.stagnation, ...(req.stagnation?.repeats ? { tree: worktreeReader(this.o.sandboxes, req, (m) => this.o.log?.(maskTranscriptLine(m, secrets))) } : {}) });
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
    return this.follow({ runId: req.runId, limits: req.limits, model: req.model, secrets, remainingMs: req.limits.durationMs - req.elapsedMs, stagnation: req.stagnation, ...(writer ? { writer } : {}) });
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
    // A model message streams on several lines, one per block: it is one turn (ORC-10).
    const turnIds = new Set<string>();
    let lastText = '';
    let transcriptError = '';
    let result: Extract<RunStreamEvent, { kind: 'result' }> | undefined;
    // Usage of each model message as it streams, by message id (its lines repeat it): the tokens of a
    // run that ends without a result line (stopped, capped, killed) are not lost (ORC-235).
    const usage = new Map<string, TokenUsage>();
    const totalUsage = () => [...usage.values()].reduce(addTokens, NO_TOKENS);
    let stopped = false;
    let limited = false;
    let overBudget: OverBudget | undefined;
    let usageLimit: RunResult['usageLimit'];
    let model = a.model;

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
    /** `over`: the budget the attempt spent (ORC-216), for its turn and token caps; none for its duration or the detector. */
    const limit = (over?: OverBudget) => {
      if (limited || stopped) return;
      limited = true;
      overBudget = over;
      interrupt();
    };
    const timer = setTimeout(() => limit(), Math.max(0, a.remainingMs));

    let stagnation: Stagnation | undefined;
    // Its end seen, or its result: a read that comes late signals no process and changes no outcome.
    let finished = false;
    const stagnated = (seen: Stagnation) => {
      if (limited || stopped || finished || result) return;
      stagnation = seen;
      limit();
    };
    const repeats = a.stagnation?.repeats;
    const loops = a.tree && repeats ? new LoopDetector(repeats) : undefined;
    const calls = new Map<string, string>();
    // One read at a time, in the order of the failures. Read once the failure came, while the agent waits for its next
    // model call: an edit that slips in only starts another count, it never makes a loop of work.
    let reading: Promise<void> = Promise.resolve();
    const watchLoops = (line: unknown) => {
      if (!loops) return;
      for (const failed of failedCommand(line, calls)) {
        reading = reading.then(async () => {
          if (limited || stopped || finished || result) return;
          const tree = await a.tree!();
          const seen = tree ? loops.record(failed, tree) : undefined;
          if (seen) stagnated(seen);
        });
      }
    };
    // On the daemon's clock, not the file's date: a host may date a file still open late. An attempt taken up gets its whole silence again.
    let lastWrite = Date.now();

    const onLine = (unmasked: string, relayed: boolean) => {
      try {
        const line = maskTranscriptLine(unmasked, a.secrets);
        transcript.write(line + '\n');
        const raw = JSON.parse(line) as Parameters<typeof usageLimitOf>[0] & { subtype?: string; model?: unknown; message?: { id?: unknown; usage?: unknown; model?: unknown } };
        // The model the CLI runs, as its init line says: what prices a cut run, whatever the request named (or did not).
        if (raw?.type === 'system' && raw.subtype === 'init' && typeof raw.model === 'string') model = raw.model;
        // A real model turn after a rejected rate limit event: the stream went on, the limit did not stop it. The CLI's own
        // message (model `<synthetic>`, the text of the error) is no turn.
        const modelTurn = raw?.type === 'assistant' && raw.message?.model !== '<synthetic>';
        // A later event that allows again (`allowed`, `allowed_warning`) lifts it too.
        const allowed = raw?.type === 'rate_limit_event' && typeof raw.rate_limit_info?.status === 'string' && raw.rate_limit_info.status.startsWith('allowed');
        usageLimit = usageLimitOf(raw) ?? (modelTurn || allowed ? undefined : usageLimit);
        if (raw?.type === 'assistant') {
          const id = typeof raw.message?.id === 'string' ? raw.message.id : undefined;
          if (id === undefined || !turnIds.has(id)) {
            if (id !== undefined) turnIds.add(id);
            if (++assistantTurns > a.limits.turns) limit('turns');
          }
          const used = id !== undefined ? parseUsage(raw.message?.usage) : undefined;
          if (used) {
            usage.set(id!, used);
            if (a.limits.tokens !== undefined && spentTokens(totalUsage()) > a.limits.tokens) limit('tokens');
          }
        }
        watchLoops(raw);
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
          lastWrite = Date.now();
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

    let poll: NodeJS.Timeout | undefined;
    /** No more reading, no more timer: the end of the handle, whether the attempt ended or was let go of. False if it was already. */
    const halt = (): boolean => {
      if (finished) return false;
      finished = true;
      clearInterval(poll);
      clearTimeout(timer);
      clearTimeout(killTimer);
      return true;
    };
    const done = new Promise<RunResult>((resolve) => {
      const finish = (spawnError?: Error) => {
        if (!halt()) return;
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
        // No result line and nobody stopped it: killed, out of memory, its container gone. Nothing for the agent to fix (ORC-136).
        const broke = spawnError || (!result && !stopped && !limited);
        // It becomes the run's lastText, stored and posted to Linear: the stream's text is masked
        // already, stderr and a spawn error are masked here.
        const text = result?.text || lastText || maskTranscriptLine(spawnError ? spawnError.message : stderr.trim().slice(-2000), a.secrets);
        // The larger of what the result line reports and what streamed, per field: a result that reports less than the work
        // done (none at all, after real turns) must not price it at $0, nor spare the ticket's budget (ORC-340).
        const streamed = usage.size ? totalUsage() : undefined;
        const tokens = result?.tokens && streamed ? maxTokens(result.tokens, streamed) : (result?.tokens ?? streamed);
        // What it consumed is priced, never $0 (ORC-340): cut before its result line (capped, stopped, killed), by estimate; with one,
        // the larger of the reported cost and the estimate, so a result that reports less than the tokens it used is not kept.
        const costUsd = Math.max(result?.costUsd ?? 0, tokens ? estimateCostUsd(model, tokens) : 0);
        // Told only of a run that did not succeed: what to do of it is the factory's (`on_usage_limit`), `infra` stays as without it.
        const cutByLimit = usageLimit && outcome !== 'success' ? { usageLimit } : {};
        transcript.end(() => resolve({ outcome, costUsd, turns: result?.turns ?? assistantTurns, lastText: text, ...(tokens ? { tokens } : {}), ...(broke ? { infra: true as const } : {}), ...(stagnation ? { stagnation } : {}), ...(outcome === 'limit' && overBudget ? { overBudget } : {}), ...cutByLimit }));
      };
      poll = setInterval(() => {
        read(true);
        // Not its parent: its end is seen by its pid, once what it wrote is read.
        if (!a.child && (!a.writer || !writerAlive(a.writer))) finish();
        else if (a.stagnation?.silentMs !== undefined && Date.now() - lastWrite > a.stagnation.silentMs) stagnated({ kind: 'silent', silentMs: a.stagnation.silentMs });
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
      // Its process and its stream file stay: the next daemon's `attach` follows them from there (ORC-344).
      detach: () => {
        if (!halt()) return;
        ch.close();
        transcript.end();
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
