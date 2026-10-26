import type { Store } from '../store/types.js';
import type { Clock } from './clock.js';
import { TRUSTED, type FactoryEvent } from './types.js';

export class TimerService {
  private handle: NodeJS.Timeout | undefined;

  constructor(
    private store: Store,
    private clock: Clock,
    private emit: (e: FactoryEvent) => void,
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
      await this.store.deleteTimer(t.key);
      this.emit({
        ...TRUSTED,
        id: `timer:${t.key}:${t.fireAt}`,
        type: 'debounce.fired',
        at: now,
        projectId: t.projectId,
        ticketId: t.ticketId,
        payload: { job: t.job },
      });
    }
  }

  start(intervalMs = 1000): void {
    this.stop();
    this.handle = setInterval(() => void this.tick().catch((err: Error) => this.onError(err)), intervalMs);
  }

  stop(): void {
    if (this.handle) clearInterval(this.handle);
    this.handle = undefined;
  }
}
