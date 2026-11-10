import type { Tracker } from '../adapters/tracker/types.js';
import type { WorkspaceManager } from '../adapters/workspace/types.js';
import type { ProjectRuntime } from '../core/orchestrator.js';
import { DEFAULT_BRANCH_NAMING, isOwnBranch, type BranchNaming } from '../core/naming.js';
import { pickupFailures } from '../core/pickup.js';
import { repoLabel } from '../core/routing.js';
import { routedIssues } from '../adapters/tracker/linear/reconcile.js';
import type { Store } from '../store/types.js';

export interface PlanRow {
  identifier: string;
  title: string;
  priority: number;
  status: 'taken' | 'already handled' | 'not taken';
  reasons: string[];
}

const rank = (p: number) => (p === 0 ? 5 : p);

export async function planRows(d: {
  tracker: Pick<Tracker, 'listDelegated'>;
  store: Store;
  projects: ProjectRuntime[];
  workspaces: WorkspaceManager;
  /** The repository's branch naming (ORC-283), as the daemon reads it: the team's convention without it. */
  naming?: (project: ProjectRuntime) => Promise<BranchNaming>;
}): Promise<PlanRow[]> {
  const rows: PlanRow[] = [];
  // One read per team; each ticket listed once, under the project it goes to (ORC-291).
  for (const teamKey of new Set(d.projects.map((p) => p.teamKey))) {
    const members = d.projects.filter((p) => p.teamKey === teamKey);
    for (const issue of await routedIssues(d, teamKey, members.map((p) => p.id))) {
      const p = members.find((x) => x.id === issue.projectId)!;
      const row = { identifier: issue.identifier, title: issue.title, priority: issue.priority };
      if (issue.repos) {
        rows.push({ ...row, status: 'not taken', reasons: [`repository to specify (${issue.repos.map(repoLabel).join(', ')})`] });
        continue;
      }
      const known = await d.store.getTicket(p.id, issue.identifier);
      if (known) {
        rows.push({ ...row, status: 'already handled', reasons: [known.logical] });
        continue;
      }
      const checks = p.workflow.tracker.pickup.checks;
      // A preview: the daemon reads the ticket's own work on the forge (ORC-207), the command on origin, which needs no GitHub App.
      const naming = checks.includes('not_started') ? ((await d.naming?.(p)) ?? DEFAULT_BRANCH_NAMING) : undefined;
      const own = naming && (await d.workspaces.remoteBranchExists(p.repoPath, (name) => isOwnBranch(issue.identifier, name, naming))) ? `A branch of ${issue.identifier} already exists on origin.` : undefined;
      const reasons = pickupFailures(checks, issue, own);
      rows.push({ ...row, status: reasons.length ? 'not taken' : 'taken', reasons });
    }
  }
  return rows.sort((a, b) => rank(a.priority) - rank(b.priority));
}

export function formatPlan(rows: PlanRow[]): string {
  if (!rows.length) return 'No ticket delegated to the agent.';
  return rows
    .map((r) => `${r.identifier}  ${r.status}  ${r.title}${r.status === 'not taken' ? ` — ${r.reasons.join(' ')}` : r.status === 'already handled' ? ` (${r.reasons[0]})` : ''}`)
    .join('\n');
}
