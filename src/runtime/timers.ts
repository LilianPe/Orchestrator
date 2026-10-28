import type { Clock } from '../core/clock.js';
import { TRUSTED, type FactoryEvent } from '../core/types.js';
import type { Store, TimerRecord } from '../store/types.js';

/** The event of a timer's firing (ORC-161): its id `timer:<key>:<fireAt>` names that firing, once. */
export function timerEvent(t: TimerRecord, at: number): FactoryEvent<'timer.fired'> {
  return {
    ...TRUSTED,
    id: `timer:${t.key}:${t.fireAt}`,
    type: 'timer.fired',
    at,
    projectId: t.projectId,
    ticketId: t.ticketId,
    payload: { kind: t.kind, payload: t.payload } as FactoryEvent<'timer.fired'>['payload'],
  };
}

/**
 * Fires the timers in `timers` once due (ORC-161). Nothing lives in the process: the timers are
 * written by the decision transaction that arms them, and each firing writes `timer.fired` to the
 * inbox and deletes the timer in one transaction (`Store.fireTimer`), so a crash loses no firing and
 * fires none twice. The worker then decides the event like any other.
 */
export class TimerService {
  private handle: NodeJS.Timeout | undefined;

  constructor(
    private store: Store,
    private clock: Clock,
    /** Told of each firing written to the inbox, to process it without waiting for the next poll. */
    private fired: (e: FactoryEvent) => void = () => {},
    private onError: (err: Error) => void = () => {},
  ) {}

  private ticking: Promise<void> | undefined;

  /** One pass at a time: a tick that finds a pass still running waits for it instead of starting another. */
  tick(): Promise<void> {
    this.ticking ??= this.fire().finally(() => (this.ticking = undefined));
    return this.ticking;
  }

  private async fire(): Promise<void> {
    const now = this.clock.now();
    for (const t of await this.store.dueTimers(now)) {
      const event = timerEvent(t, now);
      if (await this.store.fireTimer(t, event)) this.fired(event);
    }
  }

  start(intervalMs = 1000): void {
    if (this.handle) clearInterval(this.handle);
    this.handle = setInterval(() => void this.tick().catch((err: Error) => this.onError(err)), intervalMs);
  }

  /** No pass starts after it; resolves once the pass under way, if any, has finished. */
  async stop(): Promise<void> {
    if (this.handle) clearInterval(this.handle);
    this.handle = undefined;
    await this.ticking?.catch(() => {});
  }
}
