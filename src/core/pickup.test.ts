import { describe, expect, it } from 'vitest';
import { FakeForge } from '../adapters/forge/fake.js';
import { FakeTracker } from '../adapters/tracker/fake.js';
import type { TrackerIssue } from '../adapters/tracker/types.js';
import { ownWork } from './intake-checks.js';
import { pickupFailures, searchDuplicates } from './pickup.js';

const issue = (description: string): TrackerIssue => ({
  identifier: 'REL-3', title: 'Export CSV', description, url: 'u', stateName: 'Todo', stateType: 'unstarted', labels: [], teamKey: 'REL', priority: 0, createdAt: 0,
});

describe('pickupFailures', () => {
  it('returns no failure for a good ticket', () => {
    const d = 'Une description complète.\nCritères d’acceptation : export CSV.';
    expect(pickupFailures(['has_description', 'not_started', 'has_acceptance_criteria'], issue(d))).toEqual([]);
  });

  it('reports each failing check of the text; not_started is the duplicate search\'s (ORC-207)', () => {
    expect(pickupFailures(['has_description', 'not_started', 'has_acceptance_criteria'], issue('court'))).toEqual([
      'The description is shorter than 30 characters.',
      'The description has no acceptance criteria.',
    ]);
  });
});

describe('the duplicate search (ORC-207)', () => {
  it("not_started fails with the ticket's own work when it is listed, and only then", () => {
    const own = 'This ticket already has work on the forge: u (branch factory/rel-3-old).';
    const d = 'Une description complète.\nCritères d’acceptation : export CSV.';
    expect(pickupFailures(['has_description', 'not_started'], issue(d), own)).toEqual([own]);
    expect(pickupFailures(['has_description'], issue(d), own)).toEqual([]);
    expect(pickupFailures(['not_started'], issue(d))).toEqual([]);
  });

  it('reads the open PRs, the recent branches and the close tickets; its own work is named by its PR from them', async () => {
    const forge = new FakeForge();
    forge.openPullRequests = [
      { number: 5, url: 'https://github.test/pr/5', title: 'Mine', branch: 'factory/rel-3-export-csv', fork: false, files: ['a.ts'], filesTotal: 1 },
      { number: 6, url: 'https://github.test/pr/6', title: 'Theirs', branch: 'feat/x', fork: false, files: ['b.ts'], filesTotal: 1 },
    ];
    forge.branchNames = ['main', 'factory/rel-3-export-csv', 'feat/x'];
    const tracker = new FakeTracker();
    tracker.addIssue({ identifier: 'REL-3', title: 'Export CSV' });
    tracker.addIssue({ identifier: 'REL-8', title: 'Export CSV for invoices' });
    const found = await searchDuplicates(issue('x'), '/r', { forge, tracker });
    expect(ownWork('REL-3', await forge.branches('/r', 'factory/rel-3-'), found.prs)).toContain('https://github.test/pr/5');
    expect(found.activeWork).toContain('https://github.test/pr/6');
    expect(found.activeWork).toContain('`b.ts`');
    expect(found.activeWork).toContain('REL-8');
    expect(found.activeWork).not.toContain('pr/5');
  });

  it('a forge that does not answer throws: never an empty list', async () => {
    const forge = new FakeForge();
    forge.offline = true;
    await expect(searchDuplicates(issue('x'), '/r', { forge, tracker: new FakeTracker() })).rejects.toThrow(/unreachable/);
  });
});
