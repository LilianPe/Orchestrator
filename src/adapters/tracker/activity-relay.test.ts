import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityRelay } from './activity-relay.js';
import type { ActivityInput } from './types.js';

describe('ActivityRelay', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  it('throttles to one activity per interval, latest wins', async () => {
    const sent: ActivityInput[] = [];
    const relay = new ActivityRelay(async (a) => void sent.push(a), 2000, () => Date.now());
    relay.push({ kind: 'tool', name: 'Bash', input: 'npm test' });
    relay.push({ kind: 'text', text: 'first' });
    relay.push({ kind: 'text', text: 'second' });
    relay.push({ kind: 'result', isError: false, costUsd: 0, turns: 1, text: '' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual([
      { type: 'action', action: 'Bash', parameter: 'npm test', ephemeral: true },
      { type: 'thought', body: 'second', ephemeral: true },
    ]);
  });

  it('flush drops the pending activity', async () => {
    const sent: ActivityInput[] = [];
    const relay = new ActivityRelay(async (a) => void sent.push(a), 2000, () => Date.now());
    relay.push({ kind: 'text', text: 'a' });
    relay.push({ kind: 'text', text: 'b' });
    await relay.flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([{ type: 'thought', body: 'a', ephemeral: true }]);
  });
});
