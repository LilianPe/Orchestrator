import type { QueueItem, Store } from '../store/types.js';
import type { QueueName } from './types.js';

export class Scheduler {
  private held = new Map<string, { queue: QueueName; slot: number }>();

  constructor(
    private store: Store,
    private capacity: Record<QueueName, number>,
  ) {}

  setCapacity(capacity: Record<QueueName, number>): void {
    this.capacity = capacity;
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

  release(key: string): QueueName | undefined {
    const h = this.held.get(key);
    this.held.delete(key);
    return h?.queue;
  }

  inUse(queue: QueueName): number {
    return [...this.held.values()].filter((h) => h.queue === queue).length;
  }

  hasFree(queue: QueueName): boolean {
    return this.inUse(queue) < this.capacity[queue];
  }

  async enqueue(item: QueueItem): Promise<void> {
    await this.store.enqueue(item);
  }

  next(queue: QueueName): Promise<QueueItem | undefined> {
    return this.store.dequeue(queue);
  }
}
