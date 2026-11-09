import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { params, SEED } from './fold.js';

describe('the parameters of every property (ORC-368)', () => {
  it('run on a seed known before the run, which a failure reports and which, with its path, replays the counterexample', () => {
    expect(params().seed).toBe(SEED);
    const property = fc.property(fc.integer({ min: 0, max: 1_000 }), (n) => n < 500);
    const failed = fc.check(property, params());
    expect(failed.failed).toBe(true);
    expect(failed.seed).toBe(SEED);
    const replayed = fc.check(property, { ...params(), path: failed.counterexamplePath! });
    expect(replayed.counterexample).toEqual(failed.counterexample);
  });
});
