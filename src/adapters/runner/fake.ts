import { FakeClock, type Clock } from '../../core/clock.js';
import type { RunOutcome, TokenUsage } from '../../core/types.js';
import { Channel } from './channel.js';
import type { AttachRequest, RunHandle, RunRequest, RunResult, Runner, RunStreamEvent } from './types.js';

export interface FakeScript {
  events?: RunStreamEvent[];
  outcome?: RunOutcome;
  costUsd?: number;
  turns?: number;
  /** Usage the run reports, as `claude -p` does in its result line (ORC-235); none by default. */
  tokens?: TokenUsage;
  hold?: boolean;
  /** The run's end rejects with this message, as a broken stream or a sandbox gone does. */
  fail?: string;
}

interface LiveRun {
  deadline: number;
  end: (outcome?: RunOutcome) => void;
  done: Promise<RunResult>;
  /** Its heartbeat: false once a test has muted it (`mute`). */
  alive: boolean;
}

/** Turn and duration caps hold as on the real runtime: turns on the scripted count, duration on `clock`, checked at each `tick`. */
export class FakeRunner implements Runner {
  requests: RunRequest[] = [];
  private scripts: FakeScript[] = [];
  private live = new Map<string, LiveRun>();

  constructor(private readonly clock: Clock = new FakeClock()) {}

  enqueue(...scripts: FakeScript[]): void {
    this.scripts.push(...scripts);
  }

  release(runId: string): void {
    this.live.get(runId)?.end();
  }

  /** The held run stops answering the heartbeat, as a process stuck or a container lost (ORC-220). */
  mute(runId: string): void {
    const run = this.live.get(runId);
    if (run) run.alive = false;
  }

  /** The held run is gone with the daemon that started it: nothing left to attach to (ORC-220). */
  forget(runId: string): void {
    this.live.delete(runId);
  }

  tick(): void {
    const now = this.clock.now();
    for (const run of [...this.live.values()]) if (now >= run.deadline) run.end('limit');
  }

  start(req: RunRequest): RunHandle {
    this.requests.push(req);
    const s = this.scripts.shift() ?? {};
    const events = s.events ?? [{ kind: 'text', text: 'Terminé.' }];
    const ch = new Channel<RunStreamEvent>();
    for (const e of events) ch.push(e);
    const overTurns = (s.turns ?? 1) > req.limits.turns;
    const turns = overTurns ? req.limits.turns + 1 : (s.turns ?? 1);
    let forced: RunOutcome | undefined;
    let releaseHold: () => void = () => {};
    const held = s.hold ? new Promise<void>((resolve) => (releaseHold = resolve)) : Promise.resolve();
    const end = (outcome?: RunOutcome) => {
      forced ??= outcome;
      releaseHold();
    };
    const lastText = [...events].reverse().find((e): e is Extract<RunStreamEvent, { kind: 'text' }> => e.kind === 'text')?.text ?? '';
    const done: Promise<RunResult> = held.then(() => {
      ch.close();
      this.live.delete(req.runId);
      if (s.fail) throw new Error(s.fail);
      return { outcome: forced ?? s.outcome ?? 'success', costUsd: s.costUsd ?? 0.1, turns, lastText, ...(s.tokens ? { tokens: s.tokens } : {}) };
    });
    const run: LiveRun = { deadline: this.clock.now() + req.limits.durationMs, end, done, alive: true };
    if (s.hold) this.live.set(req.runId, run);
    if (overTurns) end('limit');
    return this.handle(run, ch);
  }

  /** A run still held outlives the process that started it, as a container does; any other is gone. */
  attach(req: AttachRequest): RunHandle | undefined {
    const run = this.live.get(req.runId);
    if (!run) return undefined;
    const ch = new Channel<RunStreamEvent>();
    void run.done.finally(() => ch.close()).catch(() => {});
    return this.handle(run, ch);
  }

  private handle(run: LiveRun, events: Channel<RunStreamEvent>): RunHandle {
    return { events, done: run.done, stop: () => run.end('stopped'), alive: () => run.alive };
  }
}
