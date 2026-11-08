# Tests and harness

Relais is tested without real services: a **harness** mounts the orchestrator (its worker, its outbox executors, its database timers) on a simulated clock, a test database (in-memory SQLite, or Postgres in the `scenarios-pg` project) and one fake adapter per port. This page explains how to write a scenario with it.

- Unit tests: next to the code (`*.test.ts`).
- Scenarios: `test/scenarios/` (the harness, `test/helpers/harness.ts`).
- End to end: `test/e2e/`.
- Integration: `test/integration/` (Postgres).
- Isolation: `test/isolation/` (rootless container engine; and test no. 11, a real `claude -p` on a booby-trapped repository).
- Properties of `decide`: `test/properties/` (fast-check).
- Replay of recorded journals: `test/replay/` (ORC-174).
- Fault injection: `test/scenarios/faults.test.ts`; `kill -9` chaos: `test/chaos/` (ORC-163).

While working, run only the tests for the files you touched: `npx vitest run test/scenarios/harness.test.ts`.

## The Vitest projects

`vitest.config.ts` declares five projects, so that fast CI stays fast:

| Project | Command | What it covers |
|---|---|---|
| `unit` | `npm test` | unit tests, scenarios and end to end (skipped without `FACTORY_E2E=1`) |
| `integration` | `npm run test:integration` | `test/integration/`, with `DATABASE_URL` (Postgres) |
| `scenarios-pg` | `npm run test:integration` | the scenarios from `test/scenarios/` a second time, each harness on a Postgres database of its own (ORC-228), with `DATABASE_URL` |
| `isolation` | `npm run test:isolation` | `test/isolation/`, with `FACTORY_ISOLATION=1` and a rootless engine; test no. 11 (`claude-settings.test.ts`) additionally needs `claude` and a credential (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`), without which it skips itself, in CI as elsewhere |
| `chaos` | `npm run test:chaos` | `test/chaos/`: a real daemon killed by SIGKILL at random (ORC-163), on Postgres with `DATABASE_URL`, on a SQLite file otherwise |

`npm run test:all` runs all five. Without `DATABASE_URL`, the integration and `scenarios-pg` tests are skipped; without `FACTORY_ISOLATION=1`, the isolation tests are skipped. CI (`.github/workflows/ci.yml`) runs the `unit` project with typecheck and lint, the property tests on 10,000 sequences (`properties` job), the replay of recorded journals (`npm run test:replay` in the `test` job, see below), then Postgres as a service for `integration` and `scenarios-pg` (same job, `npm run test:integration`) and for chaos on 500 events (`chaos` job, see below), and rootless Podman for `isolation` (see [Isolation tests](#isolation-tests)). The only secret read by the workflows is `CLAUDE_CODE_OAUTH_TOKEN`, optional, for isolation test no. 11.

**Scenarios on Postgres (ORC-228).** The `scenarios-pg` project reuses the files from `test/scenarios/` with `test/helpers/pg-harness.ts` as its setup file: each `createHarness()` there gets its own database, cloned (`create database … template`) from a database migrated once per file, and dropped at the end of the test. Both stores thus pass the same scenarios without changing a line of them. They run in the `integration` job, which already has Postgres, rather than in `test`: the fast job keeps SQLite (a few seconds), the second pass costs about 1 min 40 more on the `integration` job (96 s on 05/11). The few scenarios written for a SQLite file killed by SIGKILL (`harnessStoreKind() === 'postgres'` skips them) have their Postgres equivalent in `test/integration/`.

**To replace a store method in a scenario:** go through `wrapStore` and a new object (`Object.assign(Object.create(inner) as Store, { … })`), never through an assignment (`store.appendInbox = …`). The Postgres harness store is a proxy, which silently ignores what is assigned to it: the fault is then not injected and the test passes without proving anything. For a test that exists for its fault, also check that the fault happened, like "a refusal is decided once" in `merge.test.ts` (ORC-290).

**Timeouts and workers on Postgres (ORC-290).** `integration` and `scenarios-pg` share at most 4 workers (the same `sequence.groupOrder`), and their hooks get 60 s (10 s by default). A `drop database` waits for a checkpoint of the whole server: that is the step that degrades. Measurements of the loop of creation, migration, 8 clones and their drops, on the local Postgres (Docker Desktop):

| Workers | Creation + migration | Clone (p90) | Drop (p90) | Drop (max) |
|---|---|---|---|---|
| 1 | 0.36 s | 0.09 s | 0.24 s | 0.24 s |
| 3 | 0.5 s | 0.10 s | 0.43 s | 0.44 s |
| 4 (chosen) | 0.9 s | 0.21 s | 0.44 s | 0.59 s |
| 6 | 0.8 s | 0.23 s | 0.59 s | 0.68 s |
| 11 (default on 12 cores) | 1 s | 0.31 s | 4.2 s | 4.4 s |

The bound is Vitest's (one worker per core minus one) capped at 4: a small CI runner keeps its single worker. It costs time on a big machine: `scenarios-pg` took 98 s with 4 workers, versus 68 s with 11, the Postgres being shared with other work in both cases.

The 60 s cover another case, which the bound does not change: a machine that stalls. On the CI of 05/11 (#99), the job had only one worker, and the runner was stalled or nearly so: `setup-node` took 5.5 min instead of 0.5 s, a checkpoint of 45 buffers 14.5 s instead of 0.2 s at most, and `open-store.test.ts` 41 s instead of 0.54 s. A drop can wait for the current checkpoint and then its own, nearly 30 s at that pace, and a creation with migration just as long: 60 s leave a margin of two. It is a timeout for hooks only, not a guarantee. A test's body then still had its 30 s, cloning its database included: at that pace, a 0.4 s test would exceed 30, and a stall like that one can still make the job fail. No test timed out that day, but most were skipped. A truly frozen Postgres will moreover take 60 s per hook to report itself, with no duration limit on the job.

**Under load (ORC-290, 07/11).** The `integration` job run in a loop on a machine shared with other suites (Windows, Postgres in Docker Desktop) took 10 to 27 min instead of 1 min 40: a simple `select 1` cost 6 ms there. What failed there, and its fix:

- A wait bounded at 1 s, the `vi.waitFor` default, on worker work that goes through Postgres. A held check, publication or call is watched for through a signal, with no timeout of its own: `h.checks.started(n)`, `h.publisher.holdNext()` (`{ started, release }`). What can only be polled (the dead letter of a refused event) waits 10 s.
- The 30 s per-test timeout. A scenario chains up to 1,737 queries, one at a time ("a later tests step…" and "/refreeze by the maintainer…" in `freeze.test.ts`, measured by counting the queries of the `pg` client); under this load, 41 s, i.e. 24 ms per query. `scenarios-pg` therefore has 90 s per test, a margin of two over this measured worst case. `integration` keeps 30 s; `open-store.test.ts` there creates and drops its unmigrated database in its hooks, no longer in the test.
- Dropping a scenario's database, more than 60 s in the hook: it forces a checkpoint of the whole server. No longer waiting for it at the end of the test was tried and removed: databases and their connections piled up until `too many clients already`. This cost of one database per test remains (a schema per test would not have it: follow-up ticket). A client still checked out by the test, cut off by the forced drop, is no longer an uncaught exception that fails the whole pass: `PgStore` listens to every client, checked out or idle (`listenForPoolErrors`, which also applies to the daemon when Postgres restarts). A connection lost during the test, on the other hand, does fail it.
- Tests that share a database and empty it between themselves (`orchestrator-pg.test.ts`, `worker-pg.test.ts`): the background work of the previous harness, a run finishing, wrote its `attempt:id-1:finished` into the next test's database, where it finished the run with the same id. These files stop their harnesses after each test: `afterEach(trackHarnesses())` stops the runs, waits until nothing is left to do and until the in-flight store calls have returned, then kills the process.
- Two orderings that nothing guarantees: the result of a `start_run` and that of its run (`worker.test.ts`), a pause and a delegation sent without waiting for the first (`orchestrator-pg.test.ts`, an engine bug tracked by ORC-335: in the meantime, the test waits for the pause).

## The fake adapters

One fake per port, all mounted by `createHarness()`:

| Port (MVP doc) | Interface | Fake | What it offers the scenario |
|---|---|---|---|
| Tracker | `Tracker` (`src/adapters/tracker/types.ts`) | `h.tracker` (`FakeTracker`) | `addIssue`, `calls`, `activities(sessionId)`, `comments(identifier)`, `agentSessions(identifier)`, `externalUrls(sessionId)`, `written()` (these reads, for the conformance suite), `setStates(teamKey, statuses)` (catalog per team, by default the statuses of the loaded workflow; a status outside the catalog is rejected) |
| Forge | `Forge` (`src/adapters/forge/types.ts`) | `h.forge` (`FakeForge`) | `setPr`, `setReviewComments`, `offline` (true: every read rejects, like an unreachable forge) |
| AgentRuntime | `Runner` (`src/adapters/runner/types.ts`) | `h.runner` (`FakeRunner`) | `enqueue({ events, outcome, turns, hold })`, `release(runId)`, `requests`; caps enforced: `turns` beyond `limits.turns`, or a held run when `h.advance(ms)` brings `h.clock` to `limits.durationMs` since its start, ends in `limit` (advancing `h.clock` alone does not end it) |
| SandboxProvider | `SandboxProvider` (`src/adapters/sandbox/types.ts`) | `h.sandboxes` (`FakeSandboxProvider`) | `create`, `destroy`, `active()`, `created`, `destroyed` |
| CheckRunner | `CheckRunner` (`src/adapters/checks/types.ts`) | `h.checks` (`FakeCheckRunner`) | `failNext(output)`, `enqueue(result)`, `holdNext()`, `started(n)`, `calls` |
| Publisher | `Publisher` (`src/adapters/publisher/types.ts`) | `h.publisher` (`FakePublisher`) | `publish`, `asked`, `published`, `refuseNext(code, reason)`, `holdNext()`; the published PR appears in `h.forge`, open, checks pending |

Worktrees also have their fake, `h.workspaces` (`FakeWorkspaces`).

The MVP doc's **AgentRuntime** is the current `Runner`: its fake is `FakeRunner`, and it is not renamed as long as the port does not change shape.

What is wired into the engine today:

- `h.checks` runs the jobs' checks (a job's `verify`). A scenario can pass its own `verify` to `createHarness({ verify })`: it answers instead of the default green, once the `h.checks` queue is empty (`failNext`, `enqueue`, `holdNext`), and `h.checks.calls` still records every call.
- `h.publisher` publishes what `verify` found green (ORC-125), when `h.workspaces.heads` gives the worktree a commit: without a commit, nothing to publish. `h.sandboxes` is only called in a `sandboxed` harness.

`FakePublisher` goes through `FakeForge.ensurePr`: an open PR set by `h.forge.setPr` is found, and its head becomes the published sha. It does not know about ancestry: a branch that has moved is played with `h.publisher.refuseNext('moved')`.

These interfaces are **minimal**: they carry what the fakes need. Their contract (methods, idempotency, errors, fencing) is in [`docs/ports/`](ports/README.md), one sheet per port; each fake passes its port's conformance suite (`test/contracts/`), and a fake you modify must keep passing it. Error and effect cases also have their negative controls (`test/contracts/negative-controls.test.ts`, [details](ports/README.md#negative-controls)).

## The simulated clock

`h.clock` is a `FakeClock`, which the store also reads: outbox and queue leases, backoffs, due rows. `await h.advance(ms)` advances the clock, ends in `limit` the held runs whose duration cap is reached, fires the due timers from the `timers` table (`TimerService.tick`, which writes `timer.fired` to the inbox; today only debounce sets one through a rule), runs the worker as its loop would (`orch.poll()`: effects whose backoff or lease has expired, rows that were waiting for them) and waits until the orchestrator has processed everything. No scenario waits for a real delay: a 20 ms backoff goes by with `h.advance(20)`.

## Writing a scenario

```ts
import { describe, expect, it } from 'vitest';
import { createHarness } from '../helpers/harness.js';

describe('my behavior', () => {
  it('a run held open keeps the ticket in dev', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Export the audits as CSV from the audit list.' });
    h.runner.enqueue({ hold: true }); // the run stays open until h.runner.release(runId)
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.advance(180_000);
    expect(await h.ticket()).toMatchObject({ logical: 'dev' });
  });
});
```

- `h.tracker.addIssue({ identifier, title })` sets a default description that is long enough. A description passed to the fake must be at least 30 characters: otherwise the standard pack's pickup check (`has_description`) blocks the ticket and no run starts.
- `h.send(type, payload, ticketId?)` submits an event (ticket `REL-1` by default) and waits for its processing to finish.
- `await h.ticket()` reads the ticket's state from the store (asynchronous, like the whole store). `createHarness({ store })` runs the harness on a given store rather than on its database (the SQLite file a killed process left behind); this store keeps its own clock, so `advance` expires neither lease nor backoff in it. `createHarness({ wrapStore })` wraps the database's store, whichever it is (a store that fails on purpose): this is the preferred form, the scenario then passes on both stores.
- `h.restart()` cleanly stops the orchestrator and starts a fresh one on the same database, like `relais up` on restart. `h.restart({ mode: 'brutal' })` discards the process like a `kill -9`: no stop, no wait, no cleanup. Its store is cut off (`mortal` in `harness.ts`): its calls not yet sent never go out, those in flight complete in the database without anyone receiving the result; its promises and timers stay frozen. Its adapters are too (`gate`, ORC-163): a dead process no longer comments, no longer posts activities, no longer launches runs. Another process restarts on the same database; the effects the dead one had claimed stay `running` there until their lease expires, which is passed with `h.advance`. `h.store` and `h.orch` are always those of the living process. Example: `test/scenarios/restart.test.ts` (an undecided event in the inbox, a claimed effect half done, a due timer, then nothing lost and no visible duplicate).
- `h.checks.holdNext()` holds the next check in progress and returns the function that finishes it (green by default, or the result passed). `h.send` and `h.advance` wait for checks in progress to finish: only await the send after releasing the check, and wait for the held check to have started with `await h.checks.started(n)` (example in `test/scenarios/harness.test.ts`), not with `vi.waitFor`, bounded at 1 s.
- `createHarness({ projectYaml })` overrides the standard pack's `workflow.yml`, like a project's `.relais/workflow.yml` file.

## The test preset

`testPreset()` (`test/helpers/test-preset.ts`) describes a minimal sequence made of dummy steps, with its bounds spelled out, for scenarios and future property tests (ORC-173):

- `build`: an agent step (the `dev` job);
- `verify`: a check step (`fake:check`, run by `h.checks`), bounded by `bounds.verifyAttempts`.

`bounds.ciFixAttempts` (default 2, `limits.ci_fix_attempts`) bounds the red-CI loop: `fix-ci` launched at most N times, then the next red CI blocks the ticket. It accepts 0, which has a meaning of its own (block on the first red CI).

`build` also covers the jobs that extend `dev` (`dev-feedback`, `fix-ci`): they inherit its `verify`, as in the engine. Every agent run, human feedback or red CI included, is therefore followed by a check that consumes the `h.checks` queue and the same counter.

With `verifyAttempts: N`, each `verify` failure relaunches the agent on the same session, and the **N-th failure blocks the ticket**. A green check resets the counter to zero.

```ts
const preset = testPreset({ verifyAttempts: 3 });
const h = createHarness({ preset });
for (let i = 0; i < preset.bounds.verifyAttempts; i++) h.checks.failNext('1 failing test');
// … delegation: 3 runs, 3 checks, then the ticket is blocked
expect(await h.ticket()).toMatchObject({ blocked: true });
```

A property test reads its bounds from `preset.bounds` instead of copying them. `verifyAttempts` is at least 1: the `workflow.yml` schema accepts 0, which the engine treats as 1, and the preset rejects this ambiguity. The preset is layered on top of the standard pack; `projectYaml` and `preset` do not combine.

The production preset, `factory/default`, and its other counters (review, red CI) arrive with ORC-187. The example scenario that uses each new fake and the preset is `test/scenarios/harness.test.ts`.

## Property tests for `decide`

`test/properties/decide.prop.test.ts` checks the invariants of `decide` decided by [ORC-138](decisions/ORC-138.md) (I1 to I12) on event sequences generated by fast-check (ORC-173):

- `events.ts` generates a ticket's inbox: events from `src/core/types.ts` (one generator per type; a type added without a generator does not compile) mixed with the facts the orchestrator records around its effects (`run.started`, `pending.set`…), with fragments that chain a run, its check, the `verify` loop, red CI, forge reports (CI, merge, PR closed without merge), a reply followed by its debounce. The sequence is then **shuffled** (neighbor swaps, a full shuffle one time in eight) and then receives **duplicates** with the same id. Isolated events and human messages from outside are untrusted one time in five; chained fragments (attempt, `verify` loop, red CI, forge reports) stay trusted, as do the events the factory produces itself (`run.finished`, `verify.*`, `timer.fired`, `control.*`), which their producers mark trusted. One human message in three carries a signed actor and the roles resolved for it (ORC-186: member who writes and merges, member without GitHub rights, GitHub writer outside the team, person without a role, or no actor for an untrusted event), and the opening delegation is signed one time in four; the others carry no roles, like the rows journaled before ORC-186, and `decide` checks nothing on them.
- `fold.ts` folds the sequence using the ORC-138 step, like `Orchestrator.handle`: an id already seen is ignored, an event for an unfollowed ticket is journaled without a decision, otherwise `decide` then `reduce`. It also reproduces what, around `decide`, changes the runs that start: the `move` and `cleanup` facts, the job put on hold (`pending.set`) when a dev start falls during a run or a check, the start of that job by `settle` after a run result, the refusals of `startRun` (merged, non-delegated or blocked ticket) and the sensitive paths that `launch` gives the run depending on the feedback it reads (`launches` of a step, ORC-274; the forge's review comments are not modeled), and its refusal of a knowledge job whose reading is untrusted, the ticket's history included once its journal holds untrusted content (ORC-349; the branch's mark `untrustedSince` is not modeled). The launch facts (`run.started`), timers and the scheduler queue are not modeled: the generator inserts their facts. Every state, event, decision and the workflow are deep-frozen: a `decide` or a `reduce` that writes to its input fails.

One property per invariant, on what `decide` carries today. The part of an invariant whose mechanism does not exist yet (SHA, gates, freeze, risk, `humanInbox`…) is an `it.todo` that names the ticket bringing it. An invariant the code violates today is an `it.fails` per minimal counterexample, which replays that counterexample: it fails on every run, whatever the seed, and only on the expected assertion (any other error turns it red); the day the code is fixed, it turns red, so that it gets changed into an `it` that runs the property with the counterexample in `examples`. I10 deduplicates through `Store.recordEvent` (in-memory SQLite), like the orchestrator. "Projection = replay" is checked in memory, on the fold's journal: it shows that every applied change is journaled and that `reduce` reads nothing else; the replay of a durable journal, recorded by the store, is the replay oracle below (ORC-174). For the authorization matrix (ORC-186): a refused event changes nothing in the work (no run, no timer, no kept feedback, no unblocking) and has only one reply, none without a signed actor or session; only the events that `mayCheck` designates are refused; an authorized event is decided as without the matrix; without a signed actor, nothing that would launch, relaunch or feed a run gets through. A refused reply counts as handled for I6: its author receives the refusal in the session. The recorded journal `authz-refused-then-allowed` (replay) keeps the roles of each human event, a refusal and an authorized action; chaos signs one event in seven by someone outside the team, whose refusal goes through the outbox like any effect.

| Variable | Default | Role |
|---|---|---|
| `NUM_RUNS` | 200 | sequences per property; CI runs 10,000 |
| `PROP_SEED` | random | replays the seed fast-check prints on failure |

```bash
npm test                                   # properties included, 200 sequences
NUM_RUNS=10000 npm run test:properties     # like the CI `properties` job
PROP_SEED=149083903 npm run test:properties
```

## The replay oracle

Since `decide` is pure, replaying a ticket's journal must yield the same decisions again (ORC-174). What is needed to redo them is recorded in the decision transaction itself, next to the journal row: the `decision_trace` table (one row per decision, keyed by the event's id; on Postgres, the initial schema's table, column `decision`), with the row's number in the ticket's journal, the decision's clock (`at`), the hash of the workflow the ticket is pinned to, the projection read under the lock (`before`), then what the decision wrote: new projection, outbox effects, timers, timer resets, and the `trace` from `decide` (kept for reading, not compared). `Store.ticketJournal` reads back a ticket's journal with its decisions.

`src/runtime/replay.ts` redoes each decision through `planDecision` (`src/core/decision-plan.ts`), the pure function that the orchestrator's decision transaction also calls, after the upcasters. Each decision starts again from **its own** recorded projection, not from the output of the previous one: between two decisions, the orchestrator also changes the projection outside decisions (`apply`: run launched, worktree prepared, status moved), and those changes are not decisions. Journal rows without a recorded decision (written before ORC-174, or by `recordEvent`) are counted and read, not compared.

**Recorded journals.** `test/replay/journals/` contains journals exported in the `factory replay --export` format (`format: 1`, `projectId`, `ticketId`, `workflows` by hash, `entries`: `{ event, decision }`). For lack of real journals for now, they are recorded from harness scenarios (`test/replay/scenarios.ts`); `review-merge-done.v1.json` is the same journal as `review-merge-done.json` with its `status.changed` written as before version 2 of the schema (`ticket.moved`, without version or taint), so that the replay goes through the upcaster; `check-failed-then-feedback.v2.json` is that journal as the engine before ORC-161 recorded it (schema version 2: `debounce.fired`, timers tied to a job), kept as is (`npm run replay:record` does not rewrite it) so that replaying an old journal stays green; `dead-letter-then-repair.json` contains an event set aside then repaired (`dead_letter.added`, `dead_letter.repaired`, ORC-175); `signed-actor-then-untrusted.json` passes a delegation through Linear ingestion (signed actor, `trusted`), then an untrusted reply and `retiens`, without an actor: the feedback carries its taint to the `dev-feedback` run (sensitive paths) and `remember` is refused (ORC-160); `human-reply-during-run.json` passes an instruction and a question classified during a run, the grouping ends without launching anything, and the end of the work hands them over (ORC-180); a recording writes `humanInbox` in the recorded tickets (`before`, `ticket`), and the `*.pre-orc-310.json` copies below keep the older `pendingFeedback`, which the replay reads back through `upcastTicket`; `merge-revert-ci.json` passes through GitHub ingestion two attempts of a CI run, the merge with its merge commit, that commit pushed to the default branch, then its revert three days later: `ci.run_completed` and `default_branch.pushed` are traced without deciding anything (ORC-278). They are replayed on every PR, by `npm test` (`test/replay/replay.test.ts`) and by the `npm run test:replay` step of the CI `test` job (`factory replay test/replay/journals`, which also fails on an unreadable journal or one without decisions).

Regression replay redoes each decision on the version of the workflow the ticket was pinned to, kept in the journal: it guards the **engine** (`decide`, `reduce`, `planDecision`, the upcasters). A change to the **preset** or the pack does not show up there, since the ticket stays on its old version; `test/replay/replay.test.ts` therefore also replays each recorded journal as a what-if on its scenario's current workflow (standard pack and the preset from `scenarios.ts`): a pack change that changes one of their decisions turns red, on the exact event.

**Journals from before the block comment.** `*.pre-orc-196.json` are the journals of the scenarios in which a ticket gets blocked, as the engine before ORC-196 recorded them: pinned to a workflow version without `blockComment`, they go through regression replay, never what-if, and `npm run replay:record` does not rewrite them. They prove that an already started ticket decides bit for bit as before. `blocked-then-comment-resumes` records today's path, classified comment included. The merge with ORC-180 re-recorded only that one: the others keep `pendingFeedback`, read back through `upcastTicket`. When the factory's messages moved to English (ORC-331), every journal, these included, had its recorded texts swapped for the English ones and nothing else: a script swapped each recorded string the replay reported as divergent, and refused any other divergence. A live database may still hold those French forms (a block reason, a saved merge refusal): they are kept in `src/core/legacy-messages.ts`, so a ticket started before that change decides as before. Since ORC-345 the engine decides on a block's kind (`blockKind`) and on a merge refusal's `headMoved`, never on a sentence: the recorded tickets, which hold only the reason, go through `upcastTicket`, which gives a blocked ticket its kind from its reason, the one place that still reads it (`src/core/upcast.ts`). No journal was re-recorded for it: the kind the engine sets is the one the upcaster reads back, which `src/core/block-cause.test.ts` checks for every block `decide` writes.

**A change that must change a decision.** The replay turns red and names the event. If the change is intended, re-record the scenario journals (`npm run replay:record`) and review their diff in the PR; a real journal is not re-recorded, it is replaced with a new export. To see the effect of a new preset before deploying it: `factory replay test/replay/journals --what-if <workflow.yml>`.

**A change that changes what a scenario records, without changing a decision.** The replay itself stays green: it starts again from the inputs the journal recorded (event, `before` projection, pinned workflow) and never rebuilds them. A change to the pack or the preset (the pinned workflow and its hash), to a projection (a field of `before` or `ticket`) or to an event's payload would therefore leave the committed journals stale without flagging anything (ORC-307). `test/replay/replay.test.ts` compares each committed journal, character for character, with the one its scenario records today (the same recording as the file's other tests, made once per scenario) and turns red on a gap, naming the journal and the first path that differs. For that, a recording is deterministic: `record` fixes the instance id the effect keys are salted with (`instance-id` in the store), which also appears in the id of `publish.refused`. Then run `npm run replay:record` and commit the journals' diff in the same PR, reviewed as for a changed decision. `check-failed-then-feedback.v2.json`, which the recorder does not write, is not compared.

**Journals from before the freshness check.** `*.pre-orc-310.json` are the scenario journals as main held them when that check arrived (ORC-310), kept as is: recorded before ORC-180, their tickets carry `pendingFeedback`, read back through `upcastTicket`; pinned to the pack as it was before it moved to English (ORC-330), with only the texts the replay compares swapped for the English ones (ORC-331, above), they prove that a ticket started before those changes decides as before. Like `*.pre-orc-196.json`, they go through regression replay, never what-if, `npm run replay:record` does not rewrite them, and the freshness check does not compare them. The scenario journals of the same name were re-recorded once by ORC-310: `humanInbox`, today's pack and its English texts, the `commands` and `output` of a run result, the `activeStart`, `untrustedSince` and `blockKind` of the projection.

**Adding real journals.** On an instance: `factory replay --export <ID> --out test/replay/journals/<id>.json` (with `FACTORY_HOME` and, on Postgres, the instance's `FACTORY_DATABASE_URL`). A journal contains the text of the events (ticket title, replies in the thread, comments): review it before committing it, or keep only tickets without sensitive content. A real journal is replayed as a regression; its what-if against its project's preset is run by hand (`factory replay <journal> --what-if <the project's .factory/workflow.yml>`). Only decisions made since ORC-174 are recorded: for an older ticket, only the latest decisions are compared.

