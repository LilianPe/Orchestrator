import type { Forge, OpenPr } from '../adapters/forge/types.js';
import type { Tracker, TrackerIssue } from '../adapters/tracker/types.js';
import type { PickupCheck } from '../config/workflow-schema.js';
import { formatActiveWork } from './intake-checks.js';
import type { Blocker } from './types.js';

/**
 * The tickets `issue` is « blocked by » that are not done (ORC-363): an input of the guard before In Progress. Done is Linear's
 * `completed` type; a cancelled blocker delivered nothing, so it still holds: the human takes the relation off to go on.
 */
export const openBlockers = (issue: TrackerIssue): Blocker[] =>
  (issue.blockedBy ?? []).filter((b) => b.stateType !== 'completed').map(({ identifier, stateName }) => ({ identifier, stateName }));

/**
 * The checks of `checks` that fail. `ownWork`: the ticket's own work already on the forge, as the duplicate search found it
 * (`ownWork` of intake-checks, ORC-207), or on origin for `factory plan`: the `not_started` failure when that check is listed.
 */
export function pickupFailures(checks: PickupCheck[], issue: TrackerIssue, ownWork?: string): string[] {
  const out: string[] = [];
  for (const check of checks) {
    if (check === 'has_description' && issue.description.trim().length < 30) {
      out.push('The description is shorter than 30 characters.');
    }
    if (check === 'not_started' && ownWork) out.push(ownWork);
    if (check === 'has_acceptance_criteria' && !/(crit[eè]res? d['’]acceptation|acceptance criteria)/i.test(issue.description)) {
      out.push('The description has no acceptance criteria.');
    }
  }
  return out;
}

/**
 * `intake`'s duplicate search (ORC-207), at its launch: every open PR with its files and the recent branches of the
 * repository, through the forge, and the tickets the tracker finds close to its title. `activeWork`, what intake reads to
 * judge them; `prs`, for `ownWork` to name the ticket's own PR. A read that fails throws: no intake starts that would
 * see no duplicate for want of a list.
 */
export async function searchDuplicates(
  issue: TrackerIssue,
  repoPath: string,
  d: { forge: Pick<Forge, 'openPrs' | 'recentBranches'>; tracker: Pick<Tracker, 'search'> },
): Promise<{ prs: OpenPr[]; activeWork: string }> {
  const [prs, branches, tickets] = await Promise.all([d.forge.openPrs(repoPath), d.forge.recentBranches(repoPath), d.tracker.search(issue.title, issue.teamKey)]);
  return { prs, activeWork: formatActiveWork(issue.identifier, { prs, branches, tickets }) };
}
