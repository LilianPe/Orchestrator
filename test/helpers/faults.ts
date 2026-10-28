/**
 * Fault injection along the chain (ORC-163), for the harness and for the chaos daemon. Nothing of it
 * lives in src/: each point is a wrapper of a port the orchestrator is built with (the store, the
 * fake adapters), so production code carries no hook and pays nothing.
 *
 * A `Faults` holds at most one planned fault: at the n-th hit of its point (matching its filter), it
 * throws a `FaultError` (`throw`), or kills the process it hit (`kill`: the harness's `mortal` dies,
 * as under `kill -9`, and the call never answers). It also keeps the ledger of the visible calls to
 * the fake tracker and runner, each one attributed to the outbox row being executed when it was made,
 * so that a visible effect done twice for one row shows up.
 */
import type { Runner, RunRequest } from '../../src/adapters/runner/types.js';
import type { Tracker } from '../../src/adapters/tracker/types.js';
import { exportJournal, replayJournal } from '../../src/runtime/replay.js';
import type { FactoryEvent } from '../../src/core/types.js';
import type { StoredEvent } from '../../src/core/upcast.js';
import type { DecisionRequest, OutboxRow, RunRecord, Store, TimerRecord } from '../../src/store/types.js';

/** The links of the chain where a fault can hit, in the order an event goes through them. */
export const FAULT_POINTS = [
  /** Before the inbox write of an event from outside (a webhook): the producer is not answered. */
  'webhook.accept',
  /** After an inbox row is committed, before its writer hears of it: the answer is lost. */
  'inbox.write',
  /** The decision transaction, before `decide` runs: nothing of it is written. */
  'decide.before',
  /** Inside the transaction, after `decide`, before the COMMIT: rolled back. */
  'decide.after',
  /** After the COMMIT, before the worker hears of it. */
  'decide.commit',
  /** After an outbox row is claimed (its lease committed), before its effect runs. */
  'outbox.claim',
  /** In an effect, before its external call (the fake tracker or runner). */
  'effect.before',
  /** After the external call acted, before the row is completed. */
  'effect.after',
  /** After the row's completion committed (its result `effect:<id>` in the inbox), before the executor hears of it. */
  'effect.complete',
  /** Before a due timer's firing transaction. */
  'timer.fire',
  /** After the firing committed (`timer.fired` in the inbox, the timer deleted). */
  'timer.fired',
  /** Before the inbox write of a run's or a check's result, which nobody resends. */
  'run.result',
] as const;
export type FaultPoint = (typeof FAULT_POINTS)[number];
export type FaultMode = 'throw' | 'kill';

/** What a point knows of the hit: the event, or the outbox row and its effect. */
export interface FaultInfo {
  /** The event id, the outbox row id, or the timer key. */
  id?: string;
  eventType?: string;
  /** The effect kind of the outbox row. */
  effect?: string;
  ticketId?: string;
  /** The external call (`comment`, `activity`, `moveTo`, `start`…) of an `effect.*` hit. */
  method?: string;
}

export interface FaultSpec {
  point: FaultPoint;
  mode: FaultMode;
  /** Only the hits it accepts count. */
  match?: (info: FaultInfo) => boolean;
  /** The hit that fires (1: the first one). */
  nth?: number;
}

export class FaultError extends Error {}

/** A visible call to the outside, attributed to the outbox row the process was executing then. */
export interface VisibleCall {
  /** Which life of the process made it (0 for the first one, then one more per restart). */
  life: number;
  method: string;
  ticketId?: string;
  /** The outbox row being executed, and its effect kind; absent outside an effect (a run's relay, a recovery notice). */
  row?: string;
  kind?: string;
  /** What tells two calls apart: the body, the run id… */
  detail: string;
}

/** The calls whose double would be seen in Linear or would launch a second agent; moves and labels are idempotent. */
const VISIBLE = new Set(['comment', 'activity', 'addExternalUrl', 'start']);

