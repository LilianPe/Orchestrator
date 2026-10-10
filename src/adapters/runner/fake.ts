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

export class FakeRunner implements Runner {
  requests: RunRequest[] = [];
  private scripts: FakeScript[] = [];
  private holds = new Map<string, () => void>();

  enqueue(...scripts: FakeScript[]): void {
    this.scripts.push(...scripts);
  }

  release(runId: string): void {
    this.holds.get(runId)?.();
  }

  start(req: RunRequest): RunHandle {
    this.requests.push(req);
    const s = this.scripts.shift() ?? {};
    const events = s.events ?? [{ kind: 'text', text: 'Terminé.' }];
    const ch = new Channel<RunStreamEvent>();
    for (const e of events) ch.push(e);
    let stopped = false;
    let releaseHold: () => void = () => {};
    const held = s.hold
      ? new Promise<void>((resolve) => {
          releaseHold = resolve;
          this.holds.set(req.runId, resolve);
        })
      : Promise.resolve();
    const lastText = [...events].reverse().find((e): e is Extract<RunStreamEvent, { kind: 'text' }> => e.kind === 'text')?.text ?? '';
    const done: Promise<RunResult> = held.then(() => {
      ch.close();
      this.holds.delete(req.runId);
      return { outcome: stopped ? 'stopped' : (s.outcome ?? 'success'), costUsd: s.costUsd ?? 0.1, turns: s.turns ?? 1, lastText };
    });
    return {
      events: ch,
      done,
      stop: () => {
        stopped = true;
        releaseHold();
      },
    };
  }
}
