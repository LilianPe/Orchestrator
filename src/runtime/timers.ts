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
    /** Called after a firing is written to the inbox, so the worker processes it without waiting for its next poll. */
    private wake: () => void = () => {},
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
    let failed: unknown;
    for (const t of await this.store.dueTimers(now)) {
      // A timer whose firing fails stays due for the next pass, and does not hold back the others.
      try {
        if (await this.store.fireTimer(t, timerEvent(t, now))) this.wake();
      } catch (err) {
        failed ??= err;
      }
    }
    if (failed !== undefined) throw failed;
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
