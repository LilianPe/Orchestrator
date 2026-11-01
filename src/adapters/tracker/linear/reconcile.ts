import type { Clock } from '../../../core/clock.js';
import { logicalFromName, type ProjectRuntime } from '../../../core/orchestrator.js';
import { SCHEMA_VERSION, TRUSTED, type FactoryEvent, type TicketState } from '../../../core/types.js';
import type { Store } from '../../../store/types.js';
import { labelEchoKey, type Tracker, type TrackerIssue } from '../types.js';
import { knownLabels, labelChanges, recordLabels } from './labels.js';

export interface ReconcileDeps {
  tracker: Pick<Tracker, 'listDelegated' | 'getIssue'>;
  store: Store;
  projects: ProjectRuntime[];
  /** Writes the event to the inbox; awaited. */
  submit: (e: FactoryEvent) => unknown;
  clock: Clock;
  log: (m: string) => void;
}

/**
 * A delegation or a move the reconciliation finds has no signed actor: nobody the factory can name
 * did it (an integration may have), so it is untrusted, as the webhook marks a change without a user
 * actor (ORC-160). Stops stay trusted: they only stop work.
 */
const UNSIGNED = { schemaVersion: SCHEMA_VERSION, taint: 'untrusted' } as const;

/** The label changes of a delegated ticket since the factory last read its labels; the first reading only records them. */
async function catchUpLabels(d: ReconcileDeps, projectId: string, issue: TrackerIssue, t: TicketState, at: number): Promise<void> {
  const read = issue.updatedAt ?? 0;
  const known = await knownLabels(d.store, projectId, issue.identifier);
  // A webhook recorded a newer state of the issue than this pass read: it is the one to keep.
  if (known && known.at > read) return;
  for (const c of known ? labelChanges(known.labels, issue.labels) : []) {
    // The factory's own write, whose webhook has not come yet: no human change.
    if (await d.store.isEcho(labelEchoKey(issue.identifier, c.label, c.change), at)) continue;
    await d.submit({
      ...UNSIGNED,
      id: `reconcile:label:${issue.identifier}:${c.label}:${c.change}:${t.updatedAt}`,
      type: 'label.changed',
      at,
      projectId,
      ticketId: issue.identifier,
      payload: c,
    });
  }
  await recordLabels(d.store, projectId, issue.identifier, issue.labels, read);
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
          await d.submit({ ...UNSIGNED, id, type: 'ticket.delegated', at, projectId: p.id, ticketId: issue.identifier, payload });
          await recordLabels(d.store, p.id, issue.identifier, issue.labels, issue.updatedAt ?? 0);
          continue;
        }
        const to = logicalFromName(p.workflow.states, issue.stateName);
        if (to && to !== t.logical && !(await d.store.isEcho(`state:${issue.identifier}:${issue.stateName}`, at))) {
          await d.submit({
            ...UNSIGNED,
            id: `reconcile:moved:${issue.identifier}:${issue.stateName}:${t.updatedAt}`,
            type: 'status.changed',
            at,
            projectId: p.id,
            ticketId: issue.identifier,
            payload: { from: t.logical, to },
          });
        }
        await catchUpLabels(d, p.id, issue, t, at);
      }
      for (const t of await d.store.listTickets()) {
        if (t.projectId !== p.id || delegated.has(t.ticketId)) continue;
        const undelegate = t.delegated && t.logical !== 'done';
        if (!t.activeRunId && !undelegate) continue;
        // Out of the list: done, cancelled or no longer delegated, which only the issue itself tells apart.
        let issue: TrackerIssue;
        try {
          issue = await d.tracker.getIssue(t.ticketId);
        } catch (err) {
          d.log(`reconcile ${t.ticketId}: ${(err as Error).message}`);
          continue;
        }
        const terminal = issue.stateType === 'completed' || issue.stateType === 'canceled';
        // Still delegated and open: past the list's first page, nothing to catch up.
        if (!terminal && issue.delegateId) continue;
        if (issue.stateType === 'completed') {
          // Unsigned, as the move a webhook would have reported: it never merges (only a signed human decides it).
          const to = logicalFromName(p.workflow.states, issue.stateName);
          if (to && to !== t.logical && !(await d.store.isEcho(`state:${t.ticketId}:${issue.stateName}`, at))) {
            await d.submit({ ...UNSIGNED, id: `reconcile:moved:${t.ticketId}:${issue.stateName}:${t.updatedAt}`, type: 'status.changed', at, projectId: p.id, ticketId: t.ticketId, payload: { from: t.logical, to } });
          }
        }
        // A cancel stops the work of a delegated ticket itself (ORC-170); `decide` stops nothing on another.
        const cancel = issue.stateType === 'canceled' && t.delegated;
        if (cancel) {
          await d.submit({
            ...UNSIGNED,
            id: `reconcile:cancelled:${t.ticketId}:${issue.stateName}:${t.updatedAt}`,
            type: 'status.changed',
            at,
            projectId: p.id,
            ticketId: t.ticketId,
            payload: { from: t.logical, to: logicalFromName(p.workflow.states, issue.stateName) ?? null, cancelled: true },
          });
        } else if (t.activeRunId) {
          await d.submit({ ...TRUSTED, id: `reconcile:undelegated:${t.ticketId}:${t.activeRunId}`, type: 'session.stopped', at, projectId: p.id, ticketId: t.ticketId, payload: {} });
        }
        // Cleared after a cancel too: no later pass reads the cancelled ticket again.
        if (undelegate && (cancel || !issue.delegateId)) {
          await d.submit({ ...TRUSTED, id: `reconcile:undelegated-flag:${t.ticketId}:${t.updatedAt}`, type: 'ticket.undelegated', at, projectId: p.id, ticketId: t.ticketId, payload: {} });
        }
      }
    } catch (err) {
      d.log(`reconcile ${p.id}: ${(err as Error).message}`);
    }
  }
}

/** One pass at a time over every project: the connection to Linear. The cadence is the reconciliation's timer in the store (ORC-185). */
export class Reconciler {
  private passing: Promise<void> | undefined;
  constructor(private d: ReconcileDeps) {}
  /** A pass now; one already under way is joined, not doubled. */
  once(): Promise<void> {
    this.passing ??= reconcileOnce(this.d)
      .catch((e: Error) => this.d.log(`reconcile: ${e.message}`))
      .finally(() => (this.passing = undefined));
    return this.passing;
  }
  /** Resolves once the pass under way, if any, has finished. */
  async stop(): Promise<void> {
    await this.passing;
  }
}
