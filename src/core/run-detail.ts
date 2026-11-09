import type { RedCause } from '../checks/red.js';
import type { MeasureFacts, OutboxRow, RunRecord } from '../store/types.js';
import type { AgentOutput, AttemptOutcome, Finding as LensFinding } from './agent-output.js';
import { pendingLabels } from './attempt-labels.js';
import { runMeasure, type RunMeasure } from './measures.js';
import { addTokens, type EventType, type FactoryEvent, type LogicalState, type TokenUsage } from './types.js';
import { upcast, type StoredEvent } from './upcast.js';

/** An event of the ticket's journal, said in the factory's words from its structured fields, never from a text it carries. */
export interface TimelineEntry {
  id: string;
  type: EventType;
  at: number;
  /** An event about this run: its end, its check, its publication. */
  ofRun: boolean;
  what: string;
}

/**
 * Where a human decided: in Linear (signed webhook), on GitHub (signed webhook), from the dashboard (or `factory stop`, which
 * goes through it), or `factory run repair` on the command line.
 */
export type DecisionChannel = 'linear' | 'github' | 'dashboard' | 'cli';

/** A human's decision on the ticket: who, when, what. */
export interface HumanDecision {
  id: string;
  type: EventType;
  at: number;
  channel: DecisionChannel;
  /** The author the source signed (a Linear name, a GitHub login), else the signed actor's id; null when the source names nobody. */
  who: string | null;
  what: string;
}

/**
 * A human gate the ticket went through. `merge`: the time the ticket spent in Human Review, from the factory's move there (an
 * executed `move` effect) to whatever moved it out: the factory's next move (to done once merged, back after a refused merge) or a
 * human's (back to dev or to AI review, a cancel). Read from what moved the ticket, not guessed from the events a human sent: a
 * review asking for changes moves nothing yet (ORC-190). The `spec` gate has no step yet (ORC-212).
 */
export interface Gate {
  gate: 'merge';
  openedAt: number;
  closedAt: number | null;
  /** Where the ticket went: a logical state, `cancelled`, or null for a status the factory does not map; null while open. */
  to: LogicalState | 'cancelled' | null;
  /** The journal event that moved it out: the factory's `effect.done`, or a human's `status.changed`. */
  closedBy: string | null;
}

/**
 * What the reviewers found, as the factory knows it: a human's review on the PR (its state, from GitHub), or an AI review round,
 * a reviewer attempt, with its closed outcome (ORC-188) and the findings its lens handed back through `submit_result`, as the
 * factory validated them (ORC-183): each on its file and line, with its severity. Empty for a round that handed back none.
 */
export type Finding =
  | { source: 'human'; id: string; at: number; author: string; pr: number; kind: 'review' | 'comment'; state: string | null }
  | { source: 'ai'; runId: string; at: number; job: string; status: RunRecord['status']; outcome: AttemptOutcome | null; findings: readonly LensFinding[] };

/**
 * A verdict of the factory's checks: `verify` (its commands, then `factory/anti-triche`, `factory/taille-du-diff`, the freeze…, each
 * failure by its check's name), `red` with its cause (ORC-123), or the PR's CI.
 */
export interface CheckVerdict {
  id: string;
  at: number;
  check: 'verify' | 'red' | 'ci';
  result: 'passed' | 'failed' | 'errored';
  runId: string | null;
  job: string | null;
  /** The checks that failed, once each; for a passed verify, the commands it ran. */
  names: string[];
  red: RedCause | null;
}

/** What one step (a job) of the ticket cost over its attempts. */
export interface StepCost {
  job: string;
  attempts: number;
  /** Over the attempts that reported their usage; null when none did. */
  tokens: TokenUsage | null;
  attemptsWithoutTokens: number;
  turns: number;
  /** The attempts' own time (`RunMeasure.durationMs`). */
  workMs: number;
  costUsd: number;
}

/** The run as measured (ORC-223), with what it ran with (ORC-226) and how it ended (ORC-188). */
export interface RunSummary extends RunMeasure {
  projectId: string;
  ticketId: string;
  queue: RunRecord['queue'];
  /** The closed outcome its `run.finished` journaled; null while running and on rows written before ORC-289. */
  outcome: AttemptOutcome | null;
  infra: boolean;
  labels: (NonNullable<RunRecord['labels']> & { pending: ReturnType<typeof pendingLabels> }) | null;
}

