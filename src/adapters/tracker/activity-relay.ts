import type { RunStreamEvent } from '../runner/types.js';
import type { ActivityInput } from './types.js';

function toActivity(ev: RunStreamEvent): ActivityInput | undefined {
  if (ev.kind === 'tool') return { type: 'action', action: ev.name, parameter: ev.input.slice(0, 120), ephemeral: true };
  if (ev.kind === 'text' && ev.text.trim()) return { type: 'thought', body: ev.text.slice(0, 500), ephemeral: true };
  return undefined;
}

export class ActivityRelay {
  private last = Number.NEGATIVE_INFINITY;
  private pending: ActivityInput | undefined;
  private timer: NodeJS.Timeout | undefined;
  private sending: Promise<void> = Promise.resolve();

  constructor(
    private send: (a: ActivityInput) => Promise<void>,
    private intervalMs = 2000,
    private now: () => number = Date.now,
  ) {}

  push(ev: RunStreamEvent): void {
    const a = toActivity(ev);
    if (!a) return;
    this.pending = a;
    const wait = this.last + this.intervalMs - this.now();
    if (wait <= 0) this.fire();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.fire();
      }, wait);
    }
  }

  private fire(): void {
    const a = this.pending;
    if (!a) return;
    this.pending = undefined;
    this.last = this.now();
    this.sending = this.sending.then(() => this.send(a)).catch(() => undefined);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    await this.sending;
  }
}
