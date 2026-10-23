import { FakeClock, type Clock } from '../../core/clock.js';
import type { RunOutcome } from '../../core/types.js';
import { Channel } from './channel.js';
import type { RunHandle, RunRequest, RunResult, Runner, RunStreamEvent } from './types.js';

export interface FakeScript {
  events?: RunStreamEvent[];
  outcome?: RunOutcome;
  costUsd?: number;
  turns?: number;
  hold?: boolean;
}

/** Turn and duration caps hold as on the real runtime: turns on the scripted count, duration on `clock`, checked at each `tick`. */
export class FakeRunner implements Runner {
  requests: RunRequest[] = [];
  private scripts: FakeScript[] = [];
  private live = new Map<string, { deadline: number; end: (outcome?: RunOutcome) => void }>();

  constructor(private readonly clock: Clock = new FakeClock()) {}

  enqueue(...scripts: FakeScript[]): void {
    this.scripts.push(...scripts);
  }

  release(runId: string): void {
    this.live.get(runId)?.end();
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
    let forced: RunOutcome | undefined = overTurns ? 'limit' : undefined;
    let releaseHold: () => void = () => {};
    const held = s.hold && !overTurns ? new Promise<void>((resolve) => (releaseHold = resolve)) : Promise.resolve();
    const end = (outcome?: RunOutcome) => {
      forced ??= outcome;
      releaseHold();
    };
    if (s.hold && !overTurns) this.live.set(req.runId, { deadline: this.clock.now() + req.limits.durationMs, end });
    const lastText = [...events].reverse().find((e): e is Extract<RunStreamEvent, { kind: 'text' }> => e.kind === 'text')?.text ?? '';
    const done: Promise<RunResult> = held.then(() => {
      ch.close();
      this.live.delete(req.runId);
      const turns = overTurns ? req.limits.turns + 1 : (s.turns ?? 1);
      return { outcome: forced ?? s.outcome ?? 'success', costUsd: s.costUsd ?? 0.1, turns, lastText };
    });
    return { events: ch, done, stop: () => end('stopped') };
  }
}
