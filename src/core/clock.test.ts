import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';

describe('FakeClock', () => {
  it('starts at the given time and advances', () => {
    const c = new FakeClock(1000);
    c.advance(500);
    expect(c.now()).toBe(1500);
    c.set(42);
    expect(c.now()).toBe(42);
  });
});
