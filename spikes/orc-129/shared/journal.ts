// What both options write into their `journal` table, and the replay that checks it.
import { isDeepStrictEqual } from 'node:util';
import { decide, effectId, type Decision, type EngineEvent, type TicketState } from './decide.ts';

export type JournalRow = { ticket: string; seq: number; event: EngineEvent; decision: RecordedDecision };
export type RecordedDecision = ReturnType<typeof recordedDecision>;

export const JOURNAL_SCHEMA = `
create table journal (ticket text not null, seq int not null, event_id text not null unique, event jsonb not null,
                      decision jsonb not null, primary key (ticket, seq));
create table tickets (id text primary key, seq int not null, state jsonb);`;

/** The decision as recorded: next state, and effects with the ids the runtime gives them (`ticket:seq:i`). */
export function recordedDecision(ticket: string, seq: number, d: Decision) {
  return { state: d.state ?? null, effects: d.effects.map((effect, i) => ({ id: effectId(ticket, seq, i), effect })) };
}

/** Replays the journal through decide, from the state decide rebuilds itself, and compares each decision. */
export function replayJournal(rows: JournalRow[]): void {
  const states = new Map<string, TicketState | undefined>();
  let mismatches = 0;
  for (const r of rows) {
    const d = decide(states.get(r.ticket), r.event);
    const same = isDeepStrictEqual(recordedDecision(r.ticket, r.seq, d), r.decision);
    if (!same) mismatches++;
    console.log(`${same ? 'identique' : 'ÉCART'}  ${r.ticket}#${r.seq}  ${r.event.id}`);
    states.set(r.ticket, d.state);
  }
  console.log(`rejeu : ${rows.length} décision(s), ${mismatches} écart(s)`);
}
