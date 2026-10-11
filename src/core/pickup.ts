import type { TrackerIssue } from '../adapters/tracker/types.js';
import type { WorkspaceManager } from '../adapters/workspace/types.js';
import type { PickupCheck } from '../config/workflow-schema.js';

export async function pickupFailures(
  checks: PickupCheck[],
  issue: TrackerIssue,
  repoPath: string,
  workspaces: WorkspaceManager,
): Promise<string[]> {
  const out: string[] = [];
  const prefix = `relais/${issue.identifier.toLowerCase()}-`;
  for (const check of checks) {
    if (check === 'has_description' && issue.description.trim().length < 30) {
      out.push('La description fait moins de 30 caractères.');
    }
    if (check === 'not_started' && (await workspaces.remoteBranchExists(repoPath, prefix))) {
      out.push(`Une branche ${prefix}… existe déjà sur origin.`);
    }
    if (check === 'has_acceptance_criteria' && !/(crit[eè]res? d['’]acceptation|acceptance criteria)/i.test(issue.description)) {
      out.push("La description ne contient pas de critères d'acceptation.");
    }
  }
  return out;
}
