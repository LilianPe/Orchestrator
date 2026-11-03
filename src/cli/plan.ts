import type { Tracker } from '../adapters/tracker/types.js';
import type { WorkspaceManager } from '../adapters/workspace/types.js';
import type { ProjectRuntime } from '../core/orchestrator.js';
import { pickupFailures } from '../core/pickup.js';
import { REPO_LABEL } from '../core/routing.js';
import { routedIssues } from '../adapters/tracker/linear/reconcile.js';
import type { Store } from '../store/types.js';

export interface PlanRow {
  identifier: string;
  title: string;
  priority: number;
  status: 'pris' | 'déjà géré' | 'pas pris';
  reasons: string[];
}

const rank = (p: number) => (p === 0 ? 5 : p);

export async function planRows(d: {
  tracker: Pick<Tracker, 'listDelegated'>;
  store: Store;
  projects: ProjectRuntime[];
  workspaces: WorkspaceManager;
}): Promise<PlanRow[]> {
  const rows: PlanRow[] = [];
  // One read per team; each ticket listed once, under the project it goes to (ORC-291).
  for (const teamKey of new Set(d.projects.map((p) => p.teamKey))) {
    const members = d.projects.filter((p) => p.teamKey === teamKey);
    for (const issue of await routedIssues(d, teamKey, members.map((p) => p.id))) {
      const p = members.find((x) => x.id === issue.projectId)!;
      const row = { identifier: issue.identifier, title: issue.title, priority: issue.priority };
      const known = await d.store.getTicket(p.id, issue.identifier);
      if (known && !issue.repos) {
        rows.push({ ...row, status: 'déjà géré', reasons: [known.logical] });
        continue;
      }
      if (issue.repos) {
        rows.push({ ...row, status: 'pas pris', reasons: [`dépôt à préciser (${issue.repos.map((r) => `${REPO_LABEL}${r}`).join(', ')})`] });
        continue;
      }
      const reasons = await pickupFailures(p.workflow.tracker.pickup.checks, issue, p.repoPath, d.workspaces);
      rows.push({ ...row, status: reasons.length ? 'pas pris' : 'pris', reasons });
    }
  }
  return rows.sort((a, b) => rank(a.priority) - rank(b.priority));
}

export function formatPlan(rows: PlanRow[]): string {
  if (!rows.length) return 'Aucun ticket délégué à l’agent.';
  return rows
    .map((r) => `${r.identifier}  ${r.status}  ${r.title}${r.status === 'pas pris' ? ` — ${r.reasons.join(' ')}` : r.status === 'déjà géré' ? ` (${r.reasons[0]})` : ''}`)
    .join('\n');
}
