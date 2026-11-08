import type { Role } from './authz.js';
import type { TimerRecord } from '../store/types.js';
import { PRODUCT_NAME } from '../product.js';
import { REPO_CONFIG_REFUSED, TICKET_TOKENS_REACHED, type BlockKind } from './block-cause.js';
import { BEFORE_ORC_331 } from './legacy-messages.js';
import { RENAMED_V1, SCHEMA_VERSION, type FactoryEvent, type Taint, type TicketState, type TimerFired } from './types.js';

/** An event as it may sit in the journal, whatever factory version wrote it. */
export interface StoredEvent {
  id: string;
  type: string;
  at: number;
  projectId: string;
  ticketId?: string;
  schemaVersion?: number;
  taint?: Taint;
  actor?: string;
  /** Roles of `actor` journaled with a human event (ORC-186). */
  roles?: readonly Role[];
  payload: unknown;
}

/** Upcaster from version N to N + 1, indexed by N. A row without a version is version 1. */
const UPCASTERS: Record<number, (e: StoredEvent) => StoredEvent> = {
  1: (e) => ({
    ...e,
    type: RENAMED_V1[e.type] ?? e.type,
    payload: e.type === 'label.added' ? { ...(e.payload as object), change: 'added' } : e.payload,
    schemaVersion: 2,
    // Version 1 had no taint and the factory trusted every event: replaying it must give the same decisions.
    // A row that does carry a taint keeps it: an unversioned producer must not launder an untrusted event.
    taint: e.taint ?? 'trusted',
  }),
  // Version 3 (ORC-161): the debounce of a job is one kind of the generic timer.
  2: (e) => ({
    ...e,
    ...(e.type === 'debounce.fired' ? { type: 'timer.fired', payload: { kind: 'debounce', payload: e.payload } } : {}),
    schemaVersion: 3,
  }),
};

export function upcast(stored: StoredEvent): FactoryEvent {
  let e = stored;
  let version = e.schemaVersion ?? 1;
  if (version > SCHEMA_VERSION) throw new Error(`event ${e.id}: schema version ${version} is newer than ${SCHEMA_VERSION}`);
  while (version < SCHEMA_VERSION) {
    const up = UPCASTERS[version];
    if (!up) throw new Error(`event ${e.id}: no upcaster from schema version ${version}`);
    e = up(e);
    version += 1;
  }
  return e as FactoryEvent;
}

/**
 * A timer as `timers` or a recorded decision may hold it, whatever factory version wrote it: before
 * ORC-161, a timer was the debounce of a job (`job`, no `kind`).
 */
export type StoredTimer = Omit<TimerRecord, 'kind' | 'payload'> & (TimerFired | { job: string });

/** Brings a stored timer to the generic shape (ORC-161): a job-bound one is a `debounce` of that job, key unchanged. */
export function upcastTimer(stored: StoredTimer): TimerRecord {
  if (!('job' in stored)) return stored;
  const { job, ...rest } = stored;
  return { ...rest, kind: 'debounce', payload: { job } };
}

/**
 * The heads of the reasons the factory wrote before ORC-345, by kind, the English ones then the French ones of before
 * ORC-331: each anchored on the head of a reason, which the factory writes, since what follows may quote an error or
 * a job name. Read only to give a ticket blocked before ORC-345 its kind (`legacyBlock`): nothing decides on a reason.
 * A dead letter names its event (`event`), a stuck pending job its job (`job`).
 */
