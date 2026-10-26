import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Parameters } from 'fast-check';
import { loadWorkflow } from '../../src/config/load-workflow.js';
import type { Workflow } from '../../src/config/workflow-schema.js';
import type { Decision } from '../../src/core/decision.js';
import { decide } from '../../src/core/engine.js';
import { reduce } from '../../src/core/reduce.js';
import { CREATES_TICKET, type FactoryEvent, type InternalEvent, type TicketState } from '../../src/core/types.js';
import { testPreset } from '../helpers/test-preset.js';
import type { Entry } from './events.js';

/**
 * Number of sequences per property: a few hundred in `npm test`, 10 000 in the `properties` CI job
 * (`NUM_RUNS=10000 npm run test:properties`). `PROP_SEED` replays the seed fast-check prints on a failure.
 */
export const NUM_RUNS = Number(process.env['NUM_RUNS'] ?? 200);
const SEED = process.env['PROP_SEED'] === undefined ? undefined : Number(process.env['PROP_SEED']);

/** fast-check parameters; `examples` (counterexamples kept on purpose) are tried before the random sequences. */
export function params<Ts extends unknown[]>(examples: Ts[] = []): Parameters<Ts> {
  return { numRuns: NUM_RUNS, ...(SEED === undefined ? {} : { seed: SEED }), examples };
}

/** Timeout of one property test, generous enough for 10 000 sequences on a CI runner. */
export const TIMEOUT = Math.max(15_000, NUM_RUNS * 20);

const packDir = join(import.meta.dirname, '../../packs/standard');
const workflows = new Map<number, Workflow>();

/** The standard pack under the test preset: `dev` and the jobs that extend it are verified, bounded at `verifyAttempts`. */
export function workflow(verifyAttempts = 2): Workflow {
  let wf = workflows.get(verifyAttempts);
  if (!wf) {
    const file = join(mkdtempSync(join(tmpdir(), 'factory-prop-')), 'workflow.yml');
    writeFileSync(file, testPreset({ verifyAttempts }).yaml);
    wf = loadWorkflow({ packDir, projectFile: file });
    workflows.set(verifyAttempts, wf);
  }
  return wf;
}

/**
 * One step of the fold: an external event decided, an event for a ticket not tracked yet (dropped as
 * `Orchestrator.handle` drops it), a duplicate dropped by the inbox, or a fact of the shell.
 */
export type Step =
  | { kind: 'decided'; event: FactoryEvent; before: TicketState | undefined; after: TicketState | undefined; decision: Decision; journalEnd: number }
  | { kind: 'ignored'; event: FactoryEvent; before: undefined; after: undefined; journalEnd: number }
  | { kind: 'duplicate'; event: FactoryEvent; before: TicketState | undefined; after: TicketState | undefined; journalEnd: number }
  | { kind: 'shell'; event: InternalEvent; before: TicketState | undefined; after: TicketState | undefined; journalEnd: number };

export interface Run {
  steps: Step[];
  /** What a durable journal would hold: external events once, then the events `decide` and the shell recorded. */
  journal: (FactoryEvent | InternalEvent)[];
  final: TicketState | undefined;
}

/** Freezes a value in depth: a `decide` or `reduce` that writes to its input throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * The step of ORC-138: a duplicate id is dropped by the inbox, otherwise `decide` runs and `reduce`
 * applies the event then the decided events, as `Orchestrator.handle` does. Facts of the shell go
 * through `reduce` only, as `Orchestrator.apply` does. Every input is frozen first.
 */
export function fold(entries: readonly Entry[], wf: Workflow): Run {
  const steps: Step[] = [];
  const journal: (FactoryEvent | InternalEvent)[] = [];
  const seen = new Set<string>();
  let state: TicketState | undefined;
  for (const entry of entries) {
    const before = state;
    deepFreeze(entry.event);
    if (entry.kind === 'shell') {
      state = before && deepFreeze(reduce(before, entry.event));
      if (before) journal.push(entry.event);
      steps.push({ kind: 'shell', event: entry.event, before, after: state, journalEnd: journal.length });
      continue;
    }
    const event = entry.event;
    if (seen.has(event.id)) {
      steps.push({ kind: 'duplicate', event, before, after: before, journalEnd: journal.length });
      continue;
    }
    seen.add(event.id);
    if (!before && !CREATES_TICKET.has(event.type)) {
      // Journaled, then dropped by the orchestrator: an event for a ticket it does not track decides nothing.
      journal.push(event);
      steps.push({ kind: 'ignored', event, before, after: before, journalEnd: journal.length });
      continue;
    }
    const decision = decide(before, event, wf);
    let next = reduce(before, event);
    for (const e of decision.events) next = reduce(next, e);
    journal.push(event, ...decision.events);
    state = next && deepFreeze(next);
    steps.push({ kind: 'decided', event, before, after: state, decision, journalEnd: journal.length });
  }
  return { steps, journal, final: state };
}

export type Decided = Extract<Step, { kind: 'decided' }>;

export function decided(run: Run): Decided[] {
  return run.steps.filter((s): s is Decided => s.kind === 'decided');
}

/** The effects, in order, of every decided step. */
export function effects(run: Run) {
  return decided(run).flatMap((s) => s.decision.effects);
}

/** A `start_run` of a job that takes the ticket's dev slot. */
export function isDevStart(e: Decision['effects'][number], wf: Workflow): e is Extract<Decision['effects'][number], { kind: 'start_run' }> {
  return e.kind === 'start_run' && wf.jobs[e.job]?.queue === 'dev';
}
