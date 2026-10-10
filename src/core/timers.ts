import type { Store } from '../store/types.js';
import type { Clock } from './clock.js';
import type { RelaisEvent } from './types.js';

export class TimerService {
  private handle: NodeJS.Timeout | undefined;

  constructor(
    private store: Store,
    private clock: Clock,
    private emit: (e: RelaisEvent) => void,
  ) {}

  tick(): void {
    const now = this.clock.now();
    for (const t of this.store.dueTimers(now)) {
      this.store.deleteTimer(t.key);
      this.emit({
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
    this.handle = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.handle) clearInterval(this.handle);
    this.handle = undefined;
  }
}
