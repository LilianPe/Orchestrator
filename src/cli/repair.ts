import { userInfo } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../app/root.js';
import { homePaths } from '../config/instance.js';
import { REPAIR_ACTIONS, REPAIR_LABELS, type DeadLetter, type RepairAction } from '../core/dead-letter.js';
import { SETTLES_RUN } from '../core/decision-plan.js';
import type { EventType } from '../core/types.js';
import { openStore } from '../store/open.js';
import type { Store } from '../store/types.js';

export const REPAIR_USAGE = `Usage: factory run repair <ticket | event> [replay | skip | force] [<event>]
  no action    list the ticket's events set aside (dead letters)
  replay       decide the event again (after a fix)
  skip         ignore it: it is never decided
  force        record its facts without its decision (no effect)
The ticket is unblocked; the repair goes through the inbox and is journaled.`;

export interface RepairOptions {
  store: Store;
  /** A ticket id, or the id of a dead-lettered event (an event without a ticket). */
  target: string;
  action?: string;
  /** Which open dead letter of the ticket, when it has several. */
  eventId?: string;
  /** Who repairs, recorded with the repair. */
  by: string;
  now: number;
  print: (line: string) => void;
}

const line = (d: DeadLetter) =>
  `  ${d.eventId}  ${d.event.type}  ${d.status === 'open' ? 'open' : `${d.status} by ${d.resolvedBy ?? '?'}`}  (${d.failures} failure${d.failures > 1 ? 's' : ''}) ${d.error}`;

/**
 * `factory run repair` (ORC-175): lists a ticket's dead letters, or repairs one. The repair is written
 * to the store directly (no daemon needed): the dead letter takes its new status, and a
 * `dead_letter.repaired` event enters the inbox, which the worker decides and journals.
 */
export async function runRepair(o: RepairOptions): Promise<number> {
  let found = await o.store.deadLetters(o.target);
  if (found.length === 0) {
    const one = await o.store.getDeadLetter(o.target);
    found = one ? [one] : [];
  }
  if (found.length === 0) {
    o.print(`No event set aside for ${o.target}.`);
    return 1;
  }
  if (o.action === undefined) {
    o.print(`Events set aside for ${o.target}:`);
    for (const d of found) o.print(line(d));
    return 0;
  }
  if (!(REPAIR_ACTIONS as readonly string[]).includes(o.action)) {
    o.print(REPAIR_USAGE);
    return 1;
  }
  const action = o.action as RepairAction;
  const open = found.filter((d) => d.status === 'open');
  const chosen = o.eventId === undefined ? (open.length === 1 ? open[0] : undefined) : open.find((d) => d.eventId === o.eventId);
  if (!chosen) {
    o.print(
      open.length === 0
        ? `Nothing open any more for ${o.target}: everything is already repaired.`
        : o.eventId === undefined
          ? `Several open events for ${o.target}: say which one.`
          : `No open event ${o.eventId} for ${o.target}.`,
    );
    for (const d of open) o.print(line(d));
    return 1;
  }
  // A run's or a check's result frees the ticket's run: dropped, it would leave the ticket running for good.
  if (action === 'skip' && (SETTLES_RUN.has(chosen.event.type as EventType) || chosen.event.type === 'verify.lost')) {
    o.print(`${chosen.eventId} (${chosen.event.type}) ends a run or its checks: skipping it would leave the ticket in progress. Use force (its facts without its decision) or replay.`);
    return 1;
  }
  const repaired = await o.store.repairDeadLetter(chosen.eventId, action, o.by, o.now);
  if (!repaired) {
    o.print(`The event ${chosen.eventId} was repaired in the meantime.`);
    return 1;
  }
  o.print(`Event ${chosen.eventId} (${chosen.event.type}) ${REPAIR_LABELS[action]} by ${o.by}: repair journaled, decided at the next pass of the daemon.`);
  const left = open.length - 1;
  if (left > 0) o.print(`Still ${left} open event${left > 1 ? 's' : ''} for ${o.target}.`);
  return 0;
}

/** The command line: `factory run repair <target> [action] [event]`, on the instance's store. */
export async function runRepairCommand(home: string, args: readonly string[]): Promise<number> {
  const [target, action, eventId] = args;
  if (!target) {
    console.log(REPAIR_USAGE);
    return 1;
  }
  // The daemon migrates the schema; a repair only reads and writes rows.
  const { store } = await openStore({ env: process.env, sqlitePath: homePaths(home).db, migrationsFolder: join(repoRoot(), 'drizzle'), migrate: false });
  try {
    let by = 'cli';
    try {
      by = userInfo().username || by;
    } catch {
      // No user name (a container without passwd entry): the repair is still journaled, as `cli`.
    }
    return await runRepair({ store, target, action, eventId, by, now: Date.now(), print: (s) => console.log(s) });
  } finally {
    await store.close();
  }
}