/** The detail of a run (ORC-298): what happened to it and to its ticket, read from the store, never from what an agent wrote. */
export interface RunDetail {
  run: RunSummary;
  timeline: TimelineEntry[];
  decisions: HumanDecision[];
  gates: Gate[];
  findings: Finding[];
  checks: CheckVerdict[];
  steps: StepCost[];
  /** The ticket's attempts, oldest first. */
  attempts: RunMeasure[];
  /** What the run handed back through `submit_result` (ORC-188), as the factory validated it; null when it handed nothing. */
  output: AgentOutput | null;
}

const runIdOf = (e: FactoryEvent): string | undefined => {
  const p = e.payload as { runId?: unknown };
  return typeof p.runId === 'string' ? p.runId : undefined;
};

const unique = (xs: string[]): string[] => [...new Set(xs)];

/** An event in the factory's words, from its structured fields only; '' for one without more to say than its type. */
function describe(e: FactoryEvent): string {
  switch (e.type) {
    case 'ticket.delegated':
      return 'Delegated to the factory';
    case 'ticket.undelegated':
      return 'Delegation withdrawn';
    case 'session.stopped':
      return 'Stopped from Linear';
    case 'session.mentioned':
      return 'Mentioned the factory';
    case 'session.prompted':
      return e.payload.kind ? `Replied in the session (${e.payload.kind})` : 'Replied in the session';
    case 'ticket.commented':
      return `Commented on the ticket (${e.payload.kind})`;
    case 'command':
      return `Command /${e.payload.name}`;
    case 'status.changed':
      return `Moved from ${e.payload.from ?? 'none'} to ${e.payload.to ?? 'none'}${e.payload.cancelled ? ' (cancelled)' : ''}`;
    case 'label.changed':
      return `Label ${e.payload.label} ${e.payload.change}`;
    case 'push.human':
      return `Pushed ${e.payload.sha.slice(0, 7)} on ${e.payload.branch}`;
    case 'pr.opened':
      return `PR #${e.payload.number} opened`;
    case 'pr.checks_passed':
      return `CI of PR #${e.payload.number} passed`;
    case 'pr.checks_failed':
      return `CI of PR #${e.payload.number} failed: ${e.payload.failures.join(', ')}`;
    case 'pr.merged':
      return `Merged PR #${e.payload.number}`;
    case 'pr.closed':
      return `Closed PR #${e.payload.number} without merging`;
    case 'pr.reviewed':
      return e.payload.kind === 'review' ? `Reviewed PR #${e.payload.number}: ${e.payload.state?.toLowerCase() ?? 'no state'}` : `Commented on the diff of PR #${e.payload.number}`;
    case 'pr.conflicted':
      return `PR #${e.payload.number} conflicts with ${e.payload.baseRef}`;
    case 'pr.merge_refused':
      return `Merge of PR #${e.payload.number} refused`;
    case 'publish.done':
      return `Published ${e.payload.sha.slice(0, 7)}`;
    case 'publish.refused':
      return 'Publication refused';
    case 'run.finished':
      return `${e.payload.job} ended: ${e.payload.attempt ?? e.payload.outcome}, ${e.payload.turns} turn${e.payload.turns === 1 ? '' : 's'}`;
    case 'run.lost':
      return `${e.payload.job} lost (${e.payload.cause})`;
    case 'verify.passed':
      return `${e.payload.red ? 'Red check' : 'Check'} of ${e.payload.job} passed${e.payload.red ? ` (${e.payload.red})` : ''}`;
    case 'verify.failed':
      return `${e.payload.red ? 'Red check' : 'Check'} of ${e.payload.job} failed: ${e.payload.red ?? unique(e.payload.failures.map((f) => f.command)).join(', ')}`;
    case 'verify.errored':
      return `Check of ${e.payload.job} could not run`;
    case 'verify.lost':
      return `Check of ${e.payload.job} lost`;
    case 'effect.done':
      return `Done: ${e.payload.kind}`;
    case 'effect.failed':
      return `Failed: ${e.payload.kind}`;
    case 'timer.fired':
      return `Timer ${e.payload.kind}`;
    case 'control.stop':
      return e.payload.takeOver ? 'Took the run over' : 'Stopped the ticket';
    case 'control.bundle':
      return 'Handed back a bundle';
    case 'bundle.refused':
      return 'Bundle refused';
    case 'control.pause':
      return 'Paused the factory';
    case 'control.resume':
      return 'Resumed the factory';
    case 'dead_letter.added':
      return `Dead-lettered ${e.payload.eventType}`;
    case 'dead_letter.repaired':
      return `Repaired a dead-lettered event (${e.payload.action})`;
    default:
      return '';
  }
}

