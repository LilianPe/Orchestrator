import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { RunOutcome } from '../../core/types.js';
import { Channel } from './channel.js';
import { parseStreamLine } from './stream-parser.js';
import type { RunHandle, RunRequest, RunResult, Runner, RunStreamEvent } from './types.js';

export interface ClaudeRunnerOptions {
  transcriptsDir: string;
  command?: string[];
  killGraceMs?: number;
}

export function buildClaudeArgs(req: RunRequest): string[] {
  const args = [
    '-p', req.prompt,
    '--output-format', 'stream-json',
    '--verbose',
    req.resume ? '--resume' : '--session-id', req.claudeSessionId,
    '--model', req.model,
    '--plugin-dir', req.pluginDir,
    '--settings', req.settingsPath,
    '--setting-sources', 'project,local',
    '--max-budget-usd', String(req.limits.usd),
  ];
  if (req.readOnly) args.push('--permission-mode', 'plan');
  return args;
}

/** Variables the daemon sets for a run; every other RELAIS_* (and every LINEAR_*) stays in the daemon. */
const DAEMON_ONLY = /^(LINEAR_|RELAIS_)/;

export function childEnv(base: NodeJS.ProcessEnv, run: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !DAEMON_ONLY.test(k)) env[k] = v;
  return { ...env, ...run };
}

export class ClaudeCodeRunner implements Runner {
  constructor(private o: ClaudeRunnerOptions) {
    mkdirSync(o.transcriptsDir, { recursive: true });
  }

  start(req: RunRequest): RunHandle {
    const [cmd, ...prefix] = this.o.command ?? ['claude'];
    const child = spawn(cmd!, [...prefix, ...buildClaudeArgs(req)], {
      cwd: req.cwd,
      env: childEnv(process.env, req.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const transcript = createWriteStream(join(this.o.transcriptsDir, `${req.runId}.jsonl`), { flags: 'a' });
    const ch = new Channel<RunStreamEvent>();
    let assistantTurns = 0;
    let lastText = '';
    let stderr = '';
    let result: Extract<RunStreamEvent, { kind: 'result' }> | undefined;
    let stopped = false;
    let limited = false;

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

    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        transcript.write(line + '\n');
        const raw = JSON.parse(line) as { type?: string; subtype?: string };
        if (raw?.type === 'assistant' && ++assistantTurns > req.limits.turns) limit();
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
        const text = result?.text || lastText || (spawnError ? spawnError.message : stderr.trim().slice(-2000));
        transcript.end(() => resolve({ outcome, costUsd: result?.costUsd ?? 0, turns: result?.turns ?? assistantTurns, lastText: text }));
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
