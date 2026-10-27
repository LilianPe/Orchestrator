import type { Workflow } from '../config/workflow-schema.js';
import { NO_PLAN, planDecision } from '../core/decision-plan.js';
import { SCHEMA_VERSION } from '../core/types.js';
import { upcast } from '../core/upcast.js';
import type { DecisionPlan, DecisionRecord, JournalEntry, Store } from '../store/types.js';
import { canonical } from './workflow-version.js';

/** Version of the exported journal file (`factory replay --export`). */
export const JOURNAL_FORMAT = 1;

/** A ticket's journal as `factory replay` exports and reads it (ORC-174). */
export interface ExportedJournal {
  format: typeof JOURNAL_FORMAT;
  projectId: string;
  /** Absent: the project's events without a ticket. */
  ticketId?: string;
  /** The workflow versions its decisions ran on, by hash. */
  workflows: Record<string, unknown>;
  entries: JournalEntry[];
}

/** Reads a ticket's journal and the workflow versions of its decisions out of the store. */
export async function exportJournal(store: Store, projectId: string, ticketId?: string): Promise<ExportedJournal> {
  const entries = await store.ticketJournal(projectId, ticketId);
  const workflows: Record<string, unknown> = {};
  for (const hash of new Set(entries.map((e) => e.decision?.workflowHash))) {
    if (!hash) continue;
    const version = await store.getWorkflowVersion(hash);
    if (!version) throw new Error(`workflow version ${hash} of ${ticketId ?? projectId} is not stored`);
    workflows[hash] = version.definition;
  }
  return { format: JOURNAL_FORMAT, projectId, ...(ticketId === undefined ? {} : { ticketId }), workflows, entries };
}

/** Parses an exported journal; throws on another format. */
export function readJournal(text: string, source = 'journal'): ExportedJournal {
  const j = JSON.parse(text) as Partial<ExportedJournal>;
  if (j.format !== JOURNAL_FORMAT || typeof j.projectId !== 'string' || !Array.isArray(j.entries) || typeof j.workflows !== 'object') {
    throw new Error(`${source} : pas un journal exporté au format ${JOURNAL_FORMAT}`);
  }
  return j as ExportedJournal;
}

/**
 * `regression`: every decision must come out bit for bit as recorded; all divergences are listed.
 * `what-if`: the decisions run on another workflow (a new preset); the replay stops at the first divergence.
 */
export type ReplayMode = 'regression' | 'what-if';

export interface ReplayOptions {
  mode?: ReplayMode;
  /** What-if: the workflow the decisions run on instead of the versions they were frozen on. */
  workflow?: Workflow;
}

/** What a decision writes, and so what the replay compares. */
const COMPARED = ['ticket', 'effects', 'timers', 'clearTimers'] as const;
export type DecisionField = (typeof COMPARED)[number];

export interface Divergence {
  /** The journal row: its seq, event id and type (after the upcasters). */
  seq: number;
  eventId: string;
  eventType: string;
  field: DecisionField;
  /** The first value that differs inside the field, e.g. `effects[1].kind`, `ticket.logical`. */
  path: string;
  /** Canonical JSON (sorted keys) of that value, as recorded and as replayed; `undefined` when absent. */
  recorded: string | undefined;
  replayed: string | undefined;
}

export interface ReplayReport {
  projectId: string;
  ticketId?: string;
  mode: ReplayMode;
  /** Decisions run again and compared. */
  replayed: number;
  /** Journal rows without a recorded decision (journaled before ORC-174, or outside a decision): read, not compared. */
  unrecorded: number;
  /** Rows written in an older `schemaVersion`, read through the upcasters. */
  upcast: number;
  divergences: Divergence[];
}

/** JSON as the store keeps it: `undefined` fields dropped. */
const json = (v: unknown): unknown => (v === undefined ? undefined : JSON.parse(canonical(v)));

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The first path where two JSON values differ, with both canonical values there. */
function firstDifference(a: unknown, b: unknown, path: string): { path: string; recorded?: string; replayed?: string } | undefined {
  const text = (v: unknown) => (v === undefined ? undefined : canonical(v));
  if (text(a) === text(b)) return undefined;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
  }
  if (isObject(a) && isObject(b)) {
    // What an effect is comes first: a `start_run` replayed as an `activity` reads as such.
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) => Number(y === 'kind') - Number(x === 'kind') || (x < y ? -1 : x > y ? 1 : 0));
    for (const k of keys) {
      const d = firstDifference(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
  }
  return { path, recorded: text(a), replayed: text(b) };
}

