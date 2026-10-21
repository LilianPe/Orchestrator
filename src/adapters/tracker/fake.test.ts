import { describe, expect, it } from 'vitest';
import { describeTrackerContract } from '../../../test/contracts/tracker.contract.js';
import { FakeTracker } from './fake.js';

describeTrackerContract(
  'FakeTracker',
  () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV des audits', labels: ['bug'], delegateId: 'app' });
    tracker.addIssue({ identifier: 'REL-2', title: 'Autre ticket' });
    return {
      tracker,
      issue: 'REL-1',
      missing: 'REL-404',
      searchTerm: 'csv',
      states: ['In Progress', 'In Review'],
      writable: true,
      delegation: { teamKey: 'REL', delegated: 'REL-1', notDelegated: 'REL-2' },
    };
  },
  ['moveTo-unknown-state'],
);

describe('FakeTracker', () => {
  it('records activities per session', async () => {
    const t = new FakeTracker();
    t.addIssue({ identifier: 'REL-1', title: 'T' });
    const s = await t.ensureSession('REL-1');
    await t.activity(s, { type: 'thought', body: 'x' });
    await t.activity('other', { type: 'thought', body: 'y' });
    expect(t.activities(s)).toEqual([{ type: 'thought', body: 'x' }]);
  });

  it('names the unknown issue in its error', async () => {
    await expect(new FakeTracker().getIssue('NOPE-1')).rejects.toThrow('unknown issue NOPE-1');
  });
});
