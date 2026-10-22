import type { Clock } from '../../../core/clock.js';
import { logicalFromName, type ProjectRuntime } from '../../../core/orchestrator.js';
import { TRUSTED, type FactoryEvent } from '../../../core/types.js';
import type { Store } from '../../../store/types.js';
import type { Tracker } from '../types.js';

export interface ReconcileDeps {
  tracker: Pick<Tracker, 'listDelegated'>;
  store: Store;
  projects: ProjectRuntime[];
  submit: (e: FactoryEvent) => void;
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
        if (!t || !t.delegated) {
          const id = t ? `reconcile:delegated:${issue.identifier}:${t.updatedAt}` : `reconcile:delegated:${issue.identifier}`;
          const logical = logicalFromName(p.workflow.states, issue.stateName) ?? 'todo';
          // An untracked ticket: the snapshot spares the orchestrator a second read of the tracker.
          const payload = t ? {} : { issue: { title: issue.title, logical, priority: issue.priority } };
          d.submit({ ...TRUSTED, id, type: 'ticket.delegated', at, projectId: p.id, ticketId: issue.identifier, payload });
          continue;
        }
        const to = logicalFromName(p.workflow.states, issue.stateName);
        if (to && to !== t.logical && !d.store.isEcho(`state:${issue.identifier}:${issue.stateName}`, at)) {
          d.submit({
            ...TRUSTED,
            id: `reconcile:moved:${issue.identifier}:${issue.stateName}:${t.updatedAt}`,
            type: 'status.changed',
            at,
            projectId: p.id,
            ticketId: issue.identifier,
            payload: { from: t.logical, to },
          });
        }
      }
      for (const t of d.store.listTickets()) {
        if (t.projectId !== p.id || delegated.has(t.ticketId)) continue;
        if (t.activeRunId) {
          d.submit({ ...TRUSTED, id: `reconcile:undelegated:${t.ticketId}:${t.activeRunId}`, type: 'session.stopped', at, projectId: p.id, ticketId: t.ticketId, payload: {} });
        }
        if (t.delegated && t.logical !== 'done') {
          d.submit({ ...TRUSTED, id: `reconcile:undelegated-flag:${t.ticketId}:${t.updatedAt}`, type: 'ticket.undelegated', at, projectId: p.id, ticketId: t.ticketId, payload: {} });
        }
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
