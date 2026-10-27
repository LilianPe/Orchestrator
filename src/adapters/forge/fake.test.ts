import { describeForgeContract } from '../../../test/contracts/forge.contract.js';
import { FakeForge } from './fake.js';

describeForgeContract('FakeForge', () => {
  const forge = new FakeForge();
  const unresolved = [{ author: 'alice', body: 'src/a.ts:3 — renommer', at: 1_000, source: 'review' as const }];
  forge.setPr('factory/rel-1-x', { number: 7, url: 'https://github.test/pr/7', state: 'OPEN', checks: 'fail', failedChecks: ['test'] });
  forge.setReviewComments(7, unresolved);
  const unreachable = new FakeForge();
  unreachable.offline = true;
  return { forge, repoPath: '/repo', missingBranch: 'factory/rel-404', pr: { branch: 'factory/rel-1-x', number: 7 }, unresolved, unreachable };
});
