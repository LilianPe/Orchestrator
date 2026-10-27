import type { Parameters } from 'fast-check';
import type { Workflow } from '../../src/config/workflow-schema.js';
import type { Decision, Effect } from '../../src/core/decision.js';
import { decide } from '../../src/core/engine.js';
import { SETTLES_RUN } from '../../src/core/orchestrator.js';
import { reduce } from '../../src/core/reduce.js';
import { CREATES_TICKET, type FactoryEvent, type InternalEvent, type ShellEvent, type TicketState } from '../../src/core/types.js';
import { loadTestWorkflow } from '../helpers/harness.js';
import { testPreset } from '../helpers/test-preset.js';
import type { Entry } from './events.js';

/** An integer environment variable, undefined when unset or empty; anything else than an integer >= `min` is refused. */
function intFromEnv(name: string, min: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  return n;
}

/**
 * Number of sequences per property: a few hundred in `npm test`, 10 000 in the `properties` CI job
 * (`NUM_RUNS=10000 npm run test:properties`). `PROP_SEED` replays the seed fast-check prints on a failure.
 */
const NUM_RUNS = intFromEnv('NUM_RUNS', 1) ?? 200;
const SEED = intFromEnv('PROP_SEED', Number.MIN_SAFE_INTEGER);

/** fast-check parameters; `examples` (counterexamples kept on purpose) are tried before the random sequences. */
export function params<Ts extends unknown[]>(examples: Ts[] = []): Parameters<Ts> {
  return { numRuns: NUM_RUNS, ...(SEED === undefined ? {} : { seed: SEED }), examples };
}

/** Timeout of one property test, generous enough for 10 000 sequences on a CI runner. */
export const TIMEOUT = Math.max(15_000, NUM_RUNS * 20);

/** Freezes a value in depth: a `decide` or `reduce` that writes to its input throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const workflows = new Map<number, Workflow>();

/** The standard pack under the test preset: `dev` and the jobs that extend it are verified, bounded at `verifyAttempts`. Frozen, as every property shares it. */
export function workflow(verifyAttempts = 2): Workflow {
  let wf = workflows.get(verifyAttempts);
  if (!wf) {
    wf = deepFreeze(loadTestWorkflow(testPreset({ verifyAttempts }).yaml));
    workflows.set(verifyAttempts, wf);
  }
  return wf;
}

type StartRun = Extract<Effect, { kind: 'start_run' }>;

/**
 * One step of the fold: an external event decided, an event for a ticket not tracked yet (dropped as
 * `Orchestrator.handle` drops it), a duplicate dropped by the inbox, a fact of the shell, or the start
 * of the pending job by `Orchestrator.settle` once the run and its verification are over.
 */
export type Step =
  | { kind: 'decided'; event: FactoryEvent; before: TicketState | undefined; after: TicketState | undefined; decision: Decision; journalEnd: number }
  | { kind: 'ignored'; event: FactoryEvent; before: undefined; after: undefined; journalEnd: number }
  | { kind: 'duplicate'; event: FactoryEvent; before: TicketState | undefined; after: TicketState | undefined; journalEnd: number }
  | { kind: 'shell'; event: InternalEvent; before: TicketState | undefined; after: TicketState | undefined; journalEnd: number }
  | { kind: 'settled'; event: FactoryEvent; before: TicketState; after: TicketState; start: StartRun; journalEnd: number };

export interface Run {
  steps: Step[];
  /** What a durable journal would hold: external events once, then the events `decide` and the shell recorded. */
  journal: (FactoryEvent | InternalEvent)[];
  final: TicketState | undefined;
}

/** Records an event and says whether it is new: a set of ids by default, `Store.recordEvent` to check the real inbox. */
export type Inbox = (event: FactoryEvent) => boolean;

function memoryInbox(): Inbox {
  const seen = new Set<string>();
  return (event) => !seen.has(event.id) && !!seen.add(event.id);
}

function takesDevSlot(job: string, wf: Workflow): boolean {
  return wf.jobs[job]?.queue === 'dev';
}