/** The decision of one recorded row, run again from its recorded inputs. */
function rerun(entry: JournalEntry & { decision: DecisionRecord }, journal: ExportedJournal, workflow: Workflow | undefined): DecisionPlan {
  const { decision } = entry;
  const event = upcast(entry.event);
  if (event.id !== decision.eventId) throw new Error(`journal row ${event.id} carries the decision of ${decision.eventId}`);
  // Nothing was decided: an event of a project the instance did not know.
  if (!decision.workflowHash) return NO_PLAN;
  const definition = workflow ?? journal.workflows[decision.workflowHash];
  if (!definition) throw new Error(`workflow version ${decision.workflowHash} is not in the journal`);
  return planDecision({
    event,
    known: decision.before,
    workflow: definition as Workflow,
    // What-if keeps the recorded hash: the ticket stays frozen on its version, only the definition changes.
    hash: decision.workflowHash,
    now: decision.at ?? 0,
  });
}

/**
 * The replay oracle (ORC-174). Each journal row goes through the upcasters, then its decision runs
 * again (`planDecision`: `decide`, then `reduce`) from what the decision transaction recorded: the
 * projection read under the lock, the frozen workflow version, the clock. The new projection, the
 * effects, the timers and the timer reset must come out bit for bit as recorded (canonical JSON).
 *
 * Each decision starts from its own recorded projection, not from the previous decision's output:
 * the shell also changes the projection between decisions (`Orchestrator.apply`, a run's start,
 * a prepared workspace), and those changes are not decisions.
 */
export function replayJournal(journal: ExportedJournal, options: ReplayOptions = {}): ReplayReport {
  const mode = options.mode ?? 'regression';
  if (mode === 'what-if' && !options.workflow) throw new Error('what-if replay needs a workflow');
  const report: ReplayReport = {
    projectId: journal.projectId,
    ...(journal.ticketId === undefined ? {} : { ticketId: journal.ticketId }),
    mode,
    replayed: 0,
    unrecorded: 0,
    upcast: 0,
    divergences: [],
  };
  for (const entry of journal.entries) {
    if ((entry.event.schemaVersion ?? 1) < SCHEMA_VERSION) report.upcast++;
    const decision = entry.decision;
    if (!decision) {
      report.unrecorded++;
      continue;
    }
    const plan = rerun({ ...entry, decision }, journal, mode === 'what-if' ? options.workflow : undefined);
    report.replayed++;
    let diverged = false;
    for (const field of COMPARED) {
      const d = firstDifference(json(decision[field]), json(plan[field]), field);
      if (!d) continue;
      report.divergences.push({ seq: decision.seq, eventId: decision.eventId, eventType: upcast(entry.event).type, field, ...d } as Divergence);
      diverged = true;
    }
    if (diverged && mode === 'what-if') break;
  }
  return report;
}

const subject = (r: Pick<ReplayReport, 'projectId' | 'ticketId'>) => `${r.projectId}/${r.ticketId ?? '*'}`;

/** One line per journal, then one per divergence. */
export function formatReplay(r: ReplayReport): string {
  const upcast = r.upcast > 0 ? `, ${r.upcast} relu(s) par les upcasters` : '';
  const unrecorded = r.unrecorded > 0 ? `, ${r.unrecorded} ligne(s) sans décision enregistrée` : '';
  const head = `${subject(r)} : ${r.replayed} décision(s) rejouée(s)${upcast}${unrecorded}`;
  if (r.divergences.length === 0) {
    return `${head} — ${r.mode === 'regression' ? 'identiques bit à bit' : 'aucune divergence'}`;
  }
  const what = r.mode === 'what-if' ? 'arrêt à la première divergence' : `${r.divergences.length} divergence(s)`;
  const lines = r.divergences.map(
    (d) => `  événement ${d.eventId} (${d.eventType}, n° ${d.seq} du journal) : ${d.path} enregistré ${d.recorded ?? 'absent'}, rejoué ${d.replayed ?? 'absent'}`,
  );
  return [`${head} — ${what}`, ...lines].join('\n');
}
