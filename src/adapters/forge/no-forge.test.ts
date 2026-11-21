import { describe, expect, it } from 'vitest';
import { NO_GITHUB_APP, NoForge } from './no-forge.js';

describe('NoForge (ORC-181)', () => {
  it('reads nothing without the GitHub App, and every call says why', async () => {
    const forge = new NoForge();
    const calls = [
      forge.findPr('/r', 'b'),
      forge.unresolvedReviewComments('/r', 1),
      forge.openPrs('/r'),
      forge.branches('/r', 'factory/'),
      forge.recentBranches('/r'),
      forge.repoPermission('/r', 'dev'),
    ];
    for (const call of calls) await expect(call).rejects.toThrow(NO_GITHUB_APP);
    expect(NO_GITHUB_APP).toMatch(/GH_APP_ID and GH_APP_KEY/);
  });
});
