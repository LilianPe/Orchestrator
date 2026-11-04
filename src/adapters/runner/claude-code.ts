import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { addTokens, NO_TOKENS, type RunOutcome, type TokenUsage } from '../../core/types.js';
import { systemEnv } from '../exec.js';
import { Channel } from './channel.js';
import { parseStreamLine, parseUsage } from './stream-parser.js';
import { maskTranscriptLine, transcriptSecrets } from './transcript.js';
import type { SandboxProvider } from '../sandbox/types.js';
import type { RunHandle, RunRequest, RunResult, Runner, RunStreamEvent } from './types.js';

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

export class ClaudeCodeRunner implements Runner {
  constructor(private o: ClaudeRunnerOptions) {
    mkdirSync(o.transcriptsDir, { recursive: true });
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
    const child = spawn(cmd!, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const transcript = createWriteStream(join(this.o.transcriptsDir, `${req.runId}.jsonl`), { flags: 'a' });
    const ch = new Channel<RunStreamEvent>();
    let assistantTurns = 0;
    let lastText = '';
    let stderr = '';
    let result: Extract<RunStreamEvent, { kind: 'result' }> | undefined;
    // Usage of each model message as it streams, by message id (its lines repeat it): the tokens of a
    // run that ends without a result line (stopped, capped, killed) are not lost (ORC-235).
    const usage = new Map<string, TokenUsage>();
    let stopped = false;
    let limited = false;

    // Sandboxed, this kills the `docker exec` client, not `claude` in the container: the orchestrator
    // destroys the sandbox at the end of the run, which ends it.
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (child.pid === undefined) throw new Error('no pid');
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
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
    transcript.on('error', (e) => (stderr = (stderr + `\n[transcript] ${e.message}`).slice(-10_000)));
    const limit = () => {
      if (limited || stopped) return;
      limited = true;
      interrupt();
    };
    const timer = setTimeout(limit, req.limits.durationMs);

    createInterface({ input: child.stdout }).on('line', (unmasked) => {
      try {
        const line = maskTranscriptLine(unmasked, secrets);
        transcript.write(line + '\n');
        const raw = JSON.parse(line) as { type?: string; subtype?: string; message?: { id?: unknown; usage?: unknown } };
        if (raw?.type === 'assistant' && ++assistantTurns > req.limits.turns) limit();
        const used = raw?.type === 'assistant' && typeof raw.message?.id === 'string' ? parseUsage(raw.message.usage) : undefined;
        if (used) usage.set(raw.message!.id as string, used);
        if (raw?.type === 'result' && typeof raw.subtype === 'string' && raw.subtype.includes('max')) limited = true;
        for (const ev of parseStreamLine(line)) {
          if (ev.kind === 'text' && ev.text.trim()) lastText = ev.text;
          if (ev.kind === 'result') result = ev;
          ch.push(ev);
        }
      } catch {
        // a malformed line must never escape the handler; it stays in the transcript only
      }
    });
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-10_000)));

    const done = new Promise<RunResult>((resolve) => {
      let finished = false;
      const finish = (spawnError?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        ch.close();
        const outcome: RunOutcome = stopped ? 'stopped' : limited ? 'limit' : result && !result.isError ? 'success' : 'failure';
        // It becomes the run's lastText, stored and posted to Linear: the stream's text is masked
        // already, stderr and a spawn error are masked here.
        const text = result?.text || lastText || maskTranscriptLine(spawnError ? spawnError.message : stderr.trim().slice(-2000), secrets);
        const tokens = result?.tokens ?? (usage.size ? [...usage.values()].reduce(addTokens, NO_TOKENS) : undefined);
        transcript.end(() => resolve({ outcome, costUsd: result?.costUsd ?? 0, turns: result?.turns ?? assistantTurns, lastText: text, ...(tokens ? { tokens } : {}), ...(spawnError ? { infra: true as const } : {}) }));
      };
      child.on('error', (err) => finish(err));
      child.on('close', () => finish());
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
