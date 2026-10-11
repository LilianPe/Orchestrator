import { describe, expect, it } from 'vitest';
import { FakeWorkspaces } from '../adapters/workspace/fake.js';
import type { TrackerIssue } from '../adapters/tracker/types.js';
import { pickupFailures } from './pickup.js';

const issue = (description: string): TrackerIssue => ({
  identifier: 'REL-3', title: 'T', description, url: 'u', stateName: 'Todo', stateType: 'unstarted', labels: [], teamKey: 'REL', priority: 0, createdAt: 0,
});

describe('pickupFailures', () => {
  it('returns no failure for a good ticket', async () => {
    const ws = new FakeWorkspaces();
    const d = 'Une description complète.\nCritères d’acceptation : export CSV.';
    expect(await pickupFailures(['has_description', 'not_started', 'has_acceptance_criteria'], issue(d), '/r', ws)).toEqual([]);
  });

  it('reports each failing check', async () => {
    const ws = new FakeWorkspaces();
    ws.remoteBranches.add('relais/rel-3-old');
    expect(await pickupFailures(['has_description', 'not_started', 'has_acceptance_criteria'], issue('court'), '/r', ws)).toEqual([
      'La description fait moins de 30 caractères.',
      'Une branche relais/rel-3-… existe déjà sur origin.',
      "La description ne contient pas de critères d'acceptation.",
    ]);
  });
});
