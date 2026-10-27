import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decide, isFenced, SENSITIVE_PATHS } from '../../src/core/engine.js';
import { reduce } from '../../src/core/reduce.js';
import {
  TRUSTED,
  type EventPayloads,
  type EventType,
  type FactoryEvent,
  type InternalEvent,
  type ShellEvent,
  type TicketState,
} from '../../src/core/types.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import { DEV_SESSION, PROJECT, sequences, TICKET, VERIFY_FAILURES, type Entry, type Sequences } from './events.js';
import { decided, effects, fold, isDevStart, launches, params, readsFeedback, stepEffects, TIMEOUT, workflow, type Run, type Step } from './fold.js';

/**
 * Invariants of `decide` (docs/decisions/ORC-138.md, I1 to I12) checked as properties over generated
 * sequences with duplicates and reordering (ORC-173). Each property states what the current pure
 * `decide`/`reduce` can show; the part of an invariant whose mechanism does not exist yet is an
 * `it.todo` naming the ticket that brings it. A property that today's code violates is an `it.fails`
 * per minimal counterexample, which fails on every run, whatever the seed, and only with the expected
 * assertion (`violated`): when the code is fixed, the `it.fails` turns red and must become an `it`
 * that runs the property with the counterexample in its `examples`.
 */

const wf = workflow();

// ── Hand-written sequences: the counterexamples of the known violations ──────────────────────────

let n = 0;
function ext<T extends EventType>(type: T, payload: EventPayloads[T], taint: 'trusted' | 'untrusted' = 'trusted'): Entry {
  n += 1;
  const event = { id: `ex-${n}`, type, at: 1_000 * n, projectId: PROJECT, ticketId: TICKET, ...TRUSTED, taint, payload };
  return { kind: 'external', event: event as FactoryEvent };
}
const sh = (event: ShellEvent): Entry => ({ kind: 'shell', event });
const seq = (...entries: Entry[]): Sequences => ({ unique: entries, withDuplicates: entries });
const issue = { title: 'Titre', logical: 'todo' as const, priority: 0 };
const delegated = (logical: 'todo' | 'dev' = 'todo') => [
  ext('ticket.delegated', { linearSessionId: DEV_SESSION, issue: { ...issue, logical } }),
  sh({ type: 'session.linked', linearSessionId: DEV_SESSION }),
];
const pr = { number: 1, url: 'https://forge/pr/1', branch: 'agent/rel-1' };
const runStarted = () => sh({ type: 'run.started', runId: 'r1', job: 'dev', queue: 'dev', claudeSessionId: 'claude-1', feedbackConsumed: false });
const runFinished = (outcome: 'success' | 'failure') => ext('run.finished', { runId: 'r1', job: 'dev', outcome, costUsd: 0.5, turns: 3, lastText: 'fini' });
const reply = (taint: 'trusted' | 'untrusted' = 'trusted') => ext('session.prompted', { linearSessionId: DEV_SESSION, body: 'ok', author: 'lilian' }, taint);

/** Every property gets the same generator; `examples` are tried first, before the random sequences. */
function holds(check: (s: Sequences) => void, examples: Sequences[] = []): void {
  fc.assert(
    fc.property(sequences, check),
    params(examples.map((e): [Sequences] => [e])),
  );
}

/** `holds` for a check that awaits (the store is asynchronous, ORC-132). */
function holdsAsync(check: (s: Sequences) => Promise<void>, examples: Sequences[] = []): Promise<void> {
  return fc.assert(
    fc.asyncProperty(sequences, check),
    params(examples.map((e): [Sequences] => [e])),
  );
}

const run = (s: Sequences): Run => fold(s.withDuplicates, wf);

/** Runs started while handling a step: decided by `decide`, or the pending job started by `settle`. */
const starts = (step: Step) => stepEffects(step).filter((e) => e.kind === 'start_run');

/**
 * A known violation, for an `it.fails`: the property must fail on its counterexample with the
 * assertion labelled `label`. Any other outcome returns normally, so the `it.fails` turns red: the
 * code was fixed, or the property now breaks for another reason.
 */
function violated(label: string, check: (s: Sequences) => void, counterexample: Sequences): void {
  try {
    check(counterexample);
  } catch (err) {
    if ((err as Error).message.startsWith(label)) throw err;
  }
}