## Fault injection and `kill -9` chaos

ORC-163 cuts the chain at each of its links and checks that after the cut, then the recovery, **no event is lost** and **no effect is visibly done twice**.

**The cut points** (`test/helpers/faults.ts`). Nothing is added to production code: each point is a wrapper around a port that the harness gives the orchestrator (the store, the fake tracker, the fake runner), set by `createHarness({ faults })`. A `Faults` carries at most one planned fault, `{ point, mode, match?, nth? }`: on the n-th pass through the point (filtered by `match`, on the event or the effect), it throws a `FaultError` (`throw`) or kills the process (`kill`: the `mortal` of its life dies, as under `kill -9`, and the call never answers). The points, in chain order:

| Point | Where |
|---|---|
| `webhook.accept` | before an event from outside is written to the inbox: the producer gets no answer |
| `inbox.write` | after an inbox row is written, before its author learns it: the answer is lost |
| `decide.before` | decision transaction, before `decide` |
| `decide.after` | in the transaction, after `decide`, before the COMMIT: rolled back (a `kill` there also throws, so that the database rolls back, as for a real killed process) |
| `decide.commit` | after the COMMIT, before the worker learns it |
| `outbox.claim` | after an outbox row is claimed (its lease committed) |
| `effect.before`, `effect.after` | around an effect's external call (fake tracker or runner), attributed to the current outbox row |
| `effect.complete` | after the row's completion is committed (its `effect:<id>` result in the inbox) |
| `timer.fire`, `timer.fired` | before the transaction that fires a due timer, after its COMMIT |
| `run.result` | before the result of a run or a check is written to the inbox |
| `run.write`, `run.written` | at a launch, before and after the first write of its attempt (its start marker already names it, ORC-277), before the runner starts it |

