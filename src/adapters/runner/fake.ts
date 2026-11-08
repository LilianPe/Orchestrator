import { FakeClock, type Clock } from '../../core/clock.js';
import type { AgentOutput } from '../../core/agent-output.js';
import type { RunOutcome, Stagnation, TokenUsage } from '../../core/types.js';
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
  /** What the detector saw (ORC-136). */
  stagnation?: Stagnation;
  /** The subscription's usage limit stopped it (ORC-340). */
  usageLimit?: { resetAt?: number };
  /** `false`: this build never calls `submit_result`. */
  submit?: false;
  /** What this run hands to `submit_result`, whatever its step (the `intake` assessment, ORC-206), in place of a build's default. */
  output?: AgentOutput;
}

interface LiveRun {
  deadline: number;
  end: (outcome?: RunOutcome) => void;
  done: Promise<RunResult>;
  /** The streams of the handles that follow it: its start's, then each attach's. */
  streams: Set<Channel<RunStreamEvent>>;
}

/** Turn and duration caps hold as on the real runtime: turns on the scripted count, duration on `clock`, checked at each `tick`. */
export class FakeRunner implements Runner {
  requests: RunRequest[] = [];
  private scripts: FakeScript[] = [];
  private live = new Map<string, LiveRun>();
  /**
   * Stands for the `submit_result` every job ends on (ORC-136, ORC-214: a reply is its summary): given a store, the fake
   * agent does what the skill says, with its last text as summary. Without it, it submits nothing.
   */
  submit?: (runId: string, output: AgentOutput) => Promise<void>;

  constructor(private readonly clock: Clock = new FakeClock()) {}

  enqueue(...scripts: FakeScript[]): void {
    this.scripts.push(...scripts);
  }

  release(runId: string): void {
    this.live.get(runId)?.end();
  }

  /** A held run writes one more event: each handle that follows it reads it, as progress (ORC-344). */
  say(runId: string, event: RunStreamEvent): void {
    for (const ch of this.live.get(runId)?.streams ?? []) ch.push(event);
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
    const events = s.events ?? [{ kind: 'text', text: 'Done.' }];
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
    // An AI review lens hands back its findings, none by default (ORC-183).
    const review = req.tools ? { findings: [] } : {};
    const output: AgentOutput = s.output ?? { status: 'done', summary: lastText || 'Done.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], ...review };
    const submitted = this.submit && s.submit !== false ? this.submit(req.runId, output).catch(() => {}) : Promise.resolve();
    const done: Promise<RunResult> = Promise.all([held, submitted]).then(() => {
      ch.close();
      this.live.delete(req.runId);
      if (s.fail) throw new Error(s.fail);
      return { outcome: forced ?? s.outcome ?? 'success', costUsd: s.costUsd ?? 0.1, turns, lastText, ...(s.tokens ? { tokens: s.tokens } : {}), ...(s.stagnation ? { stagnation: s.stagnation } : {}), ...(s.usageLimit ? { usageLimit: s.usageLimit } : {}) };
    });
    const run: LiveRun = { deadline: this.clock.now() + req.limits.durationMs, end, done, streams: new Set([ch]) };
    if (s.hold) this.live.set(req.runId, run);
    if (overTurns) end('limit');
    return this.handle(run, ch);
  }

  /** A run still held outlives the process that started it, as a container does; any other is gone. */
  attach(req: AttachRequest): RunHandle | undefined {
    const run = this.live.get(req.runId);
    if (!run) return undefined;
    const ch = new Channel<RunStreamEvent>();
    run.streams.add(ch);
    void run.done.finally(() => ch.close()).catch(() => {});
    return this.handle(run, ch);
  }

  private handle(run: LiveRun, events: Channel<RunStreamEvent>): RunHandle {
    // Detached, it never settles: the attempt's end is the next follower's.
    const never = new Promise<RunResult>(() => {});
    const done = run.done.catch(() => {}).then(() => (run.streams.has(events) ? run.done : never));
    return {
      events,
      done,
      stop: () => run.end('stopped'),
      detach: () => {
        run.streams.delete(events);
        events.close();
      },
    };
  }
}
