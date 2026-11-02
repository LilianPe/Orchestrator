import type { Clock } from '../../../core/clock.js';
import { logicalFromName, type ProjectRuntime } from '../../../core/orchestrator.js';
import { SCHEMA_VERSION, TRUSTED, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from '../../../core/types.js';
import type { Store } from '../../../store/types.js';
import { labelEchoKey, stateEchoKey, type Tracker, type TrackerIssue } from '../types.js';
import { knownLabels, labelChanges, recordLabels, type Serial } from './labels.js';

export interface ReconcileDeps {
  tracker: Pick<Tracker, 'listDelegated' | 'getIssue'>;
  store: Store;
  projects: ProjectRuntime[];
  /** Writes the event to the inbox; awaited. */
  submit: (e: FactoryEvent) => unknown;
  clock: Clock;
  log: (m: string) => void;
  /** The webhook's turn, shared around the known labels (ORC-185), so one change is not reported by both. */
  serial?: Serial;
}

/**
 * A delegation or a move the reconciliation finds has no signed actor: nobody the factory can name
 * did it (an integration may have), so it is untrusted, as the webhook marks a change without a user
 * actor (ORC-160). Stops stay trusted: they only stop work.
 */
const UNSIGNED = { schemaVersion: SCHEMA_VERSION, taint: 'untrusted' } as const;

/** What one pass of one project writes: every event at the pass's time, under the ticket's project. */
type Emit = <T extends EventType>(t: { ticketId: string }, base: typeof UNSIGNED | typeof TRUSTED, id: string, type: T, payload: EventPayloads[T]) => Promise<unknown>;

/** A move to a status of the workflow the factory has not recorded, and did not make itself: unsigned, so it never merges. */
async function catchUpMove(d: ReconcileDeps, emit: Emit, p: ProjectRuntime, t: TicketState, stateName: string, at: number): Promise<void> {
  const to = logicalFromName(p.workflow.states, stateName);
  if (!to || to === t.logical || (await d.store.isEcho(stateEchoKey(t.ticketId, stateName), at))) return;
  await emit(t, UNSIGNED, `reconcile:moved:${t.ticketId}:${stateName}:${t.updatedAt}`, 'status.changed', { from: t.logical, to });
}

/** The label changes of a delegated ticket since the factory last read its labels; the first reading only records them. */
async function catchUpLabels(d: ReconcileDeps, emit: Emit, projectId: string, issue: TrackerIssue, t: TicketState, at: number): Promise<void> {
  const read = issue.updatedAt ?? 0;
  const known = await knownLabels(d.store, projectId, issue.identifier);
  // A webhook recorded a newer state of the issue than this pass read: it is the one to keep.
  if (known && known.at > read) return;
  const changes = known ? labelChanges(known.labels, issue.labels) : [];
  if (known && known.at === read && !changes.length) return;
  for (const c of changes) {
    // The factory's own write, whose webhook has not come yet: no human change.
    if (await d.store.isEcho(labelEchoKey(issue.identifier, c.label, c.change), at)) continue;
    // Keyed by Linear's version of the issue: a label put back later is a new change, not a duplicate.
    await emit(t, UNSIGNED, `reconcile:label:${issue.identifier}:${c.label}:${c.change}:${issue.updatedAt ?? t.updatedAt}`, 'label.changed', c);
  }
  await recordLabels(d.store, projectId, issue.identifier, issue.labels, read);
}

export async function reconcileOnce(d: ReconcileDeps): Promise<void> {
  // Every read and write of the known labels, in the webhook's turn.
  const inTurn: Serial = d.serial ?? ((task) => task());
  for (const p of d.projects) {
    try {
      const issues = await d.tracker.listDelegated(p.teamKey);
      const at = d.clock.now();
      const emit: Emit = async (t, base, id, type, payload) => d.submit({ ...base, id, type, at, projectId: p.id, ticketId: t.ticketId, payload } as FactoryEvent);
      const delegated = new Set(issues.map((i) => i.identifier));
      for (const issue of issues) {
        const t = await d.store.getTicket(p.id, issue.identifier);
        if (!t || !t.delegated) {
          const id = t ? `reconcile:delegated:${issue.identifier}:${t.updatedAt}` : `reconcile:delegated:${issue.identifier}`;
          const logical = logicalFromName(p.workflow.states, issue.stateName) ?? 'todo';
          // An untracked ticket: the snapshot spares the orchestrator a second read of the tracker.
          const payload = t ? {} : { issue: { title: issue.title, logical, priority: issue.priority } };
          await emit({ ticketId: issue.identifier }, UNSIGNED, id, 'ticket.delegated', payload);
          await inTurn(() => recordLabels(d.store, p.id, issue.identifier, issue.labels, issue.updatedAt ?? 0));
          continue;
        }
        await catchUpMove(d, emit, p, t, issue.stateName, at);
        await inTurn(() => catchUpLabels(d, emit, p.id, issue, t, at));
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
        // Still delegated and open: past the list's first page, nothing to catch up.
        if (issue.delegateId && issue.stateType !== 'completed' && issue.stateType !== 'canceled') continue;
        if (issue.stateType === 'completed') await catchUpMove(d, emit, p, t, issue.stateName, at);
        // A cancel stops the work of a delegated ticket itself (ORC-170); `decide` stops nothing on another.
        const cancel = issue.stateType === 'canceled' && t.delegated;
        if (cancel) {
          const to = logicalFromName(p.workflow.states, issue.stateName) ?? null;
          await emit(t, UNSIGNED, `reconcile:cancelled:${t.ticketId}:${issue.stateName}:${t.updatedAt}`, 'status.changed', { from: t.logical, to, cancelled: true });
        } else if (t.activeRunId) {
          await emit(t, TRUSTED, `reconcile:undelegated:${t.ticketId}:${t.activeRunId}`, 'session.stopped', {});
        }
        // A completed status the workflow does not call done moves nothing: cleared as before, or every pass reads it again.
        const unmapped = issue.stateType === 'completed' && logicalFromName(p.workflow.states, issue.stateName) !== 'done';
        // Cleared after a cancel too: no later pass reads the cancelled ticket again.
        if (undelegate && (cancel || unmapped || !issue.delegateId)) await emit(t, TRUSTED, `reconcile:undelegated-flag:${t.ticketId}:${t.updatedAt}`, 'ticket.undelegated', {});
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