`test/scenarios/faults.test.ts` plays a scenario (delegation, run, reply in human review, its debounce, the feedback run) under each point, in `throw` then in `kill`, on SQLite and, in `scenarios-pg`, on Postgres. The driver behaves as a producer: an event without an answer is resent with the same id, as Linear resends a webhook; a killed process is replaced by another on the same database (`restart({ mode: 'brutal' })`), then the clock passes the leases and backoffs.

**The checker** (`checkChain`). Once everything has settled: each acknowledged event is journaled exactly once; the inbox, the outbox (no `pending`, `running` or `dead`) and the dead letters are empty; each ticket's journal, exported, is replayed bit for bit by the oracle (ORC-174), each row with its decision; no visible call (comment, activity, link, run launch) is made twice for the same outbox row. Calls to the fake tracker and the fake runner are attributed to the outbox row the process was executing (the `Faults` registry); moving a ticket or setting a label is idempotent and is not counted. A run launched twice for the same outbox row, dev or question, is a violation: the start marker names the attempt before it is written, and the resumed start that finds it relaunches nothing (ORC-277); `recover()` resumes the cut-off attempt: reattached, or relaunched by `run.lost` under a start row of its own, which is not a duplicate (ORC-220); a question remains to be asked again. Any other visible effect redone is classified separately (`atLeastOnce`): it is the outbox's "at least once", which ORC-162 closes by making every effect idempotent. Since ORC-162, the case of `post_output` cut after its external call is an `it`: the replay finds the already posted activity. Since ORC-277, a question's run cut after its launch is an `it` (launched once, single message: « Ask the question again »), the `run.write` point cuts a launch before its attempt is written (question as well as dev: replayed, launched once, without any resume message), and the `run.written` point after, before the runner, including for a question pulled from the queue by `drain` (released after its lease, not relaunched). A launch by `drain` has no outbox row: the checker does not attribute its calls to it, and this test counts the fake runner's launches. In chaos, the fake tracker of each life of the daemon starts from the writes of previous lives (comments, activities, links, labels, statuses, read back from the calls file), as Linear keeps them when the daemon restarts: without this, a replayed effect could not find anything.

