import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REFREEZE } from '../../src/checks/freeze.js';
import { effectiveEvent } from '../../src/core/dead-letter.js';
import type { Role } from '../../src/core/authz.js';
import { AUTHZ_REFUSED, decide, isFenced, mayCheck, SENSITIVE_PATHS } from '../../src/core/engine.js';
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
import { CUT_RELAUNCHES, CUT_WINDOW_MS } from '../../src/store/types.js';
import { DEBOUNCE, DEV_SESSION, PROJECT, sequences, TICKET, VERIFY_FAILURES, type Entry, type Sequences } from './events.js';
import { decided, effects, fold, isDevStart, launches, params, readsFeedback, stepEffects, TIMEOUT, workflow, type Run, type Step } from './fold.js';

/**
 * Invariants of `decide` (docs/decisions/ORC-138.md, I1 to I12) checked as properties over generated
 * sequences with duplicates and reordering (ORC-173). Each property states what the current pure
 * `decide`/`reduce` can show; the part of an invariant whose mechanism does not exist yet is an
 * `it.todo` naming the ticket that brings it. A property that today's code violates is an `it.fails`
 * per minimal counterexample, which fails on every run, whatever the seed, and only with the expected
 * assertion (catch the error and rethrow it only when its message starts with that assertion's label):
 * when the code is fixed, the `it.fails` turns red and must become an `it` that runs the property with
 * the counterexample in its `examples`. None is open today.
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
const runStarted = () => sh({ type: 'run.started', runId: 'r1', job: 'dev', queue: 'dev', claudeSessionId: 'claude-1' });
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
  describe('I3 — a frozen test leaves the freeze only through a human /refreeze', () => {
    // Two red checks of the tests step, each with its freeze, then a /refreeze by a member who is not a maintainer.
    const A = { sha: 'aaa', files: { 'a.test.ts': '1' } };
    const B = { sha: 'bbb', files: { 'a.test.ts': '2' } };
    const tests = (id: string, frozen: typeof A) => [
      sh({ type: 'run.started', runId: id, job: 'tests', queue: 'dev', claudeSessionId: 'claude-1', feedbackConsumed: false }),
      ext('run.finished', { runId: id, job: 'tests', outcome: 'success', costUsd: 0.5, turns: 3, lastText: 'fini' }),
      ext('verify.passed', { runId: id, job: 'tests', red: 'assertion', frozen }),
    ];
    const byMember: Entry = {
      kind: 'external',
      event: { ...(ext('command', { name: REFREEZE, body: '', linearSessionId: 's-q1', author: 'armand', frozen: B }).event as FactoryEvent), actor: 'u-dev', roles: ['team_member'] },
    };
    const refrozen = seq(...delegated('dev'), ...tests('r1', A), ...tests('r2', B), byMember);
    it(
      'a frozen file is dropped, or its fingerprint changes, only on a /refreeze signed by a designated maintainer',
      () => {
        holds((s) => {
          for (const step of decided(run(s))) {
            const before = step.before?.frozenTests?.files ?? {};
            const after = step.after?.frozenTests?.files ?? {};
            if (Object.entries(before).every(([path, print]) => after[path] === print)) continue;
            const e = step.event;
            expect(e.type === 'command' && e.payload.name === REFREEZE && !!e.actor && !!e.roles?.includes('maintainer')).toBe(true);
          }
        }, [refrozen]);
      },
      TIMEOUT,
    );

    it.todo('I3 on the writes: no write effect targets a frozen file (the agent writes in its sandbox; checked by factory/tests-gelés, ORC-151)');
  });
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
              // The red check's returns have their own counter: the next property.
              const resumed = step.decision.effects.filter((e) => e.kind === 'start_run' && e.input === 'verify_failures' && !w.jobs[e.job]?.red);
              relaunches += resumed.length;
              expect(relaunches).toBeLessThanOrEqual(attempts - 1);
              if (step.event.type === 'verify.failed' && !isFenced(step.decision) && !w.jobs[step.event.payload.job]?.red) {
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

    it(
      'the red check in blocking mode sends the tests step back at most red.attempts - 1 times, then blocks (ORC-123)',
      () => {
        const base = workflow();
        const tests = base.jobs['tests']!;
        const w = { ...base, jobs: { ...base.jobs, tests: { ...tests, red: { ...tests.red!, mode: 'blocking' as const } } } };
        const bound = tests.red!.attempts;
        fc.assert(
          fc.property(sequences, (s) => {
            let relaunches = 0;
            for (const step of decided(fold(s.withDuplicates, w))) {
              if (step.decision.events.some((e) => e.type === 'ticket.patched' && e.patch.redAttempts === 0)) relaunches = 0;
              const resumed = step.decision.effects.filter((e) => e.kind === 'start_run' && e.job === 'tests' && e.input === 'verify_failures');
              relaunches += resumed.length;
              expect(relaunches).toBeLessThanOrEqual(bound - 1);
              if (step.event.type === 'verify.failed' && step.event.payload.job === 'tests' && !isFenced(step.decision) && (step.before?.redAttempts ?? 0) + 1 >= bound) {
                expect(resumed).toEqual([]);
                expect(step.decision.events.map((e) => e.type)).toContain('ticket.blocked');
              }
            }
          }),
          params<[Sequences]>(),
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
            expect(step.kind === 'shell' && step.event.type === 'feedback.consumed').toBe(true);
          }
        });
      },
      TIMEOUT,
    );

    it(
      'a reply in the dev session of a delegated ticket is recorded or delivered, whatever its status (ORC-267), or refused and answered (ORC-186)',
      () => {
        const counterexample = seq(...delegated(), reply());
        holds((s) => {
          for (const step of decided(run(s))) {
            const e = step.event;
            if (e.type !== 'session.prompted' || !step.after?.delegated || e.payload.linearSessionId !== step.after.linearSessionId) continue;
            const recorded = step.decision.events.some((x) => x.type === 'feedback.appended' && x.item.body === e.payload.body);
            const delivered = step.decision.effects.some((x) => x.kind === 'start_run' && x.inputText === e.payload.body);
            // A reply the matrix refuses is not lost either: its author gets the refusal in the session.
            const refused =
              step.decision.trace.some((t) => t.startsWith(AUTHZ_REFUSED)) &&
              step.decision.effects.some((x) => x.kind === 'activity' && x.linearSessionId === e.payload.linearSessionId);
            expect(recorded || delivered || refused, 'reply in the dev session recorded, delivered or refused').toBe(true);
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
    // A repair that replays or forces such an event (ORC-175) is that event.
    const reopens = (step: Step): boolean => {
      if (step.kind !== 'decided') return false;
      const e = effectiveEvent(step.event);
      if (e.type === 'ticket.delegated') return true;
      if (e.type === 'status.changed') return e.payload.to !== null && e.payload.to !== 'done';
      return e.type === 'pr.opened' && e.payload.number !== step.before?.prNumber;
    };
    const noDevRunAfterMerge = (s: Sequences): void => {
      let merged = false;
      for (const step of run(s).steps) {
        if (reopens(step)) merged = false;
        if (merged) expect(starts(step).filter((e) => isDevStart(e, wf)), 'dev run started after pr.merged').toEqual([]);
        if (step.kind === 'decided' && effectiveEvent(step.event).type === 'pr.merged') merged = true;
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
        const debounced = seq(...delegated('dev'), reply(), ext('pr.merged', pr), ext('timer.fired', DEBOUNCE));
        const pending = seq(...delegated('dev'), runStarted(), reply(), ext('timer.fired', DEBOUNCE), ext('pr.merged', pr), runFinished('failure'));
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

    it(
      'run.lost of a dev job and verify.lost for a run that is not the awaited one emit nothing (ORC-220)',
      () => {
        holds((s) => {
          for (const step of decided(run(s))) {
            const e = step.event;
            const stale =
              (e.type === 'run.lost' && wf.jobs[e.payload.job]?.queue === 'dev' && e.payload.runId !== step.before?.activeRunId) ||
              (e.type === 'verify.lost' && e.payload.runId !== step.before?.verifyingRunId);
            if (!stale) continue;
            expect({ ...step.decision, trace: [] }).toEqual({ events: [], effects: [], timers: [], trace: [] });
          }
        });
      },
      TIMEOUT,
    );

    it(
      'an expired lease relaunches at most once: never a start while the ticket already used its relaunch, and a restart never counts (ORC-220)',
      () => {
        holds((s) => {
          for (const step of decided(run(s))) {
            const e = step.event;
            if (e.type !== 'run.lost' || wf.jobs[e.payload.job]?.queue !== 'dev') continue;
            const started = step.decision.effects.some((c) => c.kind === 'start_run');
            if (e.payload.cause === 'restart') expect(step.decision.events.some((x) => x.type === 'ticket.blocked')).toBe(false);
            if (e.payload.cause === 'lease' && (step.before?.leaseRelaunches ?? 0) >= 1) expect(started).toBe(false);
            if (step.before?.blocked) expect(started).toBe(false);
          }
        });
      },
      TIMEOUT,
    );

    it(
      'an automatic relaunch never passes the bound of the window, whatever the sequence; only a human event resets it (ORC-220)',
      () => {
        holds((s) => {
          for (const step of decided(run(s))) {
            const e = step.event;
            const before = step.before?.cutRelaunches ?? [];
            const recent = before.filter((at) => at > e.at - CUT_WINDOW_MS);
            const relaunched = step.decision.effects.some((c) => (c.kind === 'start_run' && c.relaunchOf !== undefined) || (c.kind === 'run_verify' && e.type === 'verify.lost'));
            if (relaunched && e.type === 'run.lost') expect(recent.length).toBeLessThan(CUT_RELAUNCHES);
            if (relaunched && e.type === 'verify.lost') expect(recent.length).toBeLessThan(CUT_RELAUNCHES);
            const reset = step.decision.events.some((x) => x.type === 'ticket.patched' && x.patch.cutRelaunches?.length === 0);
            if (reset) expect(['session.prompted', 'label.changed', 'status.changed', 'ticket.delegated']).toContain(e.type);
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
        if (step.kind === 'shell' && step.event.type === 'feedback.consumed') untrustedPending = false;
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
        const debounced = seq(...delegated('dev'), reply('untrusted'), ext('timer.fired', DEBOUNCE));
        // Found by fast-check once the fold modelled settle: the pending job was decided before the untrusted reply
        // came in, and settle starts it once the run's check passes, on all the pending feedback. The launch takes the
        // taint of what it reads then. (A failed run blocks the ticket: startRun then refuses the pending job.)
        const pending = (...end: Entry[]) => seq(...delegated('dev'), runStarted(), reply(), ext('timer.fired', DEBOUNCE), reply('untrusted'), ...end);
        const settled = pending(runFinished('success'), ext('verify.passed', { runId: 'r1', job: 'dev' }));
        holds(feedbackRunSandboxed, [debounced, settled, pending(runFinished('failure'))]);
      },
      TIMEOUT,
    );

    it.todo('I12 — sensitive paths and taint from the workflow and the ingestion, frozen tests included (ORC-160, ORC-131)');
  });

  describe('ORC-186 — authorization matrix, checked on the signed actor', () => {
    type Decided = ReturnType<typeof decided>[number];
    const isRefusal = (step: Decided) => step.decision.trace.some((t) => t.startsWith(AUTHZ_REFUSED));
    // A human's move to Done is a merge decision (ORC-148): refused, the ticket also goes back to Human Review, the
    // reviewed commit kept (no work: Linear shows it in Done, nothing merged); unchecked (no roles), it never merges.
    const isDone = (step: Decided) => step.event.type === 'status.changed' && (step.event.payload as { to?: string | null }).to === 'done';
    const backToReview = (e: Decided['decision']['effects'][number]) => e.kind === 'move' && e.to === 'human_review' && e.keepReviewSha === true;
    // A delegated ticket in Human Review, its PR open and its reviewed commit recorded, then two humans move it to Done.
    const doneBy = (actor: string, roles: Role[]): Entry => {
      n += 1;
      const event = { id: `ex-${n}`, type: 'status.changed', at: 1_000 * n, projectId: PROJECT, ticketId: TICKET, ...TRUSTED, actor, roles, payload: { from: 'human_review', to: 'done' } };
      return { kind: 'external', event: event as FactoryEvent };
    };
    const reviewedDone = seq(
      ...delegated('dev'),
      ext('pr.opened', pr),
      sh({ type: 'status.recorded', to: 'human_review', reviewSha: 'abc123' }),
      doneBy('u-dev', ['team_member', 'repo_writer']),
      doneBy('u-lead', ['team_member', 'repo_writer', 'repo_merger']),
    );

    it(
      'a refused human event changes no work: no run, no timer, no feedback, no unblock, only its answer, once, to a signed actor or in a session',
      () => {
        holds((s) => {
          for (const step of decided(run(s))) {
            if (!isRefusal(step)) continue;
            expect(step.decision.events, 'refused event recorded a change').toEqual([]);
            expect(step.decision.timers, 'refused event armed a timer').toEqual([]);
            expect(step.launches, 'refused event launched a run').toEqual([]);
            const answered = !!step.event.actor || !!(step.event.payload as { linearSessionId?: string }).linearSessionId;
            const answers = step.decision.effects.filter((e) => !(isDone(step) && backToReview(e)));
            expect(answers, 'refusal not answered once').toHaveLength(answered ? 1 : 0);
            for (const e of answers) expect(['activity', 'comment']).toContain(e.kind);
            // But `/refreeze` (ORC-131), refused without roles too: a freeze never opens by default.
            const refreeze = step.event.type === 'command' && step.event.payload.name === REFREEZE;
            if (!refreeze) expect(step.event.roles, 'refused an event whose roles were not resolved').toBeDefined();
            // The orchestrator resolves roles only where `mayCheck` says the matrix may be checked.
            expect(mayCheck(step.event, wf), `${step.event.type} refused where the orchestrator resolves no roles`).toBe(true);
          }
        }, [reviewedDone]);
      },
      TIMEOUT,
    );

    it(
      'an allowed human event is decided as if the matrix did not exist: the check only ever takes away',
      () => {
        holds((s) => {
          for (const step of decided(run(s))) {
            if (step.event.roles === undefined || isRefusal(step)) continue;
            const unchecked = decide(step.before, { ...step.event, roles: undefined } as FactoryEvent, wf);
            // A merge needs a checked actor: an unchecked Done never merges, the one decision the check adds to.
            if (isDone(step)) {
              expect(unchecked.effects.some((e) => e.kind === 'merge'), 'an unchecked Done merged').toBe(false);
              continue;
            }
            // So does a /refreeze (ORC-131): unchecked, it never regels.
            if (step.event.type === 'command' && step.event.payload.name === REFREEZE) {
              expect(unchecked.events, 'an unchecked /refreeze regeled').toEqual([]);
              continue;
            }
            // Only a checked delegation names the run's initiator: the one event an unchecked decision leaves out.
            const initiator = (e: InternalEvent) => e.type === 'ticket.patched' && 'initiatorId' in e.patch;
            expect({ ...step.decision, events: step.decision.events.filter((e) => !initiator(e)), trace: [] }).toEqual({ ...unchecked, trace: [] });
          }
        }, [reviewedDone]);
      },
      TIMEOUT,
    );

    it(
      'without a signed actor, nothing that would start, relaunch or feed a run goes through',
      () => {
        holds((s) => {
          for (const step of decided(run(s))) {
            if (step.event.roles === undefined || step.event.actor) continue;
            const unchecked = decide(step.before, { ...step.event, roles: undefined } as FactoryEvent, wf);
            const acts =
              unchecked.effects.some((e) => e.kind === 'start_run') ||
              unchecked.timers.length > 0 ||
              unchecked.events.some((e) => e.type === 'feedback.appended' || e.type === 'ticket.unblocked');
            if (acts) expect(isRefusal(step), `${step.event.type} went through without a signed actor`).toBe(true);
          }
        });
      },
      TIMEOUT,
    );
  });
});
