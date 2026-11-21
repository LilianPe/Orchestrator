import type { RepoPermissions } from '../roles/types.js';
import type { Forge } from './types.js';

export const NO_GITHUB_APP = 'no GitHub App: set github.app_id and github.private_key in factory.yml (or GH_APP_ID and GH_APP_KEY)';

const refuse = () => Promise.reject(new Error(NO_GITHUB_APP));

/**
 * The forge of a daemon without the GitHub App, since the `gh` fallback is gone (ORC-181): every read rejects, saying why, so a
 * PR, a check or a permission is never read as absent. Such a daemon publishes nothing either (`configProblems`).
 */
export class NoForge implements Forge, RepoPermissions {
  findPr: Forge['findPr'] = refuse;
  unresolvedReviewComments: Forge['unresolvedReviewComments'] = refuse;
  ciFailures: Forge['ciFailures'] = refuse;
  openPrs: Forge['openPrs'] = refuse;
  branches: Forge['branches'] = refuse;
  recentBranches: Forge['recentBranches'] = refuse;
  repoPermission: RepoPermissions['repoPermission'] = refuse;
}
