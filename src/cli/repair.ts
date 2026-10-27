import { userInfo } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../app/root.js';
import { homePaths } from '../config/instance.js';
import { REPAIR_ACTIONS, type DeadLetter, type RepairAction } from '../core/dead-letter.js';
import { openStore } from '../store/open.js';
import type { Store } from '../store/types.js';

export const REPAIR_USAGE = `Usage : factory run repair <ticket | événement> [replay | skip | force] [<événement>]
  sans action  lister les événements mis de côté (dead-letter) du ticket
  replay       décider l'événement de nouveau (après un correctif)
  skip         l'ignorer : il n'est jamais décidé
  force        enregistrer ses faits sans sa décision (aucun effet)
Le ticket est débloqué ; la réparation passe par l'inbox et est journalisée.`;

const LABELS: Record<RepairAction, string> = { replay: 'rejoué', skip: 'ignoré', force: 'forcé' };

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
  `  ${d.eventId}  ${d.event.type}  ${d.status === 'open' ? 'ouvert' : `${d.status} par ${d.resolvedBy ?? '?'}`}  (${d.failures} échec${d.failures > 1 ? 's' : ''}) ${d.error}`;

/**
 * `factory run repair` (ORC-175): lists a ticket's dead letters, or repairs one. The repair is written
 * to the store directly (no daemon needed): the dead letter takes its new status, and a
 * `dead_letter.repaired` event enters the inbox, which the worker decides and journals.
 */
export async function runRepair(o: RepairOptions): Promise<number> {
  let found = await o.store.deadLetters(o.target);
  if (found.length === 0) found = (await o.store.deadLetters()).filter((d) => d.eventId === o.target);
  if (found.length === 0) {
    o.print(`Aucun événement mis de côté pour ${o.target}.`);
    return 1;
  }
  if (o.action === undefined) {
    o.print(`Événements mis de côté pour ${o.target} :`);
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
        ? `Plus rien d'ouvert pour ${o.target} : tout est déjà réparé.`
        : o.eventId === undefined
          ? `Plusieurs événements ouverts pour ${o.target} : précisez lequel.`
          : `Pas d'événement ouvert ${o.eventId} pour ${o.target}.`,
    );
    for (const d of open) o.print(line(d));
    return 1;
  }
  const repaired = await o.store.repairDeadLetter(chosen.eventId, action, o.by, o.now);
  if (!repaired) {
    o.print(`L'événement ${chosen.eventId} a été réparé entre-temps.`);
    return 1;
  }
  o.print(`Événement ${chosen.eventId} (${chosen.event.type}) ${LABELS[action]} par ${o.by} : réparation journalisée, décidée au prochain passage du démon.`);
  const left = open.length - 1;
  if (left > 0) o.print(`Encore ${left} événement${left > 1 ? 's' : ''} ouvert${left > 1 ? 's' : ''} pour ${o.target}.`);
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
