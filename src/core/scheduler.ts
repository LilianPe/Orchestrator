import type { QueueClaim, QueueItem, Store } from '../store/types.js';
import type { QueueName } from './types.js';

/** Dev runs at once: `concurrency` of factory.yml (ORC-203), else `limits.parallel_sessions` of the workflow. */
export function devCapacity(concurrency: number | undefined, parallelSessions: number | undefined): number {
  return concurrency ?? parallelSessions ?? 3;
}

export class Scheduler {
  private held = new Map<string, { queue: QueueName; slot: number }>();
  /** Who waits for a slot (`acquire`), first come first served: a freed slot goes to them before any new launch. */
  private waits: { queue: QueueName; key: string; resolve: (slot: number | null) => void }[] = [];

  constructor(
    private store: Store,
    private capacity: Record<QueueName, number>,
  ) {}

  setCapacity(capacity: Record<QueueName, number>): void {
    this.capacity = capacity;
    this.serve();
  }

  tryAcquire(queue: QueueName, key: string): number | null {
    if (this.held.has(key)) return null;
    const used = new Set([...this.held.values()].filter((h) => h.queue === queue).map((h) => h.slot));
    for (let i = 0; i < this.capacity[queue]; i++) {
      if (!used.has(i)) {
        this.held.set(key, { queue, slot: i });
        return i;
      }
    }
    return null;
  }

  /**
   * A slot of `queue` for `key`, now or as soon as one frees (ORC-353): what holds a slot without a launch, the sandbox of a
   * `verify`, waits for it instead of going back in line. `null` once `cancelWaits` gave up the wait.
   */
  acquire(queue: QueueName, key: string): Promise<number | null> {
    const slot = this.tryAcquire(queue, key);
    if (slot !== null) return Promise.resolve(slot);
    return new Promise((resolve) => this.waits.push({ queue, key, resolve }));
  }

  /** Every wait of `acquire` given up, with `null`: a daemon that stops starts nothing more. */
  cancelWaits(): void {
    for (const w of this.waits.splice(0)) w.resolve(null);
  }

  release(key: string): QueueName | undefined {
    const h = this.held.get(key);
    this.held.delete(key);
    if (h) this.serve();
    return h?.queue;
  }

  private serve(): void {
    this.waits = this.waits.filter((w) => {
      const slot = this.tryAcquire(w.queue, w.key);
      if (slot !== null) w.resolve(slot);
      return slot === null;
    });
  }

  inUse(queue: QueueName): number {
    return [...this.held.values()].filter((h) => h.queue === queue).length;
  }

  free(queue: QueueName): number {
    return this.capacity[queue] - this.inUse(queue);
  }

  hasFree(queue: QueueName): boolean {
    return this.inUse(queue) < this.capacity[queue];
  }

  async enqueue(item: QueueItem): Promise<void> {
    await this.store.enqueue(item);
  }

  /** The next item of a queue, handed out under a lease until its start is recorded (ORC-150). */
  next(queue: QueueName, leaseMs: number): Promise<QueueClaim | undefined> {
    return this.store.claimQueued(queue, leaseMs);
  }
}