**Chaos** (`test/chaos/`). `daemon.ts` is a real process: the orchestrator, its worker, its outbox executors and its timers on Postgres (or a SQLite file), with the fake adapters, started like `factory up` (`recover`, timers, `tick`, heartbeat, worker loop). Its runs die with it, like lost containers: each life relaunches their steps, which exercises `run.lost` and the start markers. Its runs last a few tens of milliseconds, so that cuts fall during them. The driver (`chaos.test.ts`) sends it Linear events over IPC on 20 tickets (delegations, replies, questions, `agent:stop`, replies by comment, move to AI review), faster than it processes them, and kills it with `SIGKILL` at a random moment after each start (`TerminateProcess` on Windows), then starts another one on the same database, the simulated clock advanced past the lease of the dead one's claims. An event is acknowledged after it is written to the inbox; an event without an answer is resent to the next daemon. Each visible call is appended, at the moment it acts, to a file that survives the processes. At the end, with no more cuts, the last daemon finishes the work, then `checkChain` checks the same things as for the cut points. A ticket cut too often ends up blocked by the relaunch bound (ORC-220): that is a normal result, not a violation, which the checker does not have to recognize since it judges neither the block nor a ticket's final state, and the summary gives their number. Strict mode is not relaxed for it. Unlike the harness's `mortal`, the cut is the kernel's: a transaction in progress is rolled back by the database.

