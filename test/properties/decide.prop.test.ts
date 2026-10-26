import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decide, SENSITIVE_PATHS } from '../../src/core/engine.js';
import { reduce } from '../../src/core/reduce.js';
import {
  SCHEMA_VERSION,
  type EventPayloads,
  type EventType,
  type FactoryEvent,
  type InternalEvent,
  type ShellEvent,
  type TicketState,
} from '../../src/core/types.js';
import { DEV_SESSION, PROJECT, sequences, TICKET, type Entry, type Sequences } from './events.js';
import { decided, effects, fold, isDevStart, params, TIMEOUT, workflow, type Run } from './fold.js';

/**
 * Invariants of `decide` (docs/decisions/ORC-138.md, I1 to I12) checked as properties over generated
 * sequences with duplicates and reordering (ORC-173). Each property states what the current pure
 * `decide`/`reduce` can show; the part of an invariant whose mechanism does not exist yet is an
 * `it.todo` naming the ticket that brings it. A property that today's code violates is an `it.fails`
 * carrying its minimal counterexample in `examples`, so it fails on every run, whatever the seed:
 * when the code is fixed, the `it.fails` turns red and must become an `it`.
 */

const wf = workflow();

// ── Hand-written sequences: the counterexamples of the known violations ──────────────────────────

let n = 0;
function ext<T extends EventType>(type: T, payload: EventPayloads[T], taint: 'trusted' | 'untrusted' = 'trusted'): Entry {
  n += 1;
  const event = { id: `ex-${n}`, type, at: 1_000 * n, projectId: PROJECT, ticketId: TICKET, schemaVersion: SCHEMA_VERSION, taint, payload };
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

/** Every property gets the same generator; `examples` are tried first, before the random sequences. */
function holds(check: (s: Sequences) => void, examples: Sequences[] = []): void {
  fc.assert(
    fc.property(sequences, (s) => {
      check(s);
    }),
    params(examples.map((e): [Sequences] => [e])),
  );
}

const run = (s: Sequences): Run => fold(s.withDuplicates, wf);

describe('decide — properties over generated sequences (ORC-173)', () => {
  it(
    'decide and reduce never throw and never write their inputs',
    () => {
      // `fold` freezes every state and event in depth: a write throws in strict mode.
      holds((s) => {
        run(s);
      });
    },
    TIMEOUT,
  );

  describe('projection = replay of the journal (in memory)', () => {
    it(
      'after every step, folding reduce over the journal so far gives the incremental projection',
      () => {
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
              if (step.event.type === 'verify.failed' && step.decision.trace[0]?.startsWith('fenced') !== true) {
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

    /** Stand-in bound for the red-CI loop: the standard pack declares none; ORC-187 brings the preset's. */
    const CI_RELAUNCHES = 2;
    it.fails(
      `KNOWN VIOLATION — red CI relaunches fix-ci at most ${CI_RELAUNCHES} + 1 times (pr.checks_failed has no counter)`,
      () => {
        const counterexample = seq(
          ...delegated(),
          ext('status.changed', { from: 'todo', to: 'human_review' }),
          ext('pr.checks_failed', { ...pr, failures: ['test'] }),
          ext('pr.checks_failed', { ...pr, failures: ['test'] }),
          ext('pr.checks_failed', { ...pr, failures: ['test'] }),
          ext('pr.checks_failed', { ...pr, failures: ['test'] }),
        );
        holds((s) => {
          const fixes = effects(run(s)).filter((e) => e.kind === 'start_run' && e.job === 'fix-ci');
          expect(fixes.length).toBeLessThanOrEqual(CI_RELAUNCHES + 1);
        }, [counterexample]);
      },
      TIMEOUT,
    );

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

    it.fails(
      'KNOWN VIOLATION — a reply in the dev session of a delegated ticket is recorded or delivered (lost in todo, ai_review, ready)',
      () => {
        const counterexample = seq(...delegated(), ext('session.prompted', { linearSessionId: DEV_SESSION, body: 'ok', author: 'lilian' }));
        holds((s) => {
          for (const step of decided(run(s))) {
            const e = step.event;
            if (e.type !== 'session.prompted' || !step.after?.delegated || e.payload.linearSessionId !== step.after.linearSessionId) continue;
            const recorded = step.decision.events.some((x) => x.type === 'feedback.appended' && x.item.body === e.payload.body);
            const delivered = step.decision.effects.some((x) => x.kind === 'start_run' && x.inputText === e.payload.body);
            expect(recorded || delivered).toBe(true);
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
        const stop = { id: 'stop', type: 'control.stop', at: 0, projectId: PROJECT, ticketId: TICKET, schemaVersion: SCHEMA_VERSION, taint: 'trusted', payload: {} } as FactoryEvent;
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

    it.fails(
      'KNOWN VIOLATION — (b) after pr.merged, no event starts a dev run',
      () => {
        // A human relaunch after the merge, and (found by fast-check) a run in flight at the merge whose checks then fail.
        const relaunched = seq(...delegated(), ext('pr.merged', pr), ext('label.changed', { label: 'agent:reprendre', change: 'added' }));
        const inFlight = seq(
          ...delegated(),
          sh({ type: 'run.started', runId: 'r1', job: 'dev', queue: 'dev', claudeSessionId: 'claude-1', feedbackConsumed: false }),
          ext('pr.merged', pr),
          ext('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 0.5, turns: 3, lastText: 'fini' }),
          ext('verify.failed', { runId: 'r1', job: 'dev', failures: [{ command: 'fake:check', exitCode: 1, output: 'rouge' }] }),
        );
        holds((s) => {
          let merged = false;
          for (const step of decided(run(s))) {
            if (merged) expect(step.decision.effects.filter((e) => isDevStart(e, wf))).toEqual([]);
            if (step.event.type === 'pr.merged') merged = true;
          }
        }, [relaunched, inFlight]);
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
      'duplicating events (same id) anywhere after their original changes neither the final state nor the effects',
      () => {
        holds((s) => {
          const once = fold(s.unique, wf);
          const twice = fold(s.withDuplicates, wf);
          expect(twice.final).toEqual(once.final);
          expect(effects(twice)).toEqual(effects(once));
          expect(decided(twice).map((d) => d.decision.timers)).toEqual(decided(once).map((d) => d.decision.timers));
          expect(twice.journal).toEqual(once.journal);
        });
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

    it.fails(
      'KNOWN VIOLATION — untrusted feedback relayed by a later trusted event (debounce) still starts a sandboxed run',
      () => {
        const counterexample = seq(
          ...delegated('dev'),
          ext('session.prompted', { linearSessionId: DEV_SESSION, body: 'ok', author: 'lilian' }, 'untrusted'),
          ext('debounce.fired', { job: 'dev-feedback' }),
        );
        holds((s) => {
          let untrustedPending = false;
          for (const step of run(s).steps) {
            if (step.kind === 'shell' && step.event.type === 'run.started' && step.event.feedbackConsumed) untrustedPending = false;
            if (step.kind !== 'decided') continue;
            if (step.event.taint === 'untrusted' && step.decision.events.some((e) => e.type === 'feedback.appended')) untrustedPending = true;
            for (const e of step.decision.effects) {
              if (e.kind === 'start_run' && e.input === 'feedback' && untrustedPending) expect(e.sensitivePaths).toEqual(SENSITIVE_PATHS);
            }
          }
        }, [counterexample]);
      },
      TIMEOUT,
    );

    it.todo('I12 — sensitive paths and taint from the workflow and the ingestion, frozen tests included (ORC-160, ORC-131)');
  });
});