const LEGACY_KINDS: readonly (readonly [Exclude<BlockKind, 'other'>, RegExp])[] = [
  ['asked', /^Question asked by the agent/],
  ['question', /^Waiting for an answer to the agent's question/],
  ['contested', /^The agent disputes the ticket/],
  ['red', /^Red not verified after /],
  ['infra', /^The run .+ was interrupted: infrastructure failure/],
  ['infra', /^The red check of .+ could not run: infrastructure failure/],
  ['infra', /^The verification of .+ could not run: infrastructure failure/],
  ['infra', /^Launch error: /],
  ['stuck', /^Error: the pending .+ could not be started: /],
  ['infra', /^Error: /],
  ['infra', new RegExp(`^${PRODUCT_NAME} restarted during `)],
  ['infra', /^The lease of the run .+ expired \d+ times: /],
  ['limit', /^The run .+ reached a limit/],
  ['limit', /^The run .+ has written nothing for /],
  ['limit', /^Too many relaunches after a cut: /],
  ['limit', new RegExp(`^${TICKET_TOKENS_REACHED}`)],
  ['limit', /^Checks still failing after /],
  ['ci_bound', /^CI still failing after /],
  ['failed', /^Checks failing after /],
  ['loop', /^Loop: /],
  ['failed', /^The run .+ failed\.$/],
  ['pickup', /^The description (is shorter than|has no)/],
  ['pickup', /^A branch .+ already exists on origin\./],
  ['pickup', /^No repository known for the Linear team /],
  ['pickup', /^Repository to specify: /],
  ['repo_config', new RegExp(`^${REPO_CONFIG_REFUSED}`)],
  ['dead_letter', /^Event (?<event>.+?) set aside \(/],
  ['pr_closed', /^PR #\d+ closed without merge$/],
  ['stopped', /^Stopped on request$/],
  ...BEFORE_ORC_331.kinds,
];

/** The typed block of a ticket blocked before ORC-345, read from its reason: `other` when no kind is known for it, never a guess. */
export function legacyBlock(reason: string | undefined): Pick<TicketState, 'blockKind' | 'blockedEvent'> {
  for (const [kind, head] of LEGACY_KINDS) {
    const m = reason === undefined ? null : head.exec(reason);
    if (m) return { blockKind: kind, ...(m.groups?.['event'] ? { blockedEvent: m.groups['event'] } : {}) };
  }
  return { blockKind: 'other' };
}

/**
 * A ticket as a projection or a recorded decision may hold it, whatever factory version wrote it: before ORC-180, the
 * human inbox was `pendingFeedback`. Same items: only the name changes, and only in the ticket; no event carries it, so no
 * event changes version. What it holds is not looked at: a corrupt one stays corrupt, its decision dead-letters as before.
 * A ticket blocked before ORC-345 gets its kind back from its reason (`legacyBlock`), the one place that reads it.
 */
export function upcastTicket(stored: object): TicketState {
  let t = stored as TicketState & { pendingFeedback?: TicketState['humanInbox'] };
  if ('pendingFeedback' in t) {
    const { pendingFeedback, ...rest } = t;
    t = { ...rest, humanInbox: pendingFeedback } as TicketState;
  }
  return t.blocked && t.blockKind === undefined ? { ...t, ...legacyBlock(t.blockReason) } : t;
}

/** Fills fields added after a row was first persisted. */
export function normalizeTicket(stored: TicketState): TicketState {
  const t = upcastTicket(stored);
  return { ...t, delegated: t.delegated ?? false, questionSessionIds: t.questionSessionIds ?? [], ciFixAttempts: t.ciFixAttempts ?? 0 };
}

/** Why the factory's merge is refused when the PR's head moved since the review (ORC-148): the new commits go through the AI review again. */
export const MERGE_PUSHED = 'the branch received a push since the review';

/** A merge refusal as the shell saves it (`effect:<id>:refused`), to answer the effect's replay with the same refusal. */
export interface MergeRefusal {
  reason: string;
  /** Refused for a push since the review, as the forge said it (`head_moved`) or the shell saw it: never read from `reason`. */
  headMoved: boolean;
}

/** A saved merge refusal, whatever factory version wrote it: before ORC-345, its sentence alone, which then said whether the head moved. */
export function upcastMergeRefusal(saved: string): MergeRefusal {
  try {
    const parsed = JSON.parse(saved) as unknown;
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as MergeRefusal).reason === 'string') return parsed as MergeRefusal;
  } catch {
    // A sentence: saved before ORC-345.
  }
  return { reason: saved, headMoved: saved === MERGE_PUSHED || saved === BEFORE_ORC_331.pushed };
}
