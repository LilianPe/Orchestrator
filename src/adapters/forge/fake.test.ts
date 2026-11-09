import { describe, expect, it } from 'vitest';
import { describeForgeContract } from '../../../test/contracts/forge.contract.js';
import { FakeForge } from './fake.js';

describeForgeContract('FakeForge', () => {
  const forge = new FakeForge();
  const unresolved = [{ author: 'alice', body: 'src/a.ts:3 — renommer', at: 1_000, source: 'review' as const }];
  forge.setPr('factory/rel-1-x', { number: 7, url: 'https://github.test/pr/7', state: 'OPEN', checks: 'fail', failedChecks: ['test'] });
  forge.setPr('factory/rel-3-z', { number: 9, url: 'https://github.test/pr/9', state: 'OPEN', checks: 'none', failedChecks: [] });
  forge.setReviewComments(7, unresolved);
  const unreachable = new FakeForge();
  unreachable.offline = true;
  return { forge, repoPath: '/repo', missingBranch: 'factory/rel-404', pr: { branch: 'factory/rel-1-x', number: 7 }, unresolved, unreachable, noChecks: 'factory/rel-3-z' };
});

describe('FakeForge.setExclusiveLabel (ORC-198)', () => {
  const GROUP = ['revue: requise', 'revue: échantillon', 'revue: auto'];

  it("keeps one label of the group, the PR's others untouched, and writes nothing for the state already there", async () => {
    const forge = new FakeForge();
    forge.setPrLabels(7, ['bug', 'revue: auto']);
    await forge.setExclusiveLabel('/repo', 7, 'revue: requise', GROUP);
    expect(forge.labelsOf(7)).toEqual(['bug', 'revue: requise']);
    const writes = forge.labelWrites;
    await forge.setExclusiveLabel('/repo', 7, 'revue: requise', GROUP);
    expect(forge.labelWrites).toBe(writes);
  });
});
