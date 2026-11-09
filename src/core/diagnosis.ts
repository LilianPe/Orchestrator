import type { Store } from '../store/types.js';
import type { BlockKind } from './block-cause.js';
import type { LogicalState, QueueName } from './types.js';

/** A failed inbox row that holds its ticket's later rows in the worker's memory (`Worker.held`), retried with a backoff. */
export interface HeldRow {
  projectId: string;
  eventId: string;
  type: string;
  error: string;
  /** Failed processings so far, in this process. */
  attempts: number;
  /** When its next try is due; absent once the factory is stopping. */
  retryAt?: number;
  /** Later rows of its ticket waiting behind it. */
  behind: number;
}

/** Why a ticket is stuck, from the store and the worker's memory (ORC-350): `GET /tickets/:id/diagnosis`. */
export interface TicketDiagnosis {
  projectId: string;
  ticketId: string;
  /** Whether the store tracks the ticket: a ticket whose first event fails is known by its held row alone. */
  tracked: boolean;
  state?: { logical: LogicalState; blocked: boolean; blockKind?: BlockKind; blockReason?: string };
  run?: { id: string; job: string; status: string; startedAt: number };
  heldRow?: HeldRow;
  lastFailedEffect?: { id: string; kind: string; status: string; attempts: number; error: string };
  deadLetters: { eventId: string; type: string; error: string; failures: number }[];
  queue: { queue: QueueName; job: string; position: number; enqueuedAt: number; failedStarts?: number }[];
  /** The above in sentences, the first the likeliest cause. */
  reasons: string[];
}

export interface DiagnosisDeps {
  store: Store;
  /** The rows this process's worker holds for a ticket (`Orchestrator.heldRows`); none without it. */
  held?: (ticketId: string) => HeldRow[];
  /** Masks the secrets an error or a block reason may carry (a token in a URL, a key): every text passes through it. */
  mask: (text: string) => string;
}

const times = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The diagnosis of `ticketId` in each project that knows it (`projectId`: in that one alone): its state and block, its
 * active run, the row the worker holds, its last failed effect, its open dead letters and its place in the queues.
 * Empty when neither the store nor the worker knows it.
 */
export async function ticketDiagnoses(d: DiagnosisDeps, ticketId: string, projectId?: string): Promise<TicketDiagnosis[]> {
  const { store, mask } = d;
  const mine = <T extends { projectId: string }>(xs: T[]) => xs.filter((x) => projectId === undefined || x.projectId === projectId);
  const [tickets, letters, queue] = await Promise.all([store.listTickets(), store.deadLetters(ticketId), store.listQueue()]);
  const tracked = mine(tickets.filter((t) => t.ticketId === ticketId));
  const held = mine(d.held?.(ticketId) ?? []);
  const open = mine(letters.filter((l) => l.status === 'open'));
  const projects = [...new Set([...tracked, ...held, ...open].map((x) => x.projectId))];
  return Promise.all(
    projects.map(async (pid): Promise<TicketDiagnosis> => {
      const t = tracked.find((x) => x.projectId === pid);
      const [effects, runs] = await Promise.all([store.listEffects(pid, ticketId), store.ticketRuns(pid, ticketId)]);
      // A row done keeps the error of a failed try: only one still failing, or given up, holds the ticket.
      const failed = effects.filter((e) => e.status !== 'done' && e.error !== undefined).at(-1);
      const run = runs.filter((r) => r.status === 'running').at(-1);
      const heldRow = held.find((h) => h.projectId === pid);
      const reasons: string[] = [];
      const out: TicketDiagnosis = { projectId: pid, ticketId, tracked: t !== undefined, deadLetters: [], queue: [], reasons };
      if (t) {
        out.state = { logical: t.logical, blocked: t.blocked, ...(t.blockKind ? { blockKind: t.blockKind } : {}), ...(t.blockReason ? { blockReason: mask(t.blockReason) } : {}) };
        if (t.blocked) reasons.push(`blocked${t.blockKind ? ` (${t.blockKind})` : ''}: ${out.state.blockReason ?? 'no reason given'}`);
      }
      if (run) out.run = { id: run.id, job: run.job, status: run.status, startedAt: run.startedAt };
      if (heldRow) {
        out.heldRow = { ...heldRow, error: mask(heldRow.error) };
        reasons.push(`event ${heldRow.eventId} (${heldRow.type}) failed ${times(heldRow.attempts, 'time')}, its ticket held behind it: ${out.heldRow.error}`);
      }
      if (failed) {
        out.lastFailedEffect = { id: failed.id, kind: failed.effect.kind, status: failed.status, attempts: failed.attempts, error: mask(failed.error!) };
        const how = failed.status === 'pending' ? `failed ${times(failed.attempts, 'time')}, retried` : `${failed.status} after ${times(failed.attempts, 'attempt')}`;
        reasons.push(`effect ${failed.id} (${failed.effect.kind}) ${how}: ${out.lastFailedEffect.error}`);
      }
      for (const l of open.filter((x) => x.projectId === pid)) {
        const letter = { eventId: l.eventId, type: l.event.type, error: mask(l.error), failures: l.failures };
        out.deadLetters.push(letter);
        reasons.push(`event ${letter.eventId} (${letter.type}) set aside: ${letter.error} (repair: factory run repair ${ticketId})`);
      }
      for (const q of ['dev', 'questions'] as const) {
        const lane = queue.filter((i) => i.queue === q);
        lane.forEach((i, n) => {
          if (i.projectId !== pid || i.ticketId !== ticketId) return;
          out.queue.push({ queue: q, job: i.job, position: n + 1, enqueuedAt: i.enqueuedAt, ...(i.failedStarts ? { failedStarts: i.failedStarts } : {}) });
          reasons.push(`queued for ${i.job} (${q}), position ${n + 1}`);
        });
      }
      return out;
    }),
  );
}
