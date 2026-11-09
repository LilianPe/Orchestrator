import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../store/sqlite-store.js';
import { FLAKY_USAGE, runFlaky, type FlakyOptions } from './flaky.js';

function withStore() {
  const store = new SqliteStore(':memory:');
  const lines: string[] = [];
  const flaky = (o: Partial<FlakyOptions>) => runFlaky({ store, project: 'p', by: 'armand', now: 20, print: (l) => void lines.push(l), ...o });
  return { store, lines, flaky };
}

describe('factory flaky (ORC-164)', () => {
  it("lists a test as known flaky with the human who decided, why and when, then lists the project's", async () => {
    const { store, lines, flaky } = withStore();
    expect(await flaky({ action: 'add', test: 'src/a.test.ts > cart total', reason: 'times out under load' })).toBe(0);
    expect(await store.knownFlakyTests('p')).toEqual([{ projectId: 'p', test: 'src/a.test.ts > cart total', coversFrozen: false, reason: 'times out under load', addedBy: 'armand', addedAt: 20 }]);
    lines.length = 0;
    expect(await flaky({})).toBe(0);
    expect(lines).toEqual(['Known flaky tests of p:', '  src/a.test.ts > cart total  (armand: times out under load)']);
  });

  it('covers a frozen test only on `--frozen`, a decision of its own, said in the list', async () => {
    const { store, lines, flaky } = withStore();
    await flaky({ action: 'add', test: 'tests/t.py::test_it', reason: 'network', frozen: true });
    expect((await store.knownFlakyTests('p'))[0]!.coversFrozen).toBe(true);
    lines.length = 0;
    await flaky({});
    expect(lines[1]).toBe('  tests/t.py::test_it  (armand: network; frozen tests too)');
  });

  it('takes a test off the list, and says when it was not on it', async () => {
    const { store, lines, flaky } = withStore();
    await flaky({ action: 'add', test: 't', reason: 'r' });
    expect(await flaky({ action: 'remove', test: 't' })).toBe(0);
    expect(await store.knownFlakyTests('p')).toEqual([]);
    expect(await flaky({ action: 'remove', test: 't' })).toBe(1);
    expect(lines.at(-1)).toBe('t is not a known flaky test of p.');
  });

  it('refuses an addition without its test or its reason, and an unknown action', async () => {
    const { store, lines, flaky } = withStore();
    expect(await flaky({ action: 'add', test: 't' })).toBe(1);
    expect(await flaky({ action: 'add', reason: 'r' })).toBe(1);
    expect(await flaky({ action: 'drop', test: 't' })).toBe(1);
    expect(lines).toEqual([FLAKY_USAGE, FLAKY_USAGE, FLAKY_USAGE]);
    expect(await store.knownFlakyTests('p')).toEqual([]);
  });
});
