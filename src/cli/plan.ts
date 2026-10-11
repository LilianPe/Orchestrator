import type { Tracker } from '../adapters/tracker/types.js';
import type { WorkspaceManager } from '../adapters/workspace/types.js';
import type { ProjectRuntime } from '../core/orchestrator.js';
import { pickupFailures } from '../core/pickup.js';
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
  for (const p of d.projects) {
    for (const issue of await d.tracker.listDelegated(p.teamKey)) {
      const known = d.store.getTicket(p.id, issue.identifier);
      if (known) {
        rows.push({ identifier: issue.identifier, title: issue.title, priority: issue.priority, status: 'déjà géré', reasons: [known.logical] });
        continue;
      }
      const reasons = await pickupFailures(p.workflow.tracker.pickup.checks, issue, p.repoPath, d.workspaces);
      rows.push({ identifier: issue.identifier, title: issue.title, priority: issue.priority, status: reasons.length ? 'pas pris' : 'pris', reasons });
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
