import type { Clock } from '../../../core/clock.js';
import { logicalFromName, type ProjectRuntime } from '../../../core/orchestrator.js';
import { TRUSTED, type FactoryEvent } from '../../../core/types.js';
import type { Store } from '../../../store/types.js';
import type { Tracker } from '../types.js';

export interface ReconcileDeps {
  tracker: Pick<Tracker, 'listDelegated'>;
  store: Store;
  projects: ProjectRuntime[];
  /** Writes the event to the inbox; awaited. */
  submit: (e: FactoryEvent) => unknown;
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
        const t = await d.store.getTicket(p.id, issue.identifier);
        if (!t || !t.delegated) {
          const id = t ? `reconcile:delegated:${issue.identifier}:${t.updatedAt}` : `reconcile:delegated:${issue.identifier}`;
          const logical = logicalFromName(p.workflow.states, issue.stateName) ?? 'todo';
          // An untracked ticket: the snapshot spares the orchestrator a second read of the tracker.
          const payload = t ? {} : { issue: { title: issue.title, logical, priority: issue.priority } };
          await d.submit({ ...TRUSTED, id, type: 'ticket.delegated', at, projectId: p.id, ticketId: issue.identifier, payload });
          continue;
        }
        const to = logicalFromName(p.workflow.states, issue.stateName);
        if (to && to !== t.logical && !(await d.store.isEcho(`state:${issue.identifier}:${issue.stateName}`, at))) {
          await d.submit({
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
      for (const t of await d.store.listTickets()) {
        if (t.projectId !== p.id || delegated.has(t.ticketId)) continue;
        if (t.activeRunId) {
          await d.submit({ ...TRUSTED, id: `reconcile:undelegated:${t.ticketId}:${t.activeRunId}`, type: 'session.stopped', at, projectId: p.id, ticketId: t.ticketId, payload: {} });
        }
        if (t.delegated && t.logical !== 'done') {
          await d.submit({ ...TRUSTED, id: `reconcile:undelegated-flag:${t.ticketId}:${t.updatedAt}`, type: 'ticket.undelegated', at, projectId: p.id, ticketId: t.ticketId, payload: {} });
        }
      }
    } catch (err) {
      d.log(`reconcile ${p.id}: ${(err as Error).message}`);
    }
  }
}

export class Reconciler {
  private handle: NodeJS.Timeout | undefined;
  /** One pass at a time: an interval that finds a pass still running skips its turn. */
  private passing: Promise<void> | undefined;
  constructor(private d: ReconcileDeps) {}
  private pass(): void {
    this.passing ??= reconcileOnce(this.d)
      .catch((e: Error) => this.d.log(`reconcile: ${e.message}`))
      .finally(() => (this.passing = undefined));
  }
  start(intervalMs = 30_000): void {
    if (this.handle) clearInterval(this.handle);
    this.pass();
    this.handle = setInterval(() => this.pass(), intervalMs);
  }
  /** No pass starts after it; resolves once the pass under way, if any, has finished. */
  async stop(): Promise<void> {
    if (this.handle) clearInterval(this.handle);
    this.handle = undefined;
    await this.passing;
  }
}
