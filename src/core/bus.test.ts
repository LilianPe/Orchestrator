import { describe, expect, it } from 'vitest';
import { EventBus, type BusMessage } from './bus.js';

describe('EventBus', () => {
  it('fans out and unsubscribes', () => {
    const bus = new EventBus();
    const got: BusMessage[] = [];
    const off = bus.subscribe((m) => got.push(m));
    const m: BusMessage = { kind: 'log', level: 'info', message: 'x', at: 1 };
    bus.publish(m);
    off();
    bus.publish(m);
    expect(got).toEqual([m]);
  });
});
