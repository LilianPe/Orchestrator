# The `factory/default` preset

The preset describes, in TypeScript, the sequence of a run's steps and the bound on each loop. It will replace the 6 states and the `on` rules of [`workflow.yml`](workflow.md) (ORC-187). The `on` rules of `workflow.yml` still drive the runs, but the engine already takes its bounds from the preset, compiled each time the workflow is loaded (see "What the engine already reads").

Code: `src/presets/preset.ts` (types and compiler), `src/presets/factory-default.ts` (the definition).

## Sequence

```
intake → clarify (if the ticket is unclear) → spec_draft → spec_check → spec_review (human gate)
  → tests → red → freeze_tests → build → verify → publish → AI review → human_review (merge gate)
  → merge (after a human moves it to Done) → after_merge
```

After publishing, a single `fix` step serves all loops: `fix → verify_fix → publish → AI review → human_review`. Its skill depends on the cause: `factory:fix-ci` for a red CI, `factory:feedback` for an AI review or human feedback.

Each step has a type: `spec_check`, `agent_step`, `verify` (modes `red`, `freeze`, `full`), `review`, `fix`, `human_gate` (gate `spec` or `merge`), `publish` (modes `push`, `merge`). A step has a follow-up on success (`next`) and, if it can fail, a step back (`onFailure`) that consumes a counter. Every `agent_step` step declares what it writes (`writes`: `nothing`, `spec`, `tests` or `code`): an omission makes compilation fail.

## Bounds