/** The tracker calls that act on Linear, and how each one names its ticket or session. */
const TRACKER_CALLS: Record<string, 'ticket' | 'session'> = {
  comment: 'ticket',
  setLabels: 'ticket',
  moveTo: 'ticket',
  activity: 'session',
  addExternalUrl: 'session',
};

const INTERNAL_EVENT = /^(attempt|check|effect|timer):/;
const RESULT_EVENT = /^(attempt|check):/;

/** A proxy over `target` answering `overrides` first, every other member bound to `target`. */
function override<T extends object>(target: T, overrides: Partial<Record<keyof T, unknown>>): T {
  return new Proxy(target, {
    get(t, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop as keyof T];
      const value: unknown = Reflect.get(t, prop, t);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value;
    },
  });
}

export class Faults {
  /** The fault once fired. */
  fired: (FaultInfo & { point: FaultPoint; mode: FaultMode }) | undefined;
  /** Resolves once a `kill` fault killed its process. */
  readonly killed: Promise<void>;
  /** Every visible call of every life, in order. */
  readonly calls: VisibleCall[] = [];
  private hits = 0;
  private lives = 0;
  private onKilled!: () => void;

  constructor(
    private spec?: FaultSpec,
    /** Where each visible call goes besides `calls`: the chaos daemon appends it to a file that outlives it. */
    private sink: (call: VisibleCall) => void = () => {},
  ) {
    this.killed = new Promise((resolve) => (this.onKilled = resolve));
  }

  private hit(point: FaultPoint, info: FaultInfo, kill: () => void): void {
    const spec = this.spec;
    if (!spec || this.fired || spec.point !== point || (spec.match && !spec.match(info))) return;
    if (++this.hits < (spec.nth ?? 1)) return;
    this.fired = { ...info, point, mode: spec.mode };
    if (spec.mode === 'kill') {
      kill();
      this.onKilled();
    }
    throw new FaultError(`fault injected at ${point} (${spec.mode})${info.id ? ` on ${info.id}` : ''}`);
  }

  /**
   * The view of one life of the process: wraps its store and its adapters. `kill` is that life's
   * death (the harness's `mortal`); the life's own state (the rows it is executing, the tickets of
   * its runs and sessions) dies with it.
   */
  life(kill: () => void): FaultLife {
    return new FaultLife(this, this.lives++, kill);
  }

  /** @internal */
  fire(point: FaultPoint, info: FaultInfo, kill: () => void): void {
    this.hit(point, info, kill);
  }

  /** @internal */
  record(call: VisibleCall): void {
    this.calls.push(call);
    this.sink(call);
  }
}

export class FaultLife {
  /** The outbox row each ticket is executing in this life, between its claim and its settlement. */
  private current = new Map<string, OutboxRow>();
  private runTickets = new Map<string, string>();
  private sessionTickets = new Map<string, string>();

  constructor(
    private faults: Faults,
    private n: number,
    private kill: () => void,
  ) {}

  private fire(point: FaultPoint, info: FaultInfo): void {
    this.faults.fire(point, info, this.kill);
  }

  private settled(id: string): void {
    for (const [ticket, row] of this.current) if (row.id === id) this.current.delete(ticket);
  }

  /** The row the call belongs to: its ticket's, or the only one under way when the call names no ticket this life knows. */
  private rowOf(ticketId: string | undefined): OutboxRow | undefined {
    if (ticketId !== undefined) return this.current.get(ticketId);
    return this.current.size === 1 ? [...this.current.values()][0] : undefined;
  }

  /** Runs `act` (the external call) between the `effect.before` and `effect.after` points of the row it belongs to. */
  private visible<T>(method: string, ticketId: string | undefined, detail: string, act: () => T): T {
    const row = this.rowOf(ticketId);
    const info: FaultInfo = { id: row?.id, effect: row?.effect.kind, ticketId: ticketId ?? row?.ticketId, method };
    if (row) this.fire('effect.before', info);
    const done = (): void => {
      this.faults.record({
        life: this.n,
        method,
        ...(info.ticketId === undefined ? {} : { ticketId: info.ticketId }),
        ...(row ? { row: row.id, kind: row.effect.kind } : {}),
        detail,
      });
      if (row) this.fire('effect.after', info);
    };
    const result = act();
    if (result instanceof Promise) return result.then((v: unknown) => (done(), v)) as T;
    done();
    return result;
  }

