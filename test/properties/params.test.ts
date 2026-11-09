import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { params, seedOf } from './fold.js';

describe('the parameters of every property (ORC-368)', () => {
  it('run on a seed known before the run, which a failure reports and which, with its path, replays the counterexample', () => {
    const { seed } = params();
    expect(seed).toBe(seedOf(expect.getState().currentTestName));
    // Its own number of runs, so that it fails whatever NUM_RUNS.
    const property = fc.property(fc.integer({ min: 0, max: 1_000 }), (n) => n < 500);
    const failed = fc.check(property, { seed, numRuns: 1_000 });
    expect(failed.failed).toBe(true);
    expect(failed.seed).toBe(seed);
    const replayed = fc.check(property, { seed, path: failed.counterexamplePath! });
    expect(replayed.counterexample).toEqual(failed.counterexample);
  });

  it("draw each test's own sequences: another test, another seed, a 32-bit one fast-check takes as is", () => {
    expect(seedOf('a property')).not.toBe(seedOf('another property'));
    for (const name of ['a property', 'another property']) expect(seedOf(name) | 0).toBe(seedOf(name));
  });
});