/**
 * The decision a human made by this event, if any. A move or a label counts only with a signed actor: the factory's own,
 * echoed back by Linear, carry none. A merge the factory carried out (`mergedByFactory`) is its own.
 */
function decisionOf(e: FactoryEvent, facts: MeasureFacts): Pick<HumanDecision, 'channel' | 'who'> | undefined {
  const actor = e.actor ?? null;
  switch (e.type) {
    case 'ticket.delegated':
    case 'ticket.undelegated':
    case 'session.stopped':
      return { channel: 'linear', who: actor };
    case 'status.changed':
    case 'label.changed':
      return actor === null ? undefined : { channel: 'linear', who: actor };
    case 'session.mentioned':
    case 'session.prompted':
    case 'ticket.commented':
    case 'command':
      return { channel: 'linear', who: e.payload.author || actor };
    case 'push.human':
    case 'pr.reviewed':
      return { channel: 'github', who: e.payload.author };
    case 'pr.merged':
      return mergedByFactory(e, facts) ? undefined : { channel: 'github', who: actor };
    case 'pr.closed':
      return { channel: 'github', who: actor };
    case 'control.stop':
    case 'control.bundle':
    case 'control.pause':
    case 'control.resume':
      return { channel: 'dashboard', who: null };
    case 'dead_letter.repaired':
      return { channel: 'cli', who: e.payload.by };
    default:
      return undefined;
  }
}

function checkOf(e: FactoryEvent): CheckVerdict | undefined {
  const base = { id: e.id, at: e.at };
  switch (e.type) {
    case 'verify.passed':
      return { ...base, check: e.payload.red ? 'red' : 'verify', result: 'passed', runId: e.payload.runId, job: e.payload.job, names: [...(e.payload.commands ?? [])], red: e.payload.red ?? null };
    case 'verify.failed':
      return { ...base, check: e.payload.red ? 'red' : 'verify', result: 'failed', runId: e.payload.runId, job: e.payload.job, names: unique(e.payload.failures.map((f) => f.command)), red: e.payload.red ?? null };
    case 'verify.errored':
      return { ...base, check: 'verify', result: 'errored', runId: e.payload.runId, job: e.payload.job, names: [], red: null };
    case 'pr.checks_passed':
      return { ...base, check: 'ci', result: 'passed', runId: null, job: null, names: [], red: null };
    case 'pr.checks_failed':
      return { ...base, check: 'ci', result: 'failed', runId: null, job: null, names: [...e.payload.failures], red: null };
    default:
      return undefined;
  }
}

function stepCosts(attempts: RunMeasure[]): StepCost[] {
  const steps = new Map<string, StepCost>();
  for (const a of attempts) {
    const s = steps.get(a.job) ?? { job: a.job, attempts: 0, tokens: null, attemptsWithoutTokens: 0, turns: 0, workMs: 0, costUsd: 0 };
    s.attempts += 1;
    if (a.tokens) s.tokens = s.tokens ? addTokens(s.tokens, a.tokens) : a.tokens;
    else if (a.status !== 'running') s.attemptsWithoutTokens += 1;
    s.turns += a.turns;
    s.workMs += a.durationMs ?? 0;
    s.costUsd += a.costUsd;
    steps.set(a.job, s);
  }
  return [...steps.values()];
}

/**
 * Where an event moved the ticket, if it did: the factory's executed `move` effect, or a status change in Linear (a human's, or
 * the echo of the factory's own move, which moves it where it already is). `undefined`: it did not move the ticket.
 */
function movedTo(e: FactoryEvent, effects: ReadonlyMap<string, OutboxRow>): Gate['to'] | undefined {
  if (e.type === 'effect.done') {
    const row = effects.get(e.payload.effectId);
    return row?.status === 'done' && row.effect.kind === 'move' ? row.effect.to : undefined;
  }
  if (e.type === 'status.changed') return e.payload.cancelled ? 'cancelled' : e.payload.to;
  return undefined;
}

