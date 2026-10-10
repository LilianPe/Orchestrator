import { describe, expect, it } from 'vitest';
import { parseDuration } from './duration.js';

describe('parseDuration', () => {
  it.each([
    ['0s', 0],
    ['3m', 180_000],
    ['90m', 5_400_000],
    ['2h', 7_200_000],
    ['250ms', 250],
    [1500, 1500],
  ])('%s -> %d', (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });
  it('rejects garbage', () => {
    expect(() => parseDuration('soon')).toThrow('invalid duration: soon');
  });
});
