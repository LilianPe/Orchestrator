import { BLOCK_CAUSES, blockCause, type BlockCause } from '../core/block-cause.js';
import type { TicketMeasures } from '../core/measures.js';
import type { TicketState, TokenUsage } from '../core/types.js';
import type { QueueItem, RunRecord } from '../store/types.js';

const RECENT_DONE_MS = 7 * 24 * 60 * 60 * 1000;
const DONE_LIMIT = 20;

export interface FlowTicket {
  projectId: string;
  ticketId: string;
  title: string;
  prUrl?: string;
  updatedAt: number;
}

export interface WorkingRun extends FlowTicket {
  runId: string;
  /** The run's job: the engine has no other step yet (ORC-177). */
  step: string;
  /** The run has ended and its checks are running. */
  verifying: boolean;
  /** The ticket's active run: what Stop stops. */
  stoppable: boolean;
  durationMs: number;
  /** Of the ticket, over its attempts that ended: a run reports its usage when it ends (ORC-235). Null when none did. */
  tokens: TokenUsage | null;
  /** Finished attempts `tokens` leaves out: they reported no usage. */
  attemptsWithoutTokens: number;
  /** Of the ticket, in dollars: what exists when no attempt reported tokens (ORC-216). */
  costUsd: number;
}

/**
 * The home page of the dashboard (ORC-297): what waits for a human, what the factory is doing, what is
 * finished. Fields are picked one by one: a run's record holds its token, and a queue item what it carries.
 */
export interface Flow {
  needsYou: {
    blocked: { cause: BlockCause; tickets: (FlowTicket & { reason: string })[] }[];
    humanReview: FlowTicket[];
    /** The merge gate of a workflow that still declares `ready`; the spec gate comes with ORC-212. */
    gates: (FlowTicket & { gate: 'merge' })[];
  };
  working: WorkingRun[];
  queued: { projectId: string; ticketId: string; title: string; job: string }[];
  done: FlowTicket[];
  /** Unfinished tickets in none of the above (no run, nothing asked of a human): still reachable. */
  others: FlowTicket[];
}

export interface FlowInput {
  now: number;
  tickets: TicketState[];
  running: RunRecord[];
  /** The runs of `TicketState.verifyingRunId`. */
  verifying: RunRecord[];
  queue: QueueItem[];
  /** By `flowKey`: what the measures say of the tickets at work; a ticket without an entry has no tokens to show. */
  measures: ReadonlyMap<string, Pick<TicketMeasures, 'tokens' | 'attemptsWithoutTokens'>>;
}

export const flowKey = (r: { projectId: string; ticketId: string }): string => `${r.projectId}/${r.ticketId}`;

const flowTicket = (t: TicketState): FlowTicket => ({
  projectId: t.projectId,
  ticketId: t.ticketId,
  title: t.title,
  ...(t.prUrl === undefined ? {} : { prUrl: t.prUrl }),
  updatedAt: t.updatedAt,
});

const oldestFirst = (a: TicketState, b: TicketState) => a.updatedAt - b.updatedAt;

export function buildFlow({ now, tickets, running, verifying, queue, measures }: FlowInput): Flow {
  const byKey = new Map(tickets.map((t) => [flowKey(t), t]));
  const atWork = new Set([...running, ...verifying].map(flowKey));
  const inQueue = new Set(queue.map(flowKey));
  const waiting = tickets.filter((t) => !t.blocked && !atWork.has(flowKey(t))).sort(oldestFirst);

  const blocked = tickets.filter((t) => t.blocked).sort(oldestFirst);
  const causes = BLOCK_CAUSES.flatMap((cause) => {
    const of = blocked.filter((t) => blockCause(t.blockReason) === cause);
    return of.length ? [{ cause, tickets: of.map((t) => ({ ...flowTicket(t), reason: t.blockReason ?? '' })) }] : [];
  });

  const humanReview = waiting.filter((t) => t.logical === 'human_review');
  const gates = waiting.filter((t) => t.logical === 'ready');
  const done = tickets
    .filter((t) => t.logical === 'done' && !t.blocked && now - t.updatedAt <= RECENT_DONE_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, DONE_LIMIT);

  const shown = new Set([...humanReview, ...gates, ...done].map(flowKey));
  const others = waiting.filter((t) => t.logical !== 'done' && !shown.has(flowKey(t)) && !inQueue.has(flowKey(t))).sort((a, b) => b.updatedAt - a.updatedAt);

  const runningByTicket = (key: string) => running.filter((r) => flowKey(r) === key).length;
  const workingRun = (run: RunRecord, isVerifying: boolean): WorkingRun => {
    const key = flowKey(run);
    const ticket = byKey.get(key);
    const measure = measures.get(key);
    return {
      projectId: run.projectId,
      ticketId: run.ticketId,
      title: ticket?.title ?? '',
      updatedAt: ticket?.updatedAt ?? run.startedAt,
      ...(ticket?.prUrl === undefined ? {} : { prUrl: ticket.prUrl }),
      runId: run.id,
      step: run.job,
      verifying: isVerifying,
      stoppable: !isVerifying && ticket?.activeRunId === run.id,
      durationMs: now - run.startedAt,
      tokens: measure?.tokens ?? null,
      attemptsWithoutTokens: measure ? Math.max(0, measure.attemptsWithoutTokens - runningByTicket(key)) : 0,
      costUsd: ticket?.costUsd ?? 0,
    };
  };
  const runningIds = new Set(running.map((r) => r.id));
  const working = [...running.map((r) => workingRun(r, false)), ...verifying.filter((r) => !runningIds.has(r.id)).map((r) => workingRun(r, true))].sort(
    (a, b) => b.durationMs - a.durationMs,
  );

  return {
    needsYou: { blocked: causes, humanReview: humanReview.map(flowTicket), gates: gates.map((t) => ({ ...flowTicket(t), gate: 'merge' as const })) },
    working,
    queued: queue.map((q) => ({ projectId: q.projectId, ticketId: q.ticketId, title: byKey.get(flowKey(q))?.title ?? '', job: q.job })),
    done: done.map(flowTicket),
    others: others.map(flowTicket),
  };
}
