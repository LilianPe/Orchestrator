import type { Parameters } from 'fast-check';
import { expect, onTestFailed } from 'vitest';
import type { JobSpec, Workflow } from '../../src/config/workflow-schema.js';
import type { Decision, Effect } from '../../src/core/decision.js';
import { decide, historyTaint, refusesDevWork, sensitivePathsAtLaunch } from '../../src/core/engine.js';
import { carriedAtLaunch } from '../../src/core/human-message.js';
import { settles } from '../../src/core/decision-plan.js';
import { effectiveEvent } from '../../src/core/dead-letter.js';
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
 * (`NUM_RUNS=10000 npm run test:properties`). `PROP_SEED` replays a failure's seed, `PROP_PATH` its counterexample's path.
 * Without `PROP_SEED` the seed is drawn once per test file, as fast-check draws it, and set explicitly (ORC-368).
 */
const NUM_RUNS = intFromEnv('NUM_RUNS', 1) ?? 200;
export const SEED = intFromEnv('PROP_SEED', Number.MIN_SAFE_INTEGER) ?? (Date.now() ^ (Math.random() * 0x1_0000_0000));
const PATH = process.env['PROP_PATH'] || undefined;
if (PATH !== undefined && process.env['PROP_SEED'] === undefined) throw new Error('PROP_PATH replays a counterexample of PROP_SEED: set both');
/** The tests whose failure already logs the seed: one line each, however many properties they check. */
const logged = new Set<string>();

/** Each test's own seed, from the run's and its name: the properties do not all draw the same sequences. A 32-bit FNV-1a. */
export function seedOf(test: string | undefined): number {
  let h = 0x811c9dc5;
  for (const c of test ?? '') h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return SEED ^ h;
}

/**
 * fast-check parameters; `examples` (counterexamples kept on purpose) are tried before the random sequences. Called in a
 * test: its failure, a timeout included, which fast-check never gets to report, logs the seed that replays it (ORC-368).
 */
