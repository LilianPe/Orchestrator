import type { Clock } from '../../../core/clock.js';
import type { ProjectRuntime } from '../../../core/orchestrator.js';
import type { LogicalState, RelaisEvent } from '../../../core/types.js';
import type { Store } from '../../../store/types.js';
import type { Tracker } from '../types.js';

export interface ReconcileDeps {
  tracker: Pick<Tracker, 'listDelegated'>;
  store: Store;
  projects: ProjectRuntime[];
  submit: (e: RelaisEvent) => void;
  clock: Clock;
  log: (m: string) => void;
}

export async function reconcileOnce(d: ReconcileDeps): Promise<void> {
  for (const p of d.projects) {
    try {
      const issues = await d.tracker.listDelegated(p.teamKey);
      const at = d.clock.now();
      const delegated = new Set(issues.map((i) => i.identifier));
      for (const issue of issues) {
        const t = d.store.getTicket(p.id, issue.identifier);
        if (!t) {
          d.submit({ id: `reconcile:delegated:${issue.identifier}`, type: 'ticket.delegated', at, projectId: p.id, ticketId: issue.identifier, payload: {} });
          continue;
        }
        const to = (Object.entries(p.workflow.states) as [LogicalState, string][]).find(([, n]) => n === issue.stateName)?.[0];
        if (to && to !== t.logical && !d.store.isEcho(`state:${issue.identifier}:${issue.stateName}`, at)) {
          d.submit({
            id: `reconcile:moved:${issue.identifier}:${issue.stateName}:${t.updatedAt}`,
            type: 'ticket.moved',
            at,
            projectId: p.id,
            ticketId: issue.identifier,
            payload: { from: t.logical, to },
          });
        }
      }
      for (const t of d.store.listTickets()) {
        if (t.projectId !== p.id || !t.activeRunId || delegated.has(t.ticketId)) continue;
        d.submit({ id: `reconcile:undelegated:${t.ticketId}:${t.activeRunId}`, type: 'session.stopped', at, projectId: p.id, ticketId: t.ticketId, payload: {} });
      }
    } catch (err) {
      d.log(`reconcile ${p.id}: ${(err as Error).message}`);
    }
  }
}

export class Reconciler {
  private handle: NodeJS.Timeout | undefined;
  constructor(private d: ReconcileDeps) {}
  start(intervalMs = 30_000): void {
    this.stop();
    void reconcileOnce(this.d);
    this.handle = setInterval(() => void reconcileOnce(this.d), intervalMs);
  }
  stop(): void {
    if (this.handle) clearInterval(this.handle);
    this.handle = undefined;
  }
}
