import type { Store } from '../store/types.js';
import type { Clock } from './clock.js';
import { TRUSTED, type FactoryEvent } from './types.js';

export class TimerService {
  private handle: NodeJS.Timeout | undefined;

  constructor(
    private store: Store,
    private clock: Clock,
    /** Writes the firing to the inbox; awaited before the timer is deleted. */
    private emit: (e: FactoryEvent) => unknown,
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
      // The firing is in the inbox before the timer goes (ORC-147): a pass cut in between fires it
      // again on the next one, and the id dedups the second firing.
      await this.emit({
        ...TRUSTED,
        id: `timer:${t.key}:${t.fireAt}`,
        type: 'debounce.fired',
        at: now,
        projectId: t.projectId,
        ticketId: t.ticketId,
        payload: { job: t.job },
      });
      // Only the timer read here: the orchestrator may have re-armed the key meanwhile.
      await this.store.deleteTimer(t.key, t.fireAt);
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