/**
 * A merge the factory carried out (ORC-148): a `merge` effect done on the PR's head. A row older than ORC-278 names no head: then
 * any merge effect of the ticket done counts.
 */
function mergedByFactory(e: FactoryEvent<'pr.merged'>, facts: MeasureFacts): boolean {
  const shas = new Set(facts.effects.flatMap((r) => (r.status === 'done' && r.effect.kind === 'merge' ? [r.effect.sha] : [])));
  return e.payload.headSha === undefined ? shas.size > 0 : shas.has(e.payload.headSha);
}

/**
 * The detail of `run` (ORC-298) from its ticket's facts, as `measureFacts` reads them. Pure: the journal read as `decide` reads
 * it (upcast), the attempts and the outbox; the agent's text (`lastText`) is never read, the run's token never served.
 */
export function runDetail(run: RunRecord, facts: MeasureFacts): RunDetail {
  const events = facts.events.map((e) => upcast(e as StoredEvent));
  const effects = new Map(facts.effects.map((r) => [r.id, r]));
  const timeline: TimelineEntry[] = [];
  const decisions: HumanDecision[] = [];
  const gates: Gate[] = [];
  const checks: CheckVerdict[] = [];
  const findings: Finding[] = [];
  let open: Gate | undefined;
  let state: Gate['to'] | undefined;
  let finished: FactoryEvent<'run.finished'> | undefined;
  for (const e of events) {
    timeline.push({ id: e.id, type: e.type, at: e.at, ofRun: runIdOf(e) === run.id, what: describe(e) });
    if (e.type === 'run.finished' && e.payload.runId === run.id) finished = e;
    const to = movedTo(e, effects);
    if (to !== undefined && to !== state) {
      state = to;
      if (open) Object.assign(open, { closedAt: e.at, to, closedBy: e.id });
      open = to === 'human_review' ? { gate: 'merge', openedAt: e.at, closedAt: null, to: null, closedBy: null } : undefined;
      if (open) gates.push(open);
    }
    const decision = decisionOf(e, facts);
    if (decision) decisions.push({ id: e.id, type: e.type, at: e.at, ...decision, what: describe(e) });
    const check = checkOf(e);
    if (check) checks.push(check);
    if (e.type === 'pr.reviewed') findings.push({ source: 'human', id: e.id, at: e.at, author: e.payload.author, pr: e.payload.number, kind: e.payload.kind, state: e.payload.state?.toLowerCase() ?? null });
  }
  const ends = new Map(events.flatMap((e) => (e.type === 'run.finished' ? [[e.payload.runId, e.payload] as const] : [])));
  for (const r of facts.runs) {
    if (r.sessionRole !== 'reviewer') continue;
    const end = ends.get(r.id);
    findings.push({ source: 'ai', runId: r.id, at: r.endedAt ?? r.startedAt, job: r.job, status: r.status, outcome: end?.attempt ?? null, findings: end?.output?.findings ?? [] });
  }
  // Ties on the instant (two lenses of one round) follow the journal, which both stores read in the same order: the attempts
  // are ordered by start, then by insertion on SQLite but by id on Postgres. A round without an event comes after.
  const position = new Map<string, number>();
  events.forEach((e, i) => {
    const key = e.type === 'pr.reviewed' ? e.id : runIdOf(e);
    if (key !== undefined && !position.has(key)) position.set(key, i);
  });
  const rank = (f: Finding) => position.get(f.source === 'ai' ? f.runId : f.id) ?? events.length;
  findings.sort((a, b) => a.at - b.at || rank(a) - rank(b));
  const attempts = facts.runs.map(runMeasure);
  return {
    run: {
      ...runMeasure(run),
      projectId: run.projectId,
      ticketId: run.ticketId,
      queue: run.queue,
      outcome: finished?.payload.attempt ?? null,
      infra: run.infra === true,
      labels: run.labels ? { ...run.labels, pending: pendingLabels(run.labels) } : null,
    },
    timeline,
    decisions,
    gates,
    findings,
    checks,
    steps: stepCosts(attempts),
    attempts,
    output: finished?.payload.output ?? null,
  };
}
