import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../store/sqlite-store.js';
import { Scheduler } from './scheduler.js';

describe('Scheduler', () => {
  it('hands out slots up to capacity per queue', () => {
    const s = new Scheduler(new SqliteStore(':memory:'), { dev: 2, questions: 1 });
    expect(s.tryAcquire('dev', 'A')).toBe(0);
    expect(s.tryAcquire('dev', 'B')).toBe(1);
    expect(s.tryAcquire('dev', 'C')).toBeNull();
    expect(s.tryAcquire('questions', 'C')).toBe(0);
    expect(s.inUse('dev')).toBe(2);
    expect(s.hasFree('dev')).toBe(false);
    expect(s.hasFree('questions')).toBe(false);
  });

  it('reuses freed slot indexes', () => {
    const s = new Scheduler(new SqliteStore(':memory:'), { dev: 2, questions: 1 });
    s.tryAcquire('dev', 'A');
    s.tryAcquire('dev', 'B');
    expect(s.release('A')).toBe('dev');
    expect(s.tryAcquire('dev', 'C')).toBe(0);
  });

  it('refuses a second slot for the same ticket', () => {
    const s = new Scheduler(new SqliteStore(':memory:'), { dev: 3, questions: 1 });
    s.tryAcquire('dev', 'A');
    expect(s.tryAcquire('dev', 'A')).toBeNull();
  });
});