describe('decide — properties over generated sequences (ORC-173)', () => {
  it(
    'decide and reduce never throw and never write their inputs',
    () => {
      // `fold` freezes every state, event, decision and the workflow in depth: a write throws in strict mode.
      holds((s) => {
        run(s);
      });
    },
    TIMEOUT,
  );

  describe('projection = replay of the journal (in memory)', () => {
    it(
      'the journal alone rebuilds the projection: after every step, reduce from no state over the journal so far gives the incremental state',
      () => {
        // In memory, over the fold's own journal: this checks that every change the step applies (decided
        // events, shell facts, pending jobs) is journaled and that reduce reads nothing else. A replay of
        // a durable journal, recorded independently of the fold, is the Postgres part below.
        holds((s) => {
          const r = run(s);
          let replayed: TicketState | undefined;
          let j = 0;
          for (const step of r.steps) {
            while (j < step.journalEnd) replayed = reduce(replayed, r.journal[j++] as FactoryEvent | InternalEvent);
            expect(replayed).toEqual(step.after);
          }
          expect(replayed).toEqual(r.final);
        });
      },
      TIMEOUT,
    );

    it.todo('projection = replay of the durable journal on Postgres, run through the harness (ORC-228)');
  });

  describe('I1 — no publication without a green verification on the same SHA', () => {
    it(
      'a job that declares verify publishes its output only on verify.passed of the run whose verification was started',
      () => {
        holds((s) => {
          const r = run(s);
          // Today's publication is the run's output (post_output) and the success move; neither carries a SHA yet.
          for (const step of decided(r)) {
            const e = step.event;
            const published = step.decision.effects.filter((x) => x.kind === 'post_output');
            if (e.type !== 'run.finished' && e.type !== 'verify.passed') {
              expect(published).toEqual([]);
              continue;
            }
            if ((wf.jobs[e.payload.job]?.verify.length ?? 0) === 0) continue;
            if (e.type === 'run.finished') {
              expect(step.decision.effects.filter((x) => x.kind === 'post_output' || x.kind === 'move')).toEqual([]);
              continue;
            }
            if (published.length === 0) continue;
            expect(step.before?.verifyingRunId).toBe(e.payload.runId);
            const started = r.journal.slice(0, step.journalEnd).some((x) => x.type === 'verify.started' && x.runId === e.payload.runId);
            expect(started).toBe(true);
          }
        });
      },
      TIMEOUT,
    );

    it.todo('I1 on the SHA: the publication carries the SHA of a green check:… with no push in between (Publisher/CheckRunner in decide, ORC-133, ORC-150)');
  });

  it.todo('I2 — no gate passed without an approval later than the last push (no gate in decide yet: human gates of ORC-212, ORC-198)');
  it.todo('I3 — a frozen test leaves the freeze only through a human /refreeze (no freeze in decide yet: ORC-131)');
  it.todo('I4 — the risk of a run never goes down (no risk in the state yet: recorded by intake, ORC-206)');

  describe('I5 — every loop has a bounded counter, red CI included', () => {
    it(
      'a verify loop of verify_attempts = N + 1 relaunches at most N times, and its (N+1)-th failure blocks',
      () => {
        // Today the bound counts attempts (verify_attempts), the target counts relaunches (ORC-138, point 8):
        // N + 1 attempts here is the target's bound N, until ORC-187 converts the unit.
        fc.assert(
          fc.property(sequences, fc.integer({ min: 1, max: 3 }), (s, attempts) => {
            const w = workflow(attempts);
            const r = fold(s.withDuplicates, w);
            let relaunches = 0;
            for (const step of decided(r)) {
              const reset = step.decision.events.some((e) => e.type === 'ticket.patched' && e.patch.verifyAttempts === 0);
              if (reset) relaunches = 0;
              const resumed = step.decision.effects.filter((e) => e.kind === 'start_run' && e.input === 'verify_failures');
              relaunches += resumed.length;
              expect(relaunches).toBeLessThanOrEqual(attempts - 1);
              if (step.event.type === 'verify.failed' && !isFenced(step.decision)) {
                const used = step.before?.verifyAttempts ?? 0;
                if (used + 1 >= attempts) {
                  expect(resumed).toEqual([]);
                  expect(step.decision.events.map((e) => e.type)).toContain('ticket.blocked');
                }
              }
            }
          }),
          params<[Sequences, number]>(),
        );
      },
      TIMEOUT,
    );

    /**
     * The red-CI loop of the pack, bounded by `limits.ci_fix_attempts` (ORC-270): between two resets
     * (green CI, a human relaunch), red CI starts `fix-ci` at most that many times, and a red CI whose
     * rule matches once the bound is reached starts nothing and blocks the ticket. The count is the
     * model's, kept from the decisions; the ticket's `ciFixAttempts` must agree with it after every step.
     */
    const redCiBounded = (r: Run, bound: number): void => {
      let fixes = 0;
      for (const step of decided(r)) {
        if (step.decision.events.some((e) => e.type === 'ticket.patched' && e.patch.ciFixAttempts === 0)) {
          // Only a green CI, another PR or a human ends the loop: a reset by anything else would let it run unbounded.
          expect(CI_RESETS, 'red-CI reset').toContain(step.event.type);
          fixes = 0;
        }
        const red = step.event.type === 'pr.checks_failed';
        const fixCi = red ? step.decision.effects.filter((e) => e.kind === 'start_run' && e.job === 'fix-ci') : [];
        fixes += fixCi.length;
        expect(fixes, 'fix-ci relaunches').toBeLessThanOrEqual(bound);
        if (step.after) expect(step.after.ciFixAttempts, 'ciFixAttempts').toBe(fixes);
        if (!red || (step.before?.ciFixAttempts ?? 0) < bound) continue;
        expect(fixCi).toEqual([]);
        const matched = step.decision.trace.includes('on.pr.checks_failed[0]');
        const refused = step.decision.trace.includes('merged: refused fix-ci');
        expect(step.decision.events.map((e) => e.type)).toEqual(matched && !refused ? ['ticket.blocked'] : []);
      }
    };
    const ciBound = wf.limits.ciFixAttempts;
    const CI_RESETS: EventType[] = ['pr.checks_passed', 'pr.opened', 'session.prompted', 'label.changed', 'status.changed', 'ticket.delegated'];
    const redCiCounterexample = seq(
      ...delegated(),
      ext('status.changed', { from: 'todo', to: 'human_review' }),
      ...Array.from({ length: ciBound + 2 }, () => ext('pr.checks_failed', { ...pr, failures: ['test'] })),
    );

    it(
      'red CI relaunches fix-ci at most ci_fix_attempts times between two resets, and the next red CI blocks (ORC-270)',
      () => {
        fc.assert(
          fc.property(sequences, fc.integer({ min: 0, max: 3 }), (s, bound) => redCiBounded(fold(s.withDuplicates, workflow(2, bound)), bound)),
          params<[Sequences, number]>([[redCiCounterexample, ciBound]]),
        );
      },
      TIMEOUT,
    );

    it(`the counterexample of ORC-173: ${ciBound} fix-ci, then the ticket is blocked for its red CI`, () => {
      const r = run(redCiCounterexample);
      expect(effects(r).filter((e) => e.kind === 'start_run' && e.job === 'fix-ci')).toHaveLength(ciBound);
      expect(r.final).toMatchObject({ blocked: true, blockReason: `CI toujours en échec après ${ciBound} tentatives de fix-ci.`, ciFixAttempts: ciBound });
    });

    it.todo('I5 — the AI review → fix loop is counted by the engine, with the same counter as red CI (ORC-184, preset bounds of ORC-187)');
  });

  describe('I6 — no human message is lost', () => {
    it(
      'feedback leaves pendingFeedback only when a run that consumes it starts',
      () => {
        holds((s) => {
          for (const step of run(s).steps) {
            const kept = step.before?.pendingFeedback ?? [];
            const now = step.after?.pendingFeedback ?? [];
            if (kept.every((f) => now.includes(f))) continue;
            expect(step.kind === 'shell' && step.event.type === 'run.started' && step.event.feedbackConsumed).toBe(true);
          }
        });
      },
      TIMEOUT,
    );

    it(
      'a reply in the dev session of a delegated ticket is recorded or delivered, whatever its status (ORC-267)',
      () => {
        const counterexample = seq(...delegated(), reply());
        holds((s) => {
          for (const step of decided(run(s))) {
            const e = step.event;
            if (e.type !== 'session.prompted' || !step.after?.delegated || e.payload.linearSessionId !== step.after.linearSessionId) continue;
            const recorded = step.decision.events.some((x) => x.type === 'feedback.appended' && x.item.body === e.payload.body);
            const delivered = step.decision.effects.some((x) => x.kind === 'start_run' && x.inputText === e.payload.body);
            expect(recorded || delivered, 'reply in the dev session recorded or delivered').toBe(true);
          }
        }, [counterexample]);
      },
      TIMEOUT,
    );

    it.todo('I6 — humanInbox, delivery to an attempt or a traced acknowledgement, for every human event and pendingJob kept (ORC-133)');
  });

  describe('I7 — never two active attempts that are not allowed', () => {
    it(
      'one decision starts at most one run in the dev slot',
      () => {
        holds((s) => {
          for (const step of decided(run(s))) {
            expect(step.decision.effects.filter((e) => isDevStart(e, wf)).length).toBeLessThanOrEqual(1);
          }
        });
      },
      TIMEOUT,
    );

    it.todo('I7 — a start is emitted only when the slot is free in the state (activeAttempts in decide, today scheduler.tryAcquire and pendingJob in the orchestrator, ORC-133)');
  });

  describe('I8 — a terminal state stays reachable from any state, and is absorbing', () => {
    it(
      '(a) from any reachable state, control.stop stops the dev work and blocks the ticket in one step',
      () => {
        const stop = { ...TRUSTED, id: 'stop', type: 'control.stop', at: 0, projectId: PROJECT, ticketId: TICKET, payload: {} } as FactoryEvent;
        holds((s) => {
          for (const step of run(s).steps) {
            if (!step.after) continue;
            const d = decide(step.after, stop, wf);
            expect(d.effects).toContainEqual({ kind: 'stop_run' });
            const after = d.events.reduce<TicketState | undefined>((t, e) => reduce(t, e), reduce(step.after, stop));
            expect(after).toMatchObject({ blocked: true, pendingJob: undefined, verifyingRunId: undefined });
          }
        });
      },
      TIMEOUT,
    );

    it.todo('I8 (a) — the cancel event leads to the terminal status cancelled (no terminal status yet: run.cancel and statuses of ORC-133)');

    // A human takes the ticket back (moves it anywhere but done, delegates it again) or a new PR opens: it is no longer delivered.
    const reopens = (step: Step): boolean => {
      if (step.kind !== 'decided') return false;
      const e = step.event;
      if (e.type === 'ticket.delegated') return true;
      if (e.type === 'status.changed') return e.payload.to !== null && e.payload.to !== 'done';
      return e.type === 'pr.opened' && e.payload.number !== step.before?.prNumber;
    };
    const noDevRunAfterMerge = (s: Sequences): void => {
      let merged = false;
      for (const step of run(s).steps) {
        if (reopens(step)) merged = false;
        if (merged) expect(starts(step).filter((e) => isDevStart(e, wf)), 'dev run started after pr.merged').toEqual([]);
        if (step.kind === 'decided' && step.event.type === 'pr.merged') merged = true;
      }
    };
    it(
      '(b) after pr.merged, no event starts a dev run (ORC-268)',
      () => {
        // A human relaunch after the merge; and, found by fast-check, a run in flight at the merge whose checks then
        // fail, a debounce armed before the merge that fires after it, and the job kept pending that settle starts.
        const relaunched = seq(...delegated(), ext('pr.merged', pr), ext('label.changed', { label: 'agent:reprendre', change: 'added' }));
        const inFlight = seq(
          ...delegated(),
          runStarted(),
          ext('pr.merged', pr),
          runFinished('success'),
          ext('verify.failed', { runId: 'r1', job: 'dev', failures: VERIFY_FAILURES }),
        );
        const debounced = seq(...delegated('dev'), reply(), ext('pr.merged', pr), ext('debounce.fired', { job: 'dev-feedback' }));
        const pending = seq(...delegated('dev'), runStarted(), reply(), ext('debounce.fired', { job: 'dev-feedback' }), ext('pr.merged', pr), runFinished('failure'));
        holds(noDevRunAfterMerge, [relaunched, inFlight, debounced, pending]);
      },
      TIMEOUT,
    );
  });

  describe('I9 — decide is deterministic and reads only its inputs', () => {
    it(
      'the same state and event give the same decision, and the same sequence the same run',
      () => {
        holds((s) => {
          const r = run(s);
          for (const step of decided(r)) expect(decide(step.before, step.event, wf)).toEqual(step.decision);
          expect(run(s)).toEqual(r);
        });
      },
      TIMEOUT,
    );

    it.todo('I9 — effect ids derived from ticket:seq:i, run ids never from randomUUID (effects carry no id yet, ORC-133)');
  });

  describe('I10 — a duplicate has no effect', () => {
    it(
      'duplicating events (same id) anywhere after their original changes neither the final state nor the effects, through the store’s inbox',
      async () => {
        // Duplicates are dropped by what drops them in `Orchestrator.handle`: `Store.recordEvent`, here on SQLite.
        // One store for every sequence, each recording its ids under its own prefix. The store answers
        // asynchronously: its answers are taken first, in order, then the fold reads them.
        const store = new SqliteStore(':memory:');
        let sequence = 0;
        try {
          await holdsAsync(async (s) => {
            const prefix = `s${++sequence}:`;
            const once = fold(s.unique, wf);
            const answers: boolean[] = [];
            for (const entry of s.withDuplicates) {
              if (entry.kind === 'external') answers.push(await store.recordEvent({ ...entry.event, id: prefix + entry.event.id }));
            }
            const twice = fold(s.withDuplicates, wf, () => answers.shift()!);
            expect(twice.final).toEqual(once.final);
            expect(effects(twice)).toEqual(effects(once));
            expect(decided(twice).map((d) => d.decision.timers)).toEqual(decided(once).map((d) => d.decision.timers));
            expect(twice.journal).toEqual(once.journal);
          });
        } finally {
          await store.close();
        }
      },
      TIMEOUT,
    );

    it.todo('I10 — the same fact under two ids (pr:…:checks:…:<at>, ui:…:<at>) is one event (ids derived from the fact, ORC-147)');
  });

  describe('I11 — fencing: a result of an inactive attempt is ignored', () => {
    it(
      'run.finished of a dev job and verify.* for a run that is not the awaited one emit nothing',
      () => {
        holds((s) => {
          for (const step of decided(run(s))) {
            const e = step.event;
            const stale =
              (e.type === 'run.finished' && wf.jobs[e.payload.job]?.queue === 'dev' && e.payload.runId !== step.before?.activeRunId) ||
              ((e.type === 'verify.passed' || e.type === 'verify.failed') && e.payload.runId !== step.before?.verifyingRunId);
            if (!stale) continue;
            expect({ ...step.decision, trace: [] }).toEqual({ events: [], effects: [], timers: [], trace: [] });
          }
        });
      },
      TIMEOUT,
    );

    it.todo('I11 — attempt:<id>:finished, check:… and effect:<id> fenced by activeAttempts and the attempt’s last SHA (ORC-133)');
  });

  describe('I12 — untrusted content never writes a sensitive path', () => {
    it(
      'a run started by an untrusted event carries the sensitive paths, and never writes the knowledge base',
      () => {
        holds((s) => {
          for (const step of decided(run(s))) {
            if (step.event.taint !== 'untrusted') continue;
            for (const e of step.decision.effects) {
              if (e.kind !== 'start_run') continue;
              expect(e.sensitivePaths).toEqual(SENSITIVE_PATHS);
              expect(wf.jobs[e.job]?.workspace).not.toBe('knowledge');
            }
          }
        });
      },
      TIMEOUT,
    );

    /**
     * A run that reads the pending feedback while part of it came from an untrusted event is launched with the
     * sensitive paths, whoever starts it: `decide`, or `settle` on the pending job. Checked on the launches, as
     * `Orchestrator.launch` hands them to the runner (ORC-274), not on the starts `decide` emits.
     */
    const feedbackRunSandboxed = (s: Sequences): void => {
      let untrustedPending = false;
      for (const step of run(s).steps) {
        if (step.kind === 'shell' && step.event.type === 'run.started' && step.event.feedbackConsumed) untrustedPending = false;
        if (step.kind === 'decided' && step.event.taint === 'untrusted' && step.decision.events.some((e) => e.type === 'feedback.appended')) {
          untrustedPending = true;
        }
        for (const e of launches(step)) {
          if (readsFeedback(e, wf) && untrustedPending) expect(e.sensitivePaths, 'feedback run without the sensitive paths').toEqual(SENSITIVE_PATHS);
        }
      }
    };

    it(
      'untrusted feedback is launched with the sensitive paths, relayed by a later trusted event (ORC-269) or read by a job pending since before it came in (ORC-274)',
      () => {
        // Relayed by the debounce: decide starts the run on all the pending feedback.
        const debounced = seq(...delegated('dev'), reply('untrusted'), ext('debounce.fired', { job: 'dev-feedback' }));
        // Found by fast-check once the fold modelled settle: the pending job was decided before the untrusted reply
        // came in, and settle starts it once the run's check passes, on all the pending feedback. The launch takes the
        // taint of what it reads then. (A failed run blocks the ticket: startRun then refuses the pending job.)
        const pending = (...end: Entry[]) => seq(...delegated('dev'), runStarted(), reply(), ext('debounce.fired', { job: 'dev-feedback' }), reply('untrusted'), ...end);
        const settled = pending(runFinished('success'), ext('verify.passed', { runId: 'r1', job: 'dev' }));
        holds(feedbackRunSandboxed, [debounced, settled, pending(runFinished('failure'))]);
      },
      TIMEOUT,
    );

    it.todo('I12 — sensitive paths and taint from the workflow and the ingestion, frozen tests included (ORC-160, ORC-131)');
  });
});
