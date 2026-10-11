import { describe, expect, it } from 'vitest';
import { FakeTracker } from './fake.js';

describe('FakeTracker', () => {
  it('moves issues and records activities', async () => {
    const t = new FakeTracker();
    t.addIssue({ identifier: 'REL-1', title: 'T' });
    await t.moveTo('REL-1', 'In Progress');
    expect((await t.getIssue('REL-1')).stateName).toBe('In Progress');
    const s = await t.ensureSession('REL-1');
    await t.activity(s, { type: 'thought', body: 'x' });
    expect(t.activities(s)).toEqual([{ type: 'thought', body: 'x' }]);
    await expect(t.getIssue('NOPE-1')).rejects.toThrow('unknown issue NOPE-1');
  });
});
