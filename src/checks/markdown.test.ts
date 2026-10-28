import { describe, expect, it } from 'vitest';
import { mdCode } from './markdown.js';

describe('mdCode', () => {
  it('wraps text in a code span', () => {
    expect(mdCode('src/a.ts')).toBe('`src/a.ts`');
  });

  it('keeps a span whole around a backtick', () => {
    expect(mdCode('a`b')).toBe('`` a`b ``');
  });

  it('turns control characters into ?, so a newline cannot end the span', () => {
    expect(mdCode('a\n# title\tb\u007f')).toBe('`a?# title?b?`');
  });
});