/**
 * The step of ORC-138: a duplicate id is dropped by the inbox, otherwise `decide` runs and `reduce`
 * applies the event then the decided events, as `Orchestrator.handle` does. Facts of the shell go
 * through `reduce` only, as `Orchestrator.apply` does. Every input is frozen first.
 *
 * Of what the orchestrator does around `decide`, the fold keeps what changes which run starts: the
 * facts of `move` and `cleanup`, `startRun` keeping a dev start for later (`pending.set`) while a run
 * or a verification is in flight, and `settle` starting that pending job after a run result. The
 * launch itself (`run.started`), timers, the scheduler queue and failed effects are not modelled: the
 * generator inserts their facts instead.
 */
export function fold(entries: readonly Entry[], wf: Workflow, inbox: Inbox = memoryInbox()): Run {
  const steps: Step[] = [];
  const journal: (FactoryEvent | InternalEvent)[] = [];
  let state: TicketState | undefined;
  // A fact of the shell, for a tracked ticket only: before its creating event, nothing records it.
  const record = (event: ShellEvent): void => {
    const before = state;
    state = before && deepFreeze(reduce(before, event));
    if (before) journal.push(event);
    steps.push({ kind: 'shell', event, before, after: state, journalEnd: journal.length });
  };
  for (const entry of entries) {
    const before = state;
    deepFreeze(entry.event);
    if (entry.kind === 'shell') {
      record(entry.event);
      continue;
    }
    const event = entry.event;
    if (!inbox(event)) {
      steps.push({ kind: 'duplicate', event, before, after: before, journalEnd: journal.length });
      continue;
    }
    if (!before && !CREATES_TICKET.has(event.type)) {
      // Journaled, then dropped by the orchestrator: an event for a ticket it does not track decides nothing.
      journal.push(event);
      steps.push({ kind: 'ignored', event, before, after: before, journalEnd: journal.length });
      continue;
    }
    const decision = deepFreeze(decide(before, event, wf));
    let next = reduce(before, event);
    for (const e of decision.events) next = reduce(next, e);
    journal.push(event, ...decision.events);
    state = next && deepFreeze(next);
    steps.push({ kind: 'decided', event, before, after: state, decision, journalEnd: journal.length });
    if (!state) continue;
    let launched = false;
    for (const e of decision.effects) {
      // `move` and `cleanup` record their fact once carried out.
      if (e.kind === 'move') record({ type: 'status.recorded', to: e.to });
      if (e.kind === 'cleanup') record({ type: 'workspace.released' });
      // `startRun`: a dev start while the run or the verification of the slot is in flight waits as the pending job;
      // otherwise it launches, and its run (whose `run.started` is not modelled) holds the slot.
      if (!isDevStart(e, wf) || !state.delegated) continue;
      if (state.activeRunId || state.verifyingRunId) record({ type: 'pending.set', job: { job: e.job, input: e.input, inputText: e.inputText, resume: e.resume } });
      else launched = true;
    }
    // `settle`: once nothing is in flight, the pending job starts (startRun refuses dev work on an undelegated or merged ticket).
    const pending = state.pendingJob;
    if (!SETTLES_RUN.has(event.type) || !pending || launched || state.activeRunId || state.verifyingRunId) continue;
    const settledFrom = state;
    record({ type: 'pending.cleared' });
    if (!wf.jobs[pending.job] || (takesDevSlot(pending.job, wf) && (!state.delegated || state.prState === 'MERGED'))) continue;
    const start: StartRun = deepFreeze({ kind: 'start_run', ...pending });
    steps.push({ kind: 'settled', event, before: settledFrom, after: state, start, journalEnd: journal.length });
  }
  return { steps, journal, final: state };
}

type Decided = Extract<Step, { kind: 'decided' }>;

export function decided(run: Run): Decided[] {
  return run.steps.filter((s): s is Decided => s.kind === 'decided');
}

/** What handling a step carried out: the decided effects, or the start of the pending job by `settle`. */
export function stepEffects(step: Step): readonly Effect[] {
  return step.kind === 'decided' ? step.decision.effects : step.kind === 'settled' ? [step.start] : [];
}

/** The effects, in order, of every decided step, with the starts of pending jobs by `settle`. */
export function effects(run: Run): Effect[] {
  return run.steps.flatMap(stepEffects);
}

/** A `start_run` of a job that takes the ticket's dev slot. */
export function isDevStart(e: Effect, wf: Workflow): e is StartRun {
  return e.kind === 'start_run' && takesDevSlot(e.job, wf);
}