  store(inner: Store): Store {
    const eventInfo = (e: FactoryEvent | StoredEvent): FaultInfo => ({ id: e.id, eventType: e.type, ...(e.ticketId ? { ticketId: e.ticketId } : {}) });
    return override(inner, {
      appendInbox: async (e: FactoryEvent | StoredEvent) => {
        if (RESULT_EVENT.test(e.id)) this.fire('run.result', eventInfo(e));
        else if (!INTERNAL_EVENT.test(e.id)) this.fire('webhook.accept', eventInfo(e));
        const fresh = await inner.appendInbox(e);
        this.fire('inbox.write', eventInfo(e));
        return fresh;
      },
      decide: async (req: DecisionRequest) => {
        const info = eventInfo(req.event);
        const session = (req.event.payload as { linearSessionId?: unknown }).linearSessionId;
        if (typeof session === 'string' && req.event.ticketId) this.sessionTickets.set(session, req.event.ticketId);
        this.fire('decide.before', info);
        const outcome = await inner.decide({
          ...req,
          decide: (ticket, workflow) => {
            const plan = req.decide(ticket, workflow);
            // Thrown inside the transaction: it rolls back, as a process killed before its COMMIT.
            this.fire('decide.after', info);
            return plan;
          },
        });
        if (outcome.status === 'committed') {
          const t = outcome.plan.ticket;
          if (t?.linearSessionId) this.sessionTickets.set(t.linearSessionId, t.ticketId);
          this.fire('decide.commit', info);
        }
        return outcome;
      },
      claimEffect: async (projectId: string, ticketId: string | undefined, leaseMs: number) => {
        const row = await inner.claimEffect(projectId, ticketId, leaseMs);
        if (row && row !== 'busy') {
          this.current.set(row.ticketId ?? '*', row);
          this.fire('outbox.claim', { id: row.id, effect: row.effect.kind, ticketId: row.ticketId });
        }
        return row;
      },
      completeEffect: async (id: string, lease?: string, at?: number) => {
        const row = [...this.current.values()].find((r) => r.id === id);
        const done = await inner.completeEffect(id, lease, at);
        this.settled(id);
        this.fire('effect.complete', { id, effect: row?.effect.kind, ticketId: row?.ticketId });
        return done;
      },
      retryEffect: async (id: string, lease: string, error: string, delayMs: number) => {
        this.settled(id);
        return inner.retryEffect(id, lease, error, delayMs);
      },
      failEffect: async (id: string, lease: string, error: string, at?: number) => {
        this.settled(id);
        return inner.failEffect(id, lease, error, at);
      },
      fireTimer: async (t: TimerRecord, at: number) => {
        const info = { id: t.key, ticketId: t.ticketId };
        this.fire('timer.fire', info);
        const fired = await inner.fireTimer(t, at);
        if (fired) this.fire('timer.fired', info);
        return fired;
      },
      putRun: async (r: RunRecord) => {
        this.runTickets.set(r.id, r.ticketId);
        if (r.linearSessionId) this.sessionTickets.set(r.linearSessionId, r.ticketId);
        return inner.putRun(r);
      },
    });
  }

  tracker<T extends Tracker>(inner: T): T {
    const overrides: Record<string, unknown> = {};
    for (const [method, names] of Object.entries(TRACKER_CALLS)) {
      overrides[method] = (...args: unknown[]) => {
        const key = String(args[0]);
        const ticketId = names === 'ticket' ? key : this.sessionTickets.get(key);
        const detail = JSON.stringify(args);
        return this.visible(method, ticketId, detail, () => (inner[method as keyof T] as (...a: unknown[]) => unknown).apply(inner, args));
      };
    }
    return override(inner, overrides as Partial<Record<keyof T, unknown>>);
  }

