import type { Forge } from '../adapters/forge/types.js';
import type { Tracker, TrackerIssue } from '../adapters/tracker/types.js';
import type { PickupCheck } from '../config/workflow-schema.js';
import { formatActiveWork, ownBranchPrefix, ownWork } from './intake-checks.js';
import type { Blocker } from './types.js';

/**
 * The tickets `issue` is « blocked by » that are not done (ORC-363): an input of the guard before In Progress. Done is Linear's
 * `completed` type; a cancelled blocker delivered nothing, so it still holds: the human takes the relation off to go on.
 */
export const openBlockers = (issue: TrackerIssue): Blocker[] =>
  (issue.blockedBy ?? []).filter((b) => b.stateType !== 'completed').map(({ identifier, stateName }) => ({ identifier, stateName }));

/** The checks of the ticket's text. `not_started` is the duplicate search's (ORC-207): `searchDuplicates`, `notStarted`. */
export function pickupFailures(checks: PickupCheck[], issue: TrackerIssue): string[] {
  const out: string[] = [];
  for (const check of checks) {
    if (check === 'has_description' && issue.description.trim().length < 30) {
      out.push('The description is shorter than 30 characters.');
    }
    if (check === 'has_acceptance_criteria' && !/(crit[eè]res? d['’]acceptation|acceptance criteria)/i.test(issue.description)) {
      out.push('The description has no acceptance criteria.');
    }
  }
  return out;
}

/**
 * `intake`'s duplicate search (ORC-207), at its launch: every open PR with its files and every branch of the repository,
 * through the forge, and the tickets the tracker finds close to its title. `own`, the ticket's own work on the forge (the
 * `not_started` check), is a failed check; `activeWork`, what intake reads to judge the rest. A read that fails throws:
 * no intake starts that would see no duplicate for want of a list.
 */
export async function searchDuplicates(
  issue: TrackerIssue,
  repoPath: string,
  d: { forge: Pick<Forge, 'openPrs' | 'branches'>; tracker: Pick<Tracker, 'search'> },
): Promise<{ own: string | undefined; activeWork: string }> {
  const [prs, branches, tickets] = await Promise.all([d.forge.openPrs(repoPath), d.forge.branches(repoPath), d.tracker.search(issue.title, issue.teamKey)]);
  return { own: ownWork(issue.identifier, branches, prs), activeWork: formatActiveWork(issue.identifier, { prs, branches, tickets }) };
}

/** The `not_started` check of a pickup job without intake: a branch of the ticket's own already on the forge (ORC-207). */
export async function notStarted(issue: TrackerIssue, repoPath: string, forge: Pick<Forge, 'branches'>): Promise<string | undefined> {
  return ownWork(issue.identifier, await forge.branches(repoPath, ownBranchPrefix(issue.identifier)), []);
}
