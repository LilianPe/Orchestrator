import { describe, expect, it } from 'vitest';
import { evalCondition, parseCondition } from './conditions.js';

const ctx = { state: 'human_review' as const, blocked: false, job: 'dev' };

describe('conditions', () => {
  it.each([
    ['state == human_review', true],
    ['state != human_review', false],
    ['state in [dev, human_review]', true],
    ['state in [todo]', false],
    ['blocked', false],
    ['!blocked', true],
    ['job == dev', true],
    ['state in [dev, human_review] && !blocked', true],
    ['state == human_review && blocked', false],
  ])('%s -> %s', (src, expected) => {
    expect(evalCondition(parseCondition(src), ctx)).toBe(expected);
  });

  it('rejects unknown states', () => {
    expect(() => parseCondition('state == nowhere')).toThrow('invalid condition');
  });
  it('rejects unsupported syntax', () => {
    expect(() => parseCondition('state == dev || blocked')).toThrow('invalid condition');
  });
});