| Variable | Default | Role |
|---|---|---|
| `CHAOS_EVENTS` | 100 | events sent; one cut every ten, at least three |
| `CHAOS_SEED` | random | seed of the events and cut delays, printed on every pass |
| `CHAOS_TICKETS` | 20 | tickets the events are spread over |
| `CHAOS_RUN_MS` | 150 | maximum duration of a run: longer, the cuts cut more of them and more steps are relaunched (ORC-220) |
| `CHAOS_STRICT_EFFECTS` | strict | a visible effect redone (`atLeastOnce`) fails the test (ORC-162); `0`: it is only displayed. A run launched twice for the same outbox row, question included (ORC-277), always fails |

```bash
npm run test:chaos                                              # 100 events, on a SQLite file
DATABASE_URL=postgres://… CHAOS_EVENTS=500 npm run test:chaos   # like the CI `chaos` job
DATABASE_URL=postgres://… CHAOS_SEED=4242 npm run test:chaos    # replays a seed
```

**Why a CI job of its own, at 500 events.** The ORC-163 criterion is 500 events on Postgres, in a dedicated job. 500 events means about fifty cuts and as many starts of a `tsx` process: about a minute and a half on a workstation, too much for the `test` job, which stays on SQLite and within a few seconds. The `chaos` job runs in parallel with the others, with its own Postgres: it does not lengthen the PR beyond the slowest job, and every PR passes the full criterion rather than a reduced version. The seed changes on every pass, to explore other cut moments, and is shown in the failure message. The exact moments the cuts fall depend on the machine: replaying a seed yields the same events and the same delays, not necessarily the same interleaving. Locally, the default of 100 events runs in about twenty seconds.