| Loop | Counter | Limit | Beyond |
| -- | -- | -- | -- |
| `spec_check` fails → `spec_draft` | `spec_check` | 1 | Blocked |
| `spec_review` « Modifier » → `spec_draft` | `spec_review` | 3 | Blocked |
| Unverified red → `tests` (blocking mode) | `red` | 2 | Blocked; the agent can also return `spec_impossible` |
| `verify` fails → `build` (or `verify_fix` → `fix`) | `verify` | 3 | Blocked |
| AI review or red CI → `fix` | `review_ci` | 2, a single counter per run | Blocked |
| Human feedback → `fix` | `human_review` | 3, separate from AI rounds | Blocked |
| Same command, same failure, diff unchanged | `sameFailure` | 3 | Blocked, cause « boucle » (loop): between two `verify` runs and during the attempt ([stagnation](#attempt-stagnation-orc-136)) |
| Nothing written to the attempt's stream | `silentRun` | 30 min | Blocked ([stagnation](#attempt-stagnation-orc-136)) |

A red CI is the failure of a push: as long as the PR is open, including during the merge gate, it goes to `fix` on the `review_ci` counter (`redCi`, the sole source of this rule). No reaction relaunches `fix` outside this counter. A merged PR no longer has a step back.

`verify` and `verify_fix` share the `verify` counter, reset when a verification passes: the 3 returns count consecutive failures. The total stays bounded, because the number of passes through `verify` is bounded by the other counters.

## Models, effort, turns, network

| Step | Model | Effort | Max turns | Network |
| -- | -- | -- | -- | -- |
| `intake`, `clarify` | Sonnet | low | 150 | Limited |
| `spec_draft` | Sonnet | high | 150 | Limited |
| `tests`, `after_merge` | Sonnet | medium | 150 | Limited |
| `build` | Sonnet | medium | 150 | Limited |
| `fix` | Sonnet | medium | 60 | Limited |
| `review` | Opus | high | 25 | Claude API |
| `spec_check`, `verify*`, `red`, `freeze_tests` | (factory check) | | | None |

The turns of steps the MVP doc does not quantify reuse the old `per_run.turns: 150`. Token caps remain to be set (ORC-216): none by default.

A workflow job names its step (`step`, ORC-136): `dev` is `build`, `tests` is `tests`, `dev-feedback` and `fix-ci` are `fix`, `review` is `review`. Loading derives from it the effort, passed to `claude --effort` and recorded in the attempt's labels, and the turns. `factory.yml` can change a step's effort (`claude.effort.per_step`), lower its turns (`budgets.max_turns`) and give it a token cap (`budgets.per_step_tokens`). Like the whole workflow, these values are frozen with the ticket's version: a ticket already started keeps its own, and a version frozen before ORC-136 has neither effort nor tokens.

A token cap counts `input + output + cache_creation` of the attempt's messages, not cache reads. When exceeded, the run stops as on a turn cap: `limit`, ticket Blocked.

The network level is chosen per repository (Limited by default); a step can only tighten it. A step declared above the repository's level makes compilation fail.

## What the engine already reads

`loadWorkflow` compiles the preset then carries its bounds over into `limits`, which is frozen with each ticket's workflow version (ORC-149). A ticket therefore keeps the bounds it started with.

| Preset bound | In the loaded workflow | Effect |
| -- | -- | -- |
| `counters.verify` (3) | `limits.verifyAttempts` = 4 | 3 returns to the run after a failed check; the 4th failure blocks |
| `counters.review_ci` (2) | `limits.ciFixAttempts` = 2 | 2 `fix-ci` retries on red CI; the next one blocks. AI review rounds will join this counter with ORC-184 |
| `sameFailure` (3) | `limits.repeatedFailures` = 3 | same failure on an unchanged worktree, 3 times in a row: Blocked, cause « Loop » |
| `counters.red` (2) | `jobs.<job>.red.attempts` = 3 | in blocking mode, 2 returns to `tests` after an unverified red; the 3rd blocks. A human retry resets the count to zero |

`verify_attempts` and `ci_fix_attempts` in `workflow.yml` still override the first two, until the YAML is removed (ORC-177).

## Resuming the blocked step (ORC-196)

A human reply on a Blocked ticket relaunches the step where it got blocked, not `dev-feedback`. The block remembers its job (`blockedJob`, from `ticket.blocked`), which the engine launches instead of the rule's job, with the reply as input. The rule (`session.prompted` and `ticket.commented`, `when: blocked`) is still what lets the reply through. ORC-180's classification comes first: an instruction or a question from the ticket's session relaunches, a command (`/status`, `/stop`) relaunches nothing, a question from another thread gets its answer there and does not lift the block.

The YAML's `on` rules still drive the sequence (ORC-177): the engine does not execute the preset's steps, it launches jobs. Hence what resuming can do today:

| Blocked at | A reply relaunches |
| -- | -- |
| `build`, `tests`, `fix`, `review` (end of run, cap, loop, lease, interruption, question, including via `relais-agent ask`) | that step's job: `dev`, `tests`, `dev-feedback`, `review`. `fix-ci` goes through `dev-feedback`, same step: it reads its red checks, not a reply |
| pickup, launch | the job being launched, its checks included |
| `verify`, `verify_fix`, `red` (failure at the cap, loop, failure) | the job the check judges: that is the preset's step back. Not the check alone: `run_verify` needs the agent's output, which `verify.errored` does not carry |
| `verify` of a job that does not fix (`verify_failure: block`, the review) | `dev-feedback`, which writes |
| `publish` refused | `dev-feedback`: it writes, goes through `verify` then `publish` again, and the owed move follows (`owedMove`) |
| dead-letter, dead effect, `stop` | `dev-feedback`, these blocks have no step of their own |

**Not yet**: relaunching a step without an agent (`verify`, `red`, `freeze_tests`, `spec_check`, `publish`, `merge`) on its own, and resuming at the human gates (`spec_review`, `human_review`): this needs an engine that executes the steps (ORC-177). `intake`, `clarify`, `spec_draft`, `spec_check`, `spec_review` and `after_merge` do not have a job yet. The attempt number follows the counter that led to the block; a step without a counter shows 1/1. A project rule with a `debounce` on a blocked ticket keeps its job: its timer starts once the block is lifted.

## Attempt stagnation (ORC-136)

The runner watches the attempt's stream. It observes, stops it, and logs what it saw in `run.finished` (`stagnation` field). It is `decide` that blocks, based on this fact and on the frozen version's bound: replay decides the same way, and a journal from before ORC-136, without this field, decides as before. A frozen version without a bound watches nothing.

**Loop.** For each `Bash` call the stream reports as failed (`is_error`), the runner computes a fingerprint: the command, the normalized output (colors, dates, durations, addresses, hashes, pids and temporary paths removed), and the worktree's content. This content is the git tree of the whole worktree, modified and untracked files included, read with a copy of the index: the agent's index does not move. It is read where the agent runs, in its sandbox if it has one. The same command on the same failure `sameFailure.limit` times (3), with no change of content between them: stop, then Blocked, reason « Loop: … », and the command in the block comment. Other commands between two failures do not reset the count. Any content change resets them all, even a return to content already seen. Committing without changing anything does not. A command that waits for an external state (`curl` on a server that is starting up) and fails 3 times the same way counts too. If the content could not be read (no git, more than 30 s), that failure does not count, and the daemon's log says so once per run, with the exit code and the first line of stderr: a disabled detector is visible. Only jobs of the `dev` queue are watched for loops.

**Silence.** Nothing written to the stream for `silentRun.minutes` (30): stop, then Blocked, « The run … has written nothing for 30 min ». The lease does not see it: it only says the container is alive. 30 min exceeds Claude Code's longest `Bash` call (10 min).

A human relaunches as usual, with a reply in the ticket, and the count starts over at zero. An attempt resumed after a restart (`attach`) is only watched for silence, whose delay restarts from the resumption; its loops remain bounded by its turns and its duration.

The guard between two `verify` runs (`repeatedFailure`, ORC-187) stays separate: same job, same commands and exit codes, same tree, without the output.

An attempt whose process stops without a `result` line, without having been stopped or having reached a cap (container killed, memory, process killed), is a failure: `errored`, ticket Blocked, nothing is sent back to the agent.

## `tests` step and `red` check (ORC-123)

The `tests` step (agent, skill `factory:tests`, Sonnet, effort medium, repository network) writes **only** the tests that translate the acceptance criteria, and commits them. The factory does not take its word for it: the `red` check (`src/checks/red.ts`) observes for itself.

1. When the step launches, the factory records the worktree's head (`baseSha`); a return to the step keeps the first one. The check reads the files changed by the step's commits only (`baseSha..HEAD`, on the factory's repository), plus the worktree's uncommitted or untracked files. A file that is not a test (single rule in `src/checks/test-files.ts`, helpers and data under a test folder included) is a scope violation (`scope`), observed without running anything.
2. It runs only the added or modified test files (`*.test.ts`, `test_*.py`…, not helpers or data) with the job's command (`red.command`, `npm test --` in the pack). With sandboxes, `git status` and the tests run in a separate sandbox, without network; without them, on the host like `verify`.
3. It classifies the output (vitest, jest, pytest), errors before "no tests" (pytest writes `collected 0 items / 1 error` before an import error):

| Output | Cause | Red |
| -- | -- | -- |
| failure on an assertion (`AssertionError`, `expect(received)`, `E assert`) | `assertion` | verified |
| module not found ("Cannot find module", TS2307, `ModuleNotFoundError`) none of whose paths exist at `baseSha`: relative to the test file in TypeScript, in a package of the repository in Python | `missing_module` | verified |
| symbol an existing module does not export (TS2305, "does not provide an export named", `is not a function` for a function imported by the test, `cannot import name`), absent from the module at `baseSha` | `missing_export` | verified |
| module not found that exists at `baseSha` | `module_at_base` | refused |
| package not found (bare name in TypeScript, Python package outside the repository): the build does not install any | `missing_package` | refused |
| syntax, type, loading or collection error; missing symbol that already exists at `baseSha` | `compile` | refused |
| failure without an assertion (runtime error), timeout | `error` | refused |
| no test run, or no test committed | `no_tests` | refused |
| tests already green | `passing` | refused |
| non-test file, committed or not | `scope` | refused |
| the check could not run (git, worktree, sandbox) | `infra` | no verdict |

The verdict comes back like the result of `verify`: `verify.passed` or `verify.failed`, with the `red` field carrying the cause. A verified red starts the next job (`on_success.run`, `dev` in the pack).

**Measurement mode.** For the first 20 tickets, the check is in measurement mode: it never blocks. An unverified red, a scope violation included, leaves in the decision the trace "red: would have blocked (<cause>), measure mode: the run goes on", and the build starts. The verdicts are in the ticket's measurements (`red` of `TicketMeasures`, ORC-235): a red that is not `verified` is what the check would have blocked.

**Blocking mode.** An unverified red, or a scope violation, makes the step fail: back to `tests` (resumed session, verdict as input), bounded by the `red` counter, then Blocked.

**Failure.** A check that could not run (`infra`) blocks the ticket in both modes, without relaunching the agent: it is not a verdict on its tests. It does not enter the measurements.

The flag lives in the job, frozen with each ticket's workflow version: `jobs.tests.red.mode: measure | blocking` (`measure` by default). Switch it to `blocking` in `.factory/workflow.yml`, after validation on the golden tickets (ORC-236).

The pack's `tests` job is inactive as long as no rule launches it: a repository enables it by making delegation start with it (`ticket.delegated: - { when: "state in [todo, dev] && !blocked", run: tests }`). Jobs without `red` keep the former `dev` flow.

## Freezing the tests and the harness (ORC-131)

After `red`, the factory freezes what judges the agent: the tests the `tests` step committed and the harness that runs them (`src/checks/freeze.ts`). The freeze **blocks from the first ticket**, red measurement mode included: only a return to `tests` in blocking mode postpones it to the next red.

**What is frozen**, read from the factory's repository at the step's final commit, never in the agent's worktree: the step's tests, and anywhere in the repository the harness files: `vitest.config.*`, `jest.config.*` (JSON included), their `setup` and `workspace`, `setupTests.*`, `tsconfig*.json`, the `test` script of each `package.json`, `conftest.py`, `pytest.ini`, `.pytest.ini`, `pytest.toml`, `.pytest.toml`, and the section pytest reads in `pyproject.toml` (`[tool.pytest…]`), `tox.ini` (`[pytest]`) and `setup.cfg` (`[tool:pytest]`). Each file has its sha256 fingerprint (of its content, or of only the part read by the tests for `package.json` and the three shared files; a `tox.ini` or `setup.cfg` without a pytest section is not frozen). The freeze (commit and fingerprints) is in the ticket's state (`frozenTests`), set by the journaled event that read it: who and when are in the journal.

**The check.** Once the freeze is set, every run of the ticket in its worktree (`dev`, `dev-feedback`, `fix-ci`, `review`) goes through verification, even without a `verify` command: the factory reads the files changed from the freeze commit up to the branch's head. A frozen file modified or deleted (an added `skip` or `only` is a modification), or an added harness file, makes `factory/tests-gelés` fail: the verification fails, the run starts again with the summary, then the ticket is Blocked at the end of `verify`, without moving to Human Review. The check does not look at the author: a human commit on a frozen test fails the same way. A check that cannot read the branch fails too, and a file of the commit that is unreadable at freeze time makes its reading fail: the freeze never opens on a failure. A second pass through `tests` adds its new tests to the freeze, without touching those already frozen; a harness file added since the first freeze does not enter it and keeps failing.

**`/refreeze`.** The only way out of the freeze: a designated maintainer (ORC-186's matrix) mentions the agent in the ticket with `/refreeze`, or replies `/refreeze` in its session. Before the decision, the factory reads the freeze at the branch's local head, without `fetch` (the already-frozen files and the harness), and journals it with the command; if accepted, it replaces the old one and the reply in the ticket gives the commit; the next verification starts from it. If refused (another role, unsigned actor, or no role resolved), the command is journaled (`authz: refused refreeze …`) and answered in the ticket, and the freeze does not move. Refreezing relaunches nothing: a Blocked ticket is relaunched as usual. On a ticket without a freeze, `/refreeze` does not create one: the reply says there is nothing to refreeze.

**Not yet**: the check published on the PR (ORC-273); the worktree's uncommitted files are not read: a test left uncommitted is not frozen, but since ORC-151, with sandboxes, the `verify` commands do not see them either: they and the freeze read the same commit, in a fresh clone; a commit pushed outside the factory's worktree is only seen once pulled (ORC-159); a trunk change brought in by a `merge` or a `rebase` counts as a change since the freeze, and requires a `/refreeze`; only setups and fixtures named like the harness are frozen, an existing `test/setup.ts` is frozen only if the step changed it; `/refreeze` from a PR comment; the `freezes` table separate from the journal; the scan for disabled tests outside frozen files remains that of `anti-triche` (ORC-158).

## Compilation and version

`compilePreset(preset, { repoNetwork })` checks the core invariants and returns the preset's hash, or throws a `PresetError` listing all violations:

- **bounded cycles**: `next` links alone form no cycle, and every step back names a declared counter, with a positive integer limit;
- **tests frozen before the build**: no step that writes code (`fix`, or `agent_step` with `writes: code`) is reachable without going through a `verify` in `freeze` mode;
- **merge gate**: from written code, a `publish` in `merge` mode is only reachable through a `merge` human gate;
- **read-only reviewer**: every `review` step is read-only, Claude API network at most;
- **offline checks**: every `verify` step runs without network;
- **network**: no step at Full (reserved for `setup`), none above the repository's level;
- **budget cap**: every agent step has a maximum number of turns.

The hash is the sha256 of the preset's canonical JSON (sorted keys): it does not depend on key order and changes as soon as a bound, a model or a step changes. Each run will be frozen on the hash it started with (`workflow_versions` table, ORC-149).
