import type { TrackerIssue } from '../adapters/tracker/types.js';
import type { WorkspaceManager } from '../adapters/workspace/types.js';
import type { PickupCheck } from '../config/workflow-schema.js';
import type { Blocker } from './types.js';

/**
 * The tickets `issue` is « blocked by » that are not done (ORC-363): an input of the guard before In Progress. Done is Linear's
 * `completed` type; a cancelled blocker delivered nothing, so it still holds: the human takes the relation off to go on.
 */
export const openBlockers = (issue: TrackerIssue): Blocker[] =>
  (issue.blockedBy ?? []).filter((b) => b.stateType !== 'completed').map(({ identifier, stateName }) => ({ identifier, stateName }));

export async function pickupFailures(
  checks: PickupCheck[],
  issue: TrackerIssue,
  repoPath: string,
  workspaces: WorkspaceManager,
): Promise<string[]> {
  const out: string[] = [];
  const prefix = `factory/${issue.identifier.toLowerCase()}-`;
  for (const check of checks) {
    if (check === 'has_description' && issue.description.trim().length < 30) {
      out.push('The description is shorter than 30 characters.');
    }
    if (check === 'not_started' && (await workspaces.remoteBranchExists(repoPath, prefix))) {
      out.push(`A branch ${prefix}… already exists on origin.`);
    }
    if (check === 'has_acceptance_criteria' && !/(crit[eè]res? d['’]acceptation|acceptance criteria)/i.test(issue.description)) {
      out.push('The description has no acceptance criteria.');
    }
  }
  return out;
}
