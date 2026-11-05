import { describe, expect, it } from 'vitest';
import { LOG_EXCERPT_MAX, logExcerpt } from './log-excerpt.js';

const noise = (n: number, prefix = 'noise line') => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n');

describe('logExcerpt', () => {
  it('keeps a short output whole, without its colours', () => {
    expect(logExcerpt('\u001b[31mFAIL\u001b[0m a.test.ts\nline')).toBe('FAIL a.test.ts\nline');
  });

  it('keeps the start, the end and the lines that look like errors, within the bound', () => {
    const log = [noise(2000, 'early'), 'AssertionError: expected 1 to be 2', noise(2000, 'middle'), 'Error: boom', noise(2000, 'late'), 'Tests: 1 failed'].join('\n');
    const out = logExcerpt(log);
    expect(out.length).toBeLessThanOrEqual(LOG_EXCERPT_MAX + 80);
    expect(out).toContain('early 0');
    expect(out).toContain('AssertionError: expected 1 to be 2');
    expect(out).toContain('Error: boom');
    expect(out.endsWith('Tests: 1 failed')).toBe(true);
    expect(out).not.toContain('middle 1000');
    expect(out).toMatch(/\[… \d+ lignes coupées …\]/);
  });

  it('bounds one huge line', () => {
    const out = logExcerpt('x'.repeat(LOG_EXCERPT_MAX * 20));
    expect(out.length).toBeLessThanOrEqual(LOG_EXCERPT_MAX);
  });

  it('bounds error lines however many there are, the end kept', () => {
    const out = logExcerpt(`${noise(10_000, 'error at')}\nthe end`);
    expect(out.length).toBeLessThanOrEqual(LOG_EXCERPT_MAX + 80);
    expect(out.endsWith('the end')).toBe(true);
  });

  it('is stable: an excerpt read again does not change', () => {
    const once = logExcerpt(noise(5000));
    expect(logExcerpt(once)).toBe(once);
  });
});