export function params<Ts extends unknown[]>(examples: Ts[] = []): Parameters<Ts> {
  const test = expect.getState().currentTestName;
  if (test !== undefined && !logged.has(test)) {
    logged.add(test);
    onTestFailed(() => console.error(`[properties] "${test}" failed: replay with PROP_SEED=${SEED} NUM_RUNS=${NUM_RUNS} (fast-check's seed ${seedOf(test)} is this test's, derived from it), and PROP_PATH from fast-check's report if it gave one`));
  }
  return { numRuns: NUM_RUNS, seed: seedOf(test), ...(PATH === undefined ? {} : { path: PATH }), examples };
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

const workflows = new Map<string, Workflow>();

/**
 * The standard pack under the test preset: `dev` and the jobs that extend it are verified, bounded at
 * `verifyAttempts`, and red CI starts `fix-ci` at most `ciFixAttempts` times. Frozen, as every property shares it.
 * `aiReview`: the fixes go back through the AI review, as the pack ships (ORC-184).
 */
export function workflow(verifyAttempts = 2, ciFixAttempts = 2, aiReview = false): Workflow {
  const key = `${verifyAttempts}:${ciFixAttempts}:${aiReview}`;
  let wf = workflows.get(key);
  if (!wf) {
    wf = deepFreeze(loadTestWorkflow(testPreset({ verifyAttempts, ciFixAttempts }).yaml, { aiReview }));
    workflows.set(key, wf);
  }
  return wf;
}

type StartRun = Extract<Effect, { kind: 'start_run' }>;

/**
 * One step of the fold: an external event decided, an event for a ticket not tracked yet (dropped as
 * `Orchestrator.handle` drops it), a duplicate dropped by the inbox, a fact of the shell, or the start
 * of the pending job by `Orchestrator.settle` once the run and its verification are over.
 *
 * `launches` (of a decided step) and `start` (of a settled one) are the runs launched, as
 * `Orchestrator.launch` hands them to the runner: with the sensitive paths of what they read then.
 */
export type Step =
  | {
      kind: 'decided';
      event: FactoryEvent;
      before: TicketState | undefined;
      after: TicketState | undefined;
      decision: Decision;
      launches: StartRun[];
      journalEnd: number;
    }
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

/** The run reads the ticket's pending feedback, as `Orchestrator.launch` decides it: the start's input, else its job's. */
export function readsFeedback(start: StartRun, wf: Workflow): boolean {
  return (start.input ?? wf.jobs[start.job]?.input) === 'feedback';
}

/** `Orchestrator.startRun` refuses the start: dev work on a merged or undelegated ticket, or on a blocked one. */
function refusesStart(state: TicketState, job: JobSpec): boolean {
  return !!refusesDevWork(state, job) || (job.queue === 'dev' && state.blocked);
}

/** A knowledge job, whatever its input: it can read the ticket and its PR, so the ticket's whole history (ORC-349). */
export function readsHistory(start: StartRun, wf: Workflow): boolean {
  return wf.jobs[start.job]?.workspace === 'knowledge';
}

/**
 * The run `Orchestrator.launch` hands the runner for a start: with the sensitive paths of the human inbox it empties
 * now, the feedback it reads (I12, ORC-274) or what its step boundary carries for the agent that implements (ORC-180).
 * A knowledge job is refused (undefined) when what it reads is untrusted: that feedback, or the ticket's history once
 * its journal holds untrusted content (ORC-349). The forge's review comments, untrusted too, are not modelled: no PR has
 * any; nor is the branch's mark (`untrustedSince`, ORC-338), which the generator's `run.started` never sets.
 */
function launch(start: StartRun, state: TicketState, wf: Workflow, journal: readonly (FactoryEvent | InternalEvent)[]): StartRun | undefined {
  const job = wf.jobs[start.job];
  const implementer = job?.queue === 'dev' && (start.resume ?? (job.session === 'resume' || job.pickup));
  const consumes = readsFeedback(start, wf) || (implementer && carriedAtLaunch(state.humanInbox).length > 0);
  const sensitivePaths = sensitivePathsAtLaunch(start.sensitivePaths, consumes ? state.humanInbox : []);
  if (readsHistory(start, wf) && (sensitivePaths || historyTaint(journal.filter(isFactoryEvent)) === 'untrusted')) return undefined;
  return deepFreeze(sensitivePaths ? { ...start, sensitivePaths } : start);
}

/** An event of the journal from outside, not one `decide` or the shell wrote: only these carry a taint. */
export const isFactoryEvent = (e: FactoryEvent | InternalEvent): e is FactoryEvent => 'taint' in e;

/**
 * The step of ORC-138: a duplicate id is dropped by the inbox, otherwise `decide` runs and `reduce`
 * applies the event then the decided events, as `Orchestrator.handle` does. Facts of the shell go
 * through `reduce` only, as `Orchestrator.apply` does. Every input is frozen first.
 *
 * Of what the orchestrator does around `decide`, the fold keeps what changes which run starts and
 * what it reads: the facts of `move` and `cleanup`, `startRun` refusing a start or keeping a dev start
 * for later (`pending.set`) while a run or a verification is in flight, `settle` starting that pending
 * job after a run result, and the sensitive paths `launch` gives the run. The launch's own facts
 * (`run.started`), timers, the scheduler queue and failed effects are not modelled: the generator
 * inserts their facts instead.
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
    if (!before && !CREATES_TICKET.has(effectiveEvent(event).type)) {
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
    const launches: StartRun[] = [];
    steps.push({ kind: 'decided', event, before, after: state, decision, launches, journalEnd: journal.length });
    if (!state) continue;
    let launched = false;
    for (const e of decision.effects) {
      // `move` and `cleanup` record their fact once carried out.
      if (e.kind === 'move') record({ type: 'status.recorded', to: e.to });
      if (e.kind === 'cleanup') record({ type: 'workspace.released' });
      // `startRun`: a dev start it does not refuse, while the run or the verification of the slot is in flight, waits as the pending job;
      // otherwise it launches, and a dev run (whose `run.started` is not modelled) holds the slot.
      if (e.kind !== 'start_run' || refusesStart(state, wf.jobs[e.job]!)) continue;
      const dev = isDevStart(e, wf);
      if (dev && (state.activeRunId || state.verifyingRunId)) {
        record({ type: 'pending.set', job: { job: e.job, input: e.input, inputText: e.inputText, resume: e.resume, sensitivePaths: e.sensitivePaths } });
        continue;
      }
      const started = launch(e, state, wf, journal);
      if (started) launches.push(started);
      if (dev) launched = true;
    }
    // `settle`: once nothing is in flight, the pending job starts, unless startRun refuses it.
    const pending = state.pendingJob;
    if (!settles(effectiveEvent(event), before, state) || !pending || launched || state.activeRunId || state.verifyingRunId) continue;
    const settledFrom = state;
    record({ type: 'pending.cleared' });
    const job = wf.jobs[pending.job];
    if (!job || refusesStart(state, job)) continue;
    const start = launch({ kind: 'start_run', ...pending }, state, wf, journal);
    if (!start) continue;
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

/** The runs a step launched, as the runner gets them: decided starts that were not kept pending, or the pending job `settle` started. */
export function launches(step: Step): readonly StartRun[] {
  return step.kind === 'decided' ? step.launches : step.kind === 'settled' ? [step.start] : [];
}

/** The effects, in order, of every decided step, with the starts of pending jobs by `settle`. */
export function effects(run: Run): Effect[] {
  return run.steps.flatMap(stepEffects);
}

/** A `start_run` of a job that takes the ticket's dev slot. */
export function isDevStart(e: Effect, wf: Workflow): e is StartRun {
  return e.kind === 'start_run' && takesDevSlot(e.job, wf);
}
