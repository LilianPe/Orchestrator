import type { Clock } from '../../../core/clock.js';
import { logicalFromName, type ProjectRuntime } from '../../../core/orchestrator.js';
import { isUnrouted, resolveRoute } from '../../../core/routing.js';
import { SCHEMA_VERSION, TRUSTED, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from '../../../core/types.js';
import type { Store } from '../../../store/types.js';
import { IssueNotFoundError, labelEchoKey, stateEchoKey, type Tracker, type TrackerIssue } from '../types.js';
import { knownLabels, labelChanges, recordLabels, type Serial } from './labels.js';

export interface ReconcileDeps {
  tracker: Pick<Tracker, 'listDelegated' | 'getIssue'>;
  store: Store;
  /** Every project: a team's tickets are shared out among its projects (ORC-291). */
  projects: ProjectRuntime[];
  /** Only this project's pass; the others still route. */
  only?: string;
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

/** What the store holds of a ticket in the team's projects; nothing to compare in a team of one. */
async function storedTickets(store: Store, team: string[], ticketId: string): Promise<TicketState[]> {
  if (team.length === 1) return [];
  return (await Promise.all(team.map((id) => store.getTicket(id, ticketId)))).filter((t) => t !== undefined);
}

/** A team's delegated issues, read once per pass, each with the project it goes to (sticky routing, ORC-291). */
export async function routedIssues(d: { tracker: Pick<Tracker, 'listDelegated'>; store: Store }, teamKey: string, team: string[]) {
  const issues = [];
  for (const issue of await d.tracker.listDelegated(teamKey)) {
    issues.push({ ...issue, ...resolveRoute(team, await storedTickets(d.store, team, issue.identifier), issue.labels)! });
  }
  return issues;
}

/** What one pass of one project writes: every event at the pass's time, under the ticket's project. */
type Emit = <T extends EventType>(t: { ticketId: string }, base: typeof UNSIGNED | typeof TRUSTED, id: string, type: T, payload: EventPayloads[T]) => Promise<unknown>;

/** A move to a status of the workflow the factory has not recorded, and did not make itself: unsigned, so it never merges. */
async function catchUpMove(d: ReconcileDeps, emit: Emit, p: ProjectRuntime, t: TicketState, stateName: string, at: number): Promise<void> {
  const to = logicalFromName(p.workflow.states, stateName);
  if (!to || to === t.logical || (await d.store.isEcho(stateEchoKey(t.ticketId, stateName), at))) return;
  await emit(t, UNSIGNED, `reconcile:moved:${p.id}:${t.ticketId}:${stateName}:${t.updatedAt}`, 'status.changed', { from: t.logical, to });
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
    await emit(t, UNSIGNED, `reconcile:label:${projectId}:${issue.identifier}:${c.label}:${c.change}:${issue.updatedAt ?? t.updatedAt}`, 'label.changed', c);
  }
  await recordLabels(d.store, projectId, issue.identifier, issue.labels, read);
}

export async function reconcileOnce(d: ReconcileDeps): Promise<void> {
  for (const teamKey of new Set(d.projects.map((p) => p.teamKey))) {
    const members = d.projects.filter((p) => p.teamKey === teamKey);
    const mine = members.filter((p) => !d.only || p.id === d.only);
    if (mine.length === 0) continue;
    const team = members.map((p) => p.id);
    let routed;
    try {
      routed = await routedIssues(d, teamKey, team);
    } catch (err) {
      for (const p of mine) d.log(`reconcile ${p.id}: ${(err as Error).message}`);
      continue;
    }
    for (const p of mine) {
      try {
        await reconcileProject(d, p, team, routed);
      } catch (err) {
        d.log(`reconcile ${p.id}: ${(err as Error).message}`);
      }
    }
  }
}

// Every id names the project: a ticket that goes to another repo is a new fact there, not a duplicate (ORC-291).
async function reconcileProject(d: ReconcileDeps, p: ProjectRuntime, team: string[], routed: Awaited<ReturnType<typeof routedIssues>>): Promise<void> {
  // Every read and write of the known labels, in the webhook's turn.
  const inTurn: Serial = d.serial ?? ((task) => task());
  const issues = routed.filter((i) => i.projectId === p.id);
  const listedElsewhere = new Set(routed.filter((i) => i.projectId !== p.id).map((i) => i.identifier));
  const at = d.clock.now();
  const emit: Emit = async (t, base, id, type, payload) => d.submit({ ...base, id, type, at, projectId: p.id, ticketId: t.ticketId, payload } as FactoryEvent);
  const clearDelegation = async (t: TicketState) => {
    // Its repo chosen, a ticket that waited here leaves its label to the issue's ticket there when that one is blocked.
    const others = isUnrouted(t) ? await Promise.all(team.filter((id) => id !== p.id).map((id) => d.store.getTicket(id, t.ticketId))) : [];
    await emit(t, TRUSTED, `reconcile:undelegated-flag:${p.id}:${t.ticketId}:${t.updatedAt}`, 'ticket.undelegated', others.some((o) => o?.blocked) ? { keepLabel: true } : {});
  };
  const delegated = new Set(issues.map((i) => i.identifier));
  for (const issue of issues) {
    const t = await d.store.getTicket(p.id, issue.identifier);
    if (!t || !t.delegated) {
      const { repos } = issue;
      // Unrouted, its own id: the delegation to its repo, once labelled, must not be taken for a duplicate.
      const kind = repos ? 'unrouted' : 'delegated';
      const id = t ? `reconcile:${kind}:${p.id}:${issue.identifier}:${t.updatedAt}` : `reconcile:${kind}:${p.id}:${issue.identifier}`;
      const logical = logicalFromName(p.workflow.states, issue.stateName) ?? 'todo';
      // An untracked ticket: the snapshot spares the orchestrator a second read of the tracker.
      const payload = { ...(t ? {} : { issue: { title: issue.title, logical, priority: issue.priority } }), ...(repos ? { repos } : {}) };
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
    // Another repo of the team has the ticket, listed or not: it leaves this one, nothing of the issue to read or to catch up here.
    if (listedElsewhere.has(t.ticketId) || resolveRoute(team, await storedTickets(d.store, team, t.ticketId))?.projectId !== p.id) {
      if (t.activeRunId) await emit(t, TRUSTED, `reconcile:undelegated:${p.id}:${t.ticketId}:${t.activeRunId}`, 'session.stopped', {});
      if (undelegate) await clearDelegation(t);
      continue;
    }
    // Out of the list: done, cancelled or no longer delegated, which only the issue itself tells apart.
    // Undefined: deleted in Linear, so no longer delegated, as before ORC-185.
    let issue: TrackerIssue | undefined;
    try {
      issue = await d.tracker.getIssue(t.ticketId);
    } catch (err) {
      d.log(`reconcile ${t.ticketId}: ${(err as Error).message}`);
      // A read error (network, Linear down) says nothing of the ticket: left as it is this pass.
      if (!(err instanceof IssueNotFoundError)) continue;
    }
    // Still delegated and open: past the list's first page, nothing to catch up.
    if (issue?.delegateId && issue.stateType !== 'completed' && issue.stateType !== 'canceled') continue;
    if (issue?.stateType === 'completed') await catchUpMove(d, emit, p, t, issue.stateName, at);
    // A cancel stops the work of a delegated ticket itself (ORC-170); `decide` stops nothing on another.
    const cancel = issue?.stateType === 'canceled' && t.delegated;
    if (issue && cancel) {
      const to = logicalFromName(p.workflow.states, issue.stateName) ?? null;
      await emit(t, UNSIGNED, `reconcile:cancelled:${p.id}:${t.ticketId}:${issue.stateName}:${t.updatedAt}`, 'status.changed', { from: t.logical, to, cancelled: true });
    } else if (t.activeRunId) {
      await emit(t, TRUSTED, `reconcile:undelegated:${p.id}:${t.ticketId}:${t.activeRunId}`, 'session.stopped', {});
    }
    // A completed status the workflow does not call done is no move to done: the delegation is cleared, as before, or every pass reads it again.
    const unmapped = issue?.stateType === 'completed' && logicalFromName(p.workflow.states, issue.stateName) !== 'done';
    // Cleared after a cancel too: no later pass reads the cancelled ticket again.
    if (undelegate && (cancel || unmapped || !issue?.delegateId)) await clearDelegation(t);
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
