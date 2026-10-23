import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../../config/load-workflow.js';
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
      states: ['In Progress', 'Human Review'],
      delegation: { teamKey: 'REL', delegated: 'REL-1', notDelegated: 'REL-2' },
    };
  },
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

  it('knows the states of the standard workflow by default', () => {
    const { states } = loadWorkflow({ packDir: join(import.meta.dirname, '../../../packs/standard') });
    expect([...new FakeTracker().statesOf('REL')].sort()).toEqual(Object.values(states).sort());
  });

  it('rejects a state outside the team catalogue, in moveTo as in addIssue, and names it', async () => {
    const t = new FakeTracker(['Todo', 'Doing']);
    t.addIssue({ identifier: 'REL-1' });
    await expect(t.moveTo('REL-1', 'Human Review')).rejects.toThrow('unknown state Human Review for team REL');
    expect(() => t.addIssue({ identifier: 'REL-2', stateName: 'Blocked' })).toThrow('unknown state Blocked for team REL');
    await t.moveTo('REL-1', 'Doing');
    expect((await t.getIssue('REL-1')).stateName).toBe('Doing');
  });

  it('lets a scenario declare its own catalogue for one team', async () => {
    const t = new FakeTracker(['Todo']);
    t.setStates('OPS', ['Todo', 'Blocked']);
    t.addIssue({ identifier: 'OPS-1', stateName: 'Blocked' });
    t.addIssue({ identifier: 'REL-1' });
    await expect(t.moveTo('REL-1', 'Blocked')).rejects.toThrow('unknown state Blocked for team REL');
  });

  it('names the unknown issue in its error', async () => {
    await expect(new FakeTracker().getIssue('NOPE-1')).rejects.toThrow('unknown issue NOPE-1');
  });
});