  runner<T extends Runner>(inner: T): T {
    return override(inner, {
      start: (req: RunRequest) => this.visible('start', this.runTickets.get(req.runId), req.runId, () => inner.start(req)),
    } as Partial<Record<keyof T, unknown>>);
  }
}

/** The calls of `calls` that repeat a visible call of the same outbox row: a visible effect done twice. */
export function visibleDuplicates(calls: readonly VisibleCall[]): VisibleCall[][] {
  const byRow = new Map<string, VisibleCall[]>();
  for (const c of calls) {
    if (!c.row || !VISIBLE.has(c.method)) continue;
    // The same call again: a run's relay posting two different texts is no double.
    const key = JSON.stringify([c.row, c.method, c.detail]);
    byRow.set(key, [...(byRow.get(key) ?? []), c]);
  }
  return [...byRow.values()].filter((group) => group.length > 1);
}

export interface ChainReport {
  /** What must never happen: an event lost or decided twice, a row left behind, a replay that diverges, a run launched twice. */
  violations: string[];
  /**
   * Visible effects done twice because their row ran again after a fault cut it once it had acted:
   * the at-least-once of the outbox, which per-effect idempotency (ORC-162) closes.
   */
  atLeastOnce: string[];
}

/**
 * The invariants of the chain once everything settled (ORC-163): each acknowledged event journaled
 * exactly once, nothing left in the inbox, the outbox or the dead letters, each ticket's journal
 * replayed bit for bit by the oracle (ORC-174), and no visible effect done twice.
 */
export async function checkChain(
  store: Store,
  opts: { projectId: string; tickets: readonly string[]; acked: Iterable<string>; calls: readonly VisibleCall[] },
): Promise<ChainReport> {
  const violations: string[] = [];
  const pending = await store.pendingInbox(Number.MAX_SAFE_INTEGER);
  if (pending.length > 0) violations.push(`inbox: ${pending.length} row(s) never processed: ${pending.map((e) => e.id).join(', ')}`);
  const dead = await store.deadLetters();
  if (dead.length > 0) violations.push(`dead letters: ${dead.map((d) => d.event.id).join(', ')}`);

  const journaled = new Map<string, number>();
  for (const ticketId of [...opts.tickets, undefined]) {
    for (const row of await store.listEffects(opts.projectId, ticketId)) {
      if (row.ticketId !== ticketId) continue;
      if (row.status === 'pending' || row.status === 'running' || row.status === 'dead') violations.push(`outbox: ${row.id} (${row.effect.kind}) left ${row.status}`);
    }
    const journal = await exportJournal(store, opts.projectId, ticketId);
    for (const e of journal.entries) journaled.set(e.event.id, (journaled.get(e.event.id) ?? 0) + 1);
    const replay = replayJournal(journal);
    const who = ticketId ?? '*';
    if (replay.unrecorded > 0) violations.push(`journal ${who}: ${replay.unrecorded} row(s) without a recorded decision`);
    for (const d of replay.divergences) violations.push(`replay ${who}: ${d.eventId} (${d.eventType}) ${d.path} recorded ${d.recorded}, replayed ${d.replayed}`);
  }
  for (const [id, n] of journaled) if (n > 1) violations.push(`journal: ${id} journaled ${n} times`);
  for (const id of opts.acked) if (!journaled.has(id)) violations.push(`lost: ${id} was acknowledged, never journaled`);

  const atLeastOnce: string[] = [];
  for (const group of visibleDuplicates(opts.calls)) {
    const first = group[0]!;
    const line = `${first.method} ×${group.length} for ${first.row ? `${first.row} (${first.kind})` : `run ${first.detail}`} in lives ${group.map((c) => c.life).join(', ')}: ${first.detail}`;
    // A run launched twice is never the outbox's at-least-once: recover() blocks a ticket whose run was cut.
    if (first.method === 'start') violations.push(`run launched twice: ${line}`);
    else atLeastOnce.push(line);
  }
  return { violations, atLeastOnce };
}