## Isolation tests

`test/isolation/` checks an attempt's sandbox (`ContainerSandboxProvider`, ORC-204) against a real engine. Everything is skipped without `FACTORY_ISOLATION=1`. The engine is `FACTORY_CONTAINER_CLI` (`podman` by default), the image `FACTORY_RUNNER_IMAGE` (by default the public image `node:24.22.1-bookworm-slim`, so that CI does not have to build `docker/runner.Dockerfile`). Locally under Docker: `FACTORY_ISOLATION=1 FACTORY_CONTAINER_CLI=docker npx vitest run --project isolation` (only `rootless.test.ts` then fails, it requires Podman). Each file destroys the containers it created (`test/isolation/helpers.ts`); the image is pulled once per run (`test/isolation/global-setup.ts`).

| File | What it checks |
|---|---|
| `sandbox.test.ts`, `rootless.test.ts` | the `SandboxProvider` contract, rootless engine, `--network none`, no engine socket, `/work` owned by the daemon's uid, nothing left after `destroy` |
| `isolation-01-runtime.test.ts` (no. 1) | no capabilities (`CapEff` and `CapPrm` at 0), `NoNewPrivs` at 1, `mount` refused, `/proc/sys` read-only, pid 1 is the container's `sleep infinity` and no host process is visible. `unshare -U` refused: under Docker only, its seccomp profile forbids it; Podman's leaves it to the kernel, whose answer depends on the host (sysctl, AppArmor) |
| `isolation-02-kernel.test.ts` (no. 2) | an active seccomp filter (`Seccomp: 2`); `keyctl(KEYCTL_GET_KEYRING_ID, KEY_SPEC_SESSION_KEYRING)`, which a kernel without a filter accepts, refused with `EPERM` under Docker, whose default seccomp profile forbids it; Podman's allows it, so the check is skipped under Podman. The image has neither `keyctl` nor `strace`: the call goes through `perl`'s `syscall` (present in every Debian image), by number, for x86_64 and aarch64; elsewhere the test is skipped. Neither `init_module` (refused for lack of `CAP_SYS_MODULE`, filter or not: no. 1 covers it) nor `ptrace` (the refusal depends on Yama, the default profiles allow it for the same uid) are probed |
| `isolation-07-secrets.test.ts` (no. 7, extended by ORC-211 and ORC-337) | a run, launched by the real `ClaudeCodeRunner` (its `claude` replaced by `env` and a read of every `/proc/*/environ`) with a daemon environment full of secrets (`LINEAR_*`, `FACTORY_*`, `GH_TOKEN`, AWS, `ANTHROPIC_API_KEY`, another account…), receives only its run variables, the variables the repository declares and a placeholder for the Claude token, the run token being the only credential listed by name and by shape; the chosen account's token is in no process's environment; no credential file in the sandbox. The **sealed `setup`**, on the real engine: the `setup` does have its secret (fingerprint checked) and writes it everywhere it can (`/work`, `/tmp`, `$HOME`, in base64, a background process); it runs once for all these tests, and a leak that does not happen makes it fail, which brings down the whole group; its container disappears, the files are purged, writing to the git directory is refused, the secret is not on the engine's command line; an agent on the same worktree finds it neither in the files, nor in the environment or command line of a process (negative control in the same container); the engine holds it neither in the agent's container nor in an image layer. A local package with `postinstall` does not run its script under the `setup` settings, and does run it without them (control). Neither the layer history nor the image configuration contains a token (`ghp_`, `github_pat_`, `sk-ant-`, `xox?-`, `AKIA`). Run on the runner image when `FACTORY_RUNNER_IMAGE` points to it |
| `host-git.test.ts` (ORC-317) | in its real sandbox, the agent works (commit, fetch, rebase, push, branch, `gc`), then leaves hooks, config, filters and a `.git` that points to a directory of its own. The factory then runs its real git commands on the host (next launch, head, diff, another ticket, `ls-remote`, trunk, masking of `.claude/`, `verify`): no marker appears outside the sandbox, and the work is still read. The negative control redoes the same writes through a mount of the repository's git directory, where the hook does run on the host. Each path also has its test without an engine: `src/adapters/workspace/host-git.test.ts`. |
| `worktree-tree.test.ts` (ORC-136) | the runner's real reader, through the real provider, as the agent's user, on the `prepare` worktree: the commit's tree on a clean worktree, the same on two reads, a different one after a same-size modification (and same date under Podman), an untracked file, a file in `.claude/` hidden by the sparse checkout; `.git` identical after the read. Outside a repository, the warning gives the code and the first line of stderr. |
| `verify-hostile.test.ts` (ORC-151) | a `verify` command written like hostile code, launched by the real `runCleanVerify`: no engine socket (`find` finds the socket it creates itself, and only that one), nor the daemon's environment (it reads the repository's variable, not the process's canary), nor the agent's worktree (it writes into its clone), nor the network (its loopback answers, not 1.1.1.1 nor DNS). Each attack has its control, and the negative control replays the probes on the host, where they find the canary and write into the worktree. It runs on the public image `node:24.22.1-bookworm` (git and bash), or on `FACTORY_RUNNER_IMAGE`. The same file builds on this image the line of `docker/runner.Dockerfile` that installs gitleaks, and really runs it: a committed secret is found and masked, despite `gitleaks:allow`, a `.gitleaks.toml` from the branch and its removal in a later commit. |
| `isolation-09-resources.test.ts` (no. 9) | the per-container limits, read from its cgroup: 512 processes, 4 GiB without swap, 2 CPUs by default, fewer on a host that has fewer (`limits` of `ContainerSandboxOptions`, `FACTORY_SANDBOX_*` for the daemon, see [`configuration.md`](configuration.md)). Under reduced limits, a fork bomb hits `pids.max` and a memory hog is killed by the OOM killer (137), the neighbor still answering |
| `isolation-10-leaks.test.ts` (no. 10) | two runs of two tickets see nothing of each other (`/work`, `/tmp`, `$HOME`, `~/.claude`); a new run of the same ticket finds only its mounts, the ticket's worktree and session directory, by construction |
| `runner-image.test.ts` | `docker/runner.Dockerfile` (ORC-203): node, pnpm, python, uv, git and claude at pinned versions, neither `gh` nor engine CLI nor daemon code. Skipped without `FACTORY_RUNNER_IMAGE`. In CI: image built under rootless Podman, tested with no. 7 |
| `compose-stack.test.ts` | the ORC-203 acceptance run ([`acceptance.md`](acceptance.md#8-docker-criterion-8)): the 4 services on a real engine, TLS through `caddy`, a runner created from `factoryd`, pnpm and uv through the proxy. Skipped without `FACTORY_COMPOSE=1`; no CI job runs it yet |
| `isolation-08-diff.test.ts` (no. 8) | logical escape through the diff (ORC-125): a workflow, a `.gitattributes`, a `.npmrc`, a dev container, the factory's config, a binary, each in a commit, do not go out; a clean commit goes out by the same path, the control; what the agent left in its repository (hooks, `core.fsmonitor`, `core.hooksPath`) runs neither on the host nor on push. Without gitleaks: the public image does not have it |
| `isolation-07-layers.test.ts` (no. 7) | `docker save`: the files of each layer of the image, including those a later layer deletes. Five exact strings from the base image (`libunistring`, the `node` binary) have the shape of an AWS key and are allowed; any other fails the test |
| `claude-token.test.ts` (ORC-337) | the runner image's real `claude -p`, in a sandbox at `claude-api` holding a placeholder token, answers through the real egress proxy, to a stand-in for `api.anthropic.com` that sees only the factory's token, Claude Code's own tools and betas going through; with another key, a POST to `/v1/files`, a model call with an MCP server, a server tool or an image by URL are refused (403) and logged. No credential needed; Linux only (the proxy in the test process), and skipped without `claude` in the image: in CI, it runs in the runner image step |
| `claude-settings.test.ts` (no. 11) | a real `claude -p` on a booby-trapped repository loads nothing from the repository. It needs `claude` and a credential; in CI, it only runs if the `CLAUDE_CODE_OAUTH_TOKEN` secret is defined (never for a PR from a fork), and is skipped otherwise |

**Limits under rootless Podman.** They go through the user's cgroup, which only has the `pids`, `memory` and `cpu` controllers in a systemd user session (`loginctl enable-linger`, `systemd` cgroup manager). The `isolation` job opens one; a server that launches sandboxes must have one too (`sudo loginctl enable-linger <daemon user>`, then `XDG_RUNTIME_DIR=/run/user/<uid>` and `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus` in the daemon's environment; `podman info --format '{{.Host.CgroupManager}} {{.Host.CgroupControllers}}'` must print `systemd` and `cpu memory pids`), otherwise Podman refuses to create the containers. On a host without cgroup delegation (no systemd session, cgroups v1), remove the limits the engine cannot set: `FACTORY_SANDBOX_PIDS=none`, `FACTORY_SANDBOX_MEMORY=none`, `FACTORY_SANDBOX_CPUS=none` (each separately). The sandbox then loses its protection against resource exhaustion, and `isolation-09-resources.test.ts` fails on that host.

**Version upgrades.** An update of runc, crun, Podman or the kernel of the `ubuntu-latest` image is not announced. The `isolation` job therefore also runs alone every Monday (`schedule`, the other jobs are skipped), and by hand (`workflow_dispatch`, Actions tab) after any upgrade of what the sandbox relies on: runner image, engine, Claude Code.

**Follow-up (outside ORC-218).** A compatibility matrix (a `pnpm install`, a `uv sync`, Postgres, Redis, testcontainers, Playwright in the sandbox) remains to be written.

## The seven mandatory scenarios

Each scenario is delivered by the ticket that delivers the behavior it tests, with the fakes and the clock above:

| Scenario | Ticket | Fakes to drive |
|---|---|---|
| CI red 3 times | ORC-184 | `h.forge` (failing checks), `h.runner` |
| `.skip` added | ORC-158 | `h.checks`, `h.publisher` |
| Test config modified | ORC-131 (done: `test/scenarios/freeze.test.ts`) | `h.workspaces` (`heads`, `steps` by `<worktree>@<freeze commit>`), `h.runner` (`hold`), `h.publisher`; once the factory pushes |
| Human reply during a run | ORC-180 (done: `test/scenarios/human-inbox.test.ts`) | `h.runner` (`hold`), `h.advance` |
| Restart during a check | ORC-220 | `h.checks.holdNext()`, `h.restart({ mode: 'brutal' })` |
| Budget exhausted | ORC-216 | `h.runner` (`turns`, `costUsd`, `outcome: 'limit'`) |
| Delegation withdrawn | ORC-227 | `h.tracker`, `h.runner` (`hold`), `h.sandboxes` |

`h.restart()` is a clean stop: it waits for checks in progress to finish. A restart **during** a check is written with `h.restart({ mode: 'brutal' })` (ORC-228), the check held by `h.checks.holdNext()`: `test/scenarios/recovery.test.ts`, where the check is relaunched and the ticket resumes on its own (ORC-220). An `h.runner` in `hold` survives a brutal restart, like a container: `h.runner.forget(id)` makes it disappear, `h.sandboxes.destroy` makes a sandboxed attempt miss its heartbeats, `h.advance` beats them. The cut points injectable at each step of the chain and the `kill -9` chaos on 500 events (ORC-163) are described above.
