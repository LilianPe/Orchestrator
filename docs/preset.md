# The `factory/default` preset

The preset describes, in TypeScript, the sequence of a run's steps and the bound on each loop. It will replace the 6 states and the `on` rules of [`workflow.yml`](workflow.md) (ORC-187). The `on` rules of `workflow.yml` still drive the runs, but the engine already takes its bounds from the preset, compiled each time the workflow is loaded (see "What the engine already reads").

Code: `src/presets/preset.ts` (types and compiler), `src/presets/factory-default.ts` (the definition).

## Sequence

```
intake → clarify (if the ticket is unclear) → spec_draft → spec_check → spec_review (human gate)
  → tests → red → freeze_tests → build → verify → publish → AI review → human_review (merge gate)
  → merge (after a human moves it to Done) → after_merge
```

After publishing, a single `fix` step serves all loops: `fix → verify_fix → publish → AI review → human_review`. Its skill depends on the cause: `factory:fix-ci` for a red CI, `factory:feedback` for an AI review or human feedback. A conflict with the default branch takes its own way back: `rebase → verify_rebase → publish → AI review → human_review` ([below](#rebase-step-orc-146)).

Each step has a type: `spec_check`, `agent_step`, `verify` (modes `red`, `freeze`, `full`), `review`, `fix`, `human_gate` (gate `spec` or `merge`), `publish` (modes `push`, `merge`). A step has a follow-up on success (`next`) and, if it can fail, a step back (`onFailure`) that consumes a counter. Every `agent_step` step declares what it writes (`writes`: `nothing`, `spec`, `tests` or `code`): an omission makes compilation fail.

## Bounds

| Loop | Counter | Limit | Beyond |
| -- | -- | -- | -- |
| `spec_check` fails → `spec_draft` | `spec_check` | 1 | Blocked |
| `spec_review` « Modifier » → `spec_draft` | `spec_review` | 3 | Blocked |
| Unverified red → `tests` (blocking mode) | `red` | 2 | Blocked; the agent can also return `spec_impossible` |
| `verify` fails → `build` (or `verify_fix` → `fix`) | `verify` | 3 | Blocked |
| AI review or red CI → `fix` | `review_ci` | 2, a single counter per run | Blocked |
| Conflict with the default branch → `rebase` (ORC-146) | `review_ci`, the same | 2, shared with red CI | Blocked, cause « conflict » |
| Human feedback → `fix` | `human_review` | 3, separate from AI rounds | Blocked ([below](#human-review-feedback-orc-190)) |
| Same command, same failure, diff unchanged | `sameFailure` | 3 | Blocked, cause « boucle » (loop): between two `verify` runs and during the attempt ([stagnation](#attempt-stagnation-orc-136)) |
| Nothing written to the attempt's stream | `silentRun` | 30 min | Blocked ([stagnation](#attempt-stagnation-orc-136)) |

A red CI is the failure of a push: as long as the PR is open, including during the merge gate, it goes to `fix` on the `review_ci` counter (`redCi`, the sole source of this rule). No reaction relaunches `fix` outside this counter. A merged PR no longer has a step back. The count is the run's: another PR or a human who starts work (a reply, a label, a status change or a delegation that launches a run, blocked or not) starts it over, a green CI does not (ORC-184), or a review that keeps finding would loop between its fix and green CI.

`verify` and `verify_fix` share the `verify` counter, reset when a verification passes: the 3 returns count consecutive failures. The total stays bounded, because the number of passes through `verify` is bounded by the other counters.

## Models, effort, turns, network

| Step | Model | Effort | Max turns | Network |
| -- | -- | -- | -- | -- |
| `intake`, `clarify` | Sonnet | low | 150 | Limited |
| `spec_draft` | Sonnet | high | 150 | Limited |
| `tests`, `after_merge` | Sonnet | medium | 150 | Limited |
| `build` | Sonnet | medium | 150 | Limited |
| `fix` | Sonnet | medium | 60 | Limited |
| `rebase` | Sonnet | medium | 60 | Limited |
| `review` | Opus | high | 25 | Claude API |
| `spec_check`, `verify*`, `red`, `freeze_tests` | (factory check) | | | None |

The turns of steps the MVP doc does not quantify reuse the old `per_run.turns: 150`. Token caps remain to be calibrated: none by default, and `factory validate` refuses until each agent step has its `per_step_tokens` and the ticket its `per_ticket_tokens` (ORC-216).

A workflow job names its step (`step`, ORC-136): `dev` is `build`, `tests` is `tests`, `dev-feedback` and `fix-ci` are `fix`, `review` and `review-security` are `review`, `rebase` is `rebase` (ORC-146). Loading derives from it the effort, passed to `claude --effort` and recorded in the attempt's labels, and the turns. `factory.yml` can change a step's effort (`claude.effort.per_step`), lower its turns (`budgets.max_turns`) and give it a token cap (`budgets.per_step_tokens`). Like the whole workflow, these values are frozen with the ticket's version: a ticket already started keeps its own, and a version frozen before ORC-136 has neither effort nor tokens.

A token cap counts `input + output + cache_creation` of the attempt's messages, not cache reads. When exceeded, the run stops as on a turn cap: `limit`, and the runner says which cap (`overBudget: tokens | turns`, journaled on `run.finished`): the ticket is Blocked with the kind `budget` and the standard comment (ORC-216). A run stopped at its duration, or one journaled before ORC-216, blocks with the kind `limit` as before. The subscription's usage limit is no overrun: the run waits for the reset (`on_usage_limit: wait`, ORC-340).

The network level is chosen per repository (Limited by default); a step can only tighten it. A step declared above the repository's level makes compilation fail.

### The agent's tools per step (ORC-383)

Each agent step has a list of built-in tools, passed to `claude --tools` and enforced a second time by the pack's `PreToolUse` hook, which refuses any other tool and journals it (rule `tool-not-allowed`, [pack](pack-and-skills.md#pretooluse-hook-and-refusal-log)). The factory's MCP tools (`submit_result`, `ask`, `kb_search`) are always beside them.

| Steps | Default tools |
| -- | -- |
| `intake`, `clarify`, `spec_draft`, `review`, and the answer agent (`ask`, a job out of the preset) | `Read`, `Grep`, `Glob`: read-only, no write tool and no shell |
| `tests`, `build`, `fix`, `rebase`, `after_merge` | `Read`, `Grep`, `Glob`, `Edit`, `Write`, `NotebookEdit`, `Bash`, `TodoWrite`, `Skill`: no subagent, no web tool |
| `spec_check`, `verify*`, `red`, `freeze_tests` | none: the factory's own checks, no agent |

`factory.yml` sets a step's list (`tools.per_step`, [configuration](configuration.md#factoryyml-orc-209)), and the repository's `.factory/config.yml` can only restrict it (`tools.per_step`, [repository configuration](repository-configuration.md#keys)): the run gets the tools of both lists. A list never gives a step more than its preset step and its network allow, and a value that would is refused when it is read: no write tool or shell for a read-only step, no `WebFetch` below network `limited` (a repository at `none` included), never `WebSearch`, and no tool the factory does not know (`Task` among them). At the launch, `WebFetch` is also dropped from a run whose network does not reach past the Claude API. Like the rest of the workflow, a step's tools are frozen with the ticket's version; a version frozen before ORC-383 keeps every tool for the steps that write, narrowed to the repository's list when it has one. `factory validate` shows each step's tools.

## What the engine already reads

`loadWorkflow` compiles the preset then carries its bounds over into `limits`, which is frozen with each ticket's workflow version (ORC-149). A ticket therefore keeps the bounds it started with.

| Preset bound | In the loaded workflow | Effect |
| -- | -- | -- |
| `counters.verify` (3) | `limits.verifyAttempts` = 4 | 3 returns to the run after a failed check; the 4th failure blocks |
| `counters.review_ci` (2) | `limits.ciFixAttempts` = 2 | 2 runs per run of the ticket between `fix-ci` on red CI, `rebase` on a conflict (ORC-146) and `fix-review` on a blocking finding of the AI review (ORC-184); the next red CI, conflict or review that still finds blocks |
| `sameFailure` (3) | `limits.repeatedFailures` = 3 | same failure on an unchanged worktree, 3 times in a row: Blocked, cause « Loop » |
| `counters.red` (2) | `jobs.<job>.red.attempts` = 3 | in blocking mode, 2 returns to `tests` after an unverified red; the 3rd blocks. A human retry resets the count to zero |
| `counters.human_review` (3) | `limits.humanReviewRounds` = 3 | 3 rounds of human review feedback (`fix-human`, the job with `counter: human_review`, ORC-190), apart from `ciFixAttempts`; the 4th feedback blocks |

`verify_attempts`, `ci_fix_attempts` and `human_review_rounds` in `workflow.yml` still override them, until the YAML is removed (ORC-177).

## Resuming the blocked step (ORC-196)

A human reply on a Blocked ticket relaunches the step where it got blocked, not `dev-feedback`. The block remembers its job (`blockedJob`, from `ticket.blocked`), which the engine launches instead of the rule's job, with the reply as input. The rule (`session.prompted` and `ticket.commented`, `when: blocked`) is still what lets the reply through. ORC-180's classification comes first: an instruction or a question from the ticket's session relaunches, a command (`/status`, `/stop`) relaunches nothing, a question from another thread gets its answer there and does not lift the block.

The YAML's `on` rules still drive the sequence (ORC-177): the engine does not execute the preset's steps, it launches jobs. Hence what resuming can do today:

| Blocked at | A reply relaunches |
| -- | -- |
| `build`, `tests`, `fix`, `review`, `rebase` (end of run, cap, loop, lease, interruption, question, a conflict the rebase stops on, including via `relais-agent ask`) | that step's job: `dev`, `tests`, `dev-feedback`, `review` (its first lens: the review starts over, ORC-183), `rebase`. `fix-ci` goes through `dev-feedback`, same step: it reads its red checks, not a reply. `fix-review` resumes itself on the reply, then goes back through the review (ORC-184) |
| pickup, launch | the job being launched, its checks included |
| `verify`, `verify_fix`, `verify_rebase`, `red` (failure at the cap, loop, failure) | the job the check judges: that is the preset's step back. Not the check alone: `run_verify` needs the agent's output, which `verify.errored` does not carry |
| `verify` of a job that does not fix (`verify_failure: block`, the review of a version frozen before ORC-183) | `dev-feedback`, which writes |
| `publish` refused | `dev-feedback`: it writes, goes through `verify` then `publish` again, and the owed move follows (`owedMove`) |
| dead-letter, dead effect, `stop` | `dev-feedback`, these blocks have no step of their own |

**Not yet**: relaunching a step without an agent (`verify`, `red`, `freeze_tests`, `spec_check`, `publish`, `merge`) on its own, and resuming at the `human_review` gate: this needs an engine that executes the steps (ORC-177). `clarify` does not have a job yet; `after_merge` has none either, the factory carries it out itself without an agent (`do: after_merge` on `pr.merged`, ORC-197, [workflow.md](workflow.md#after-the-merge-orc-197)); `intake` and `spec_draft` have one, which a repository turns on ([intake](#intake-step-and-the-guard-before-in-progress-orc-206), [spec](#spec_draft-spec_check-and-the-spec_review-gate-orc-212)); `spec_check` and `spec_review` are decided at its end and on the gate's commands. A reply to the guard relaunches `intake`. The attempt number follows the counter that led to the block; a step without a counter shows 1/1. A project rule with a `debounce` on a blocked ticket keeps its job: its timer starts once the block is lifted.

## `factory/fantome` (ORC-231)

The preset of the replay of closed tickets, at the Rapide level (`level: rapide`): `factory/default` without `clarify`, without
the spec gate and without anything after the publication. What `clarify` would ask is assumed, written in the spec and counted; the
spec that passes `spec_check` is approved by the preset; a human gate at that level is refused by the compiler. Code:
`src/presets/fantome.ts`; see [the replay of closed tickets](ghost-replay.md).

## `rebase` step (ORC-146)

A conflict of the ticket's PR with its base branch arrives in the inbox as `pr.conflicted` (GitHub webhook, ORC-134). It is the engine that starts the step that handles it; an agent at work on another step never resolves it: the `dev`, `feedback`, `fix-ci` and `review` skills leave the base alone and hand back.

**Start.** The pack's rule `pr.conflicted: { when: "state in [dev, human_review, ai_review] && !blocked", run: rebase }`, for the ticket's open PR only (another PR's conflict, a merged or closed one's, is only journaled). Each start counts on `review_ci` (`ciFixAttempts`), the counter of red CI (I5): the conflict's id carries the head and the base, so GitHub repeating it on the same pair starts nothing more. A rebase already running or waiting starts no second one either, whatever the head: it takes the branch onto the base as it is then. Past the bound, the conflict starts nothing and blocks the ticket, kind `conflict` (a green CI does not lift it, unlike the red-CI bound). A conflict during another step leaves that run alone: the start waits behind it, pending, and runs once that work is out (verified and published).

**The step.** The `rebase` job (agent, skill `factory:rebase`, Sonnet, effort medium, 60 turns, the repository's network) resumes the ticket's session in its worktree, in its sandbox like any dev job. It runs `git rebase origin/<base>` and resolves the ordinary conflicts, then the touched tests, types and lint. It moves nothing and posts nothing. Three cases stop it: `git rebase --abort`, then `submit_result` with `status: blocked`, `reason: conflict` and `conflict`:

| `conflict` | When |
| -- | -- |
| `logic` | the two sides contradict each other |
| `migrations` | two migrations change the same schema |
| `scope` | the resolution goes beyond the ticket's scope |

The ticket is then Blocked, kind `conflict`, with the standard comment (step `rebase`, the case in the reason, the agent's question). A reply relaunches `rebase` with the answer.

**Verify, then publish.** A rebase that ends well goes through `verify_rebase` (the repository's commands and the diff checks, in a fresh clone, like any job that writes code); failed checks send it back with them, bounded by `verify`. Only a green commit goes out (I1). The factory publishes it with `--force-with-lease` (ORC-125): the rebased branch no longer holds what was pushed, so its `publish` effect carries `rewrite`, and the push may replace the head the factory published last (the sha of the ticket's last `publish.done`, read from its journal), and only that head. A human's commit on the branch since is refused (`moved`), as for any publication. The ticket stays where it was (Human Review, AI Review or In Progress). In Human Review, the reviewed commit is no longer the head: a Done then goes back through the AI review, which shows the rebased head, as after any push since the review. Only the rebase step stops on a `conflict`: another step that reports one asks a plain question.

**Not yet**: a conflict created by a push to the default branch, with no event on the PR, waits for the reconciliation (ORC-185); the freeze reads a rebase as a change since the freeze, which needs a `/refreeze` (see the freeze's « not yet »); the rebase's summary is not posted (ORC-214's `OutputPolicy` will compose what a step posts).

## `intake` step and the guard before In Progress (ORC-206)

The `intake` job (agent, skill `factory:intake`, Sonnet, effort low, the repository's network, in the runner like any dev job) reads the ticket, the repository's architecture docs and decisions and the code it touches. It writes nothing and does not move the ticket: since ORC-367 the run itself holds it to that. It runs on a fresh clone of the default branch (workspace `trunk-readonly`, `_trunk/<runId>/`, gone with the run), never in the ticket's worktree, so a ticket found incomplete keeps no worktree made for nothing; and like the AI review's lenses it has the `Read`, `Grep` and `Glob` tools only (`claude --tools`), no write tool and no shell, whatever its skill says. A read-only step of the preset (`readOnly`: `intake`, `clarify`, `spec_draft`; not `after_merge`, which writes no code but keeps its shell) gives its job these tools ([tools per step](#the-agents-tools-per-step-orc-383)), and a job of a read-only step that writes nothing (`intake`, `clarify`) anywhere but a clone of its own (`trunk-readonly`) is refused when the workflow loads. With no shell, it no longer reads the linked tickets (`factory-agent issue`): it judges from what the ticket says of them. It hands back, in the `intake` field of `submit_result`:

| Field | Values |
| -- | -- |
| `size` | `xs`, `s`, `m`, `l`, `xl` |
| `risk` | `low`, `medium`, `high` |
| `complete` | whether a developer can build it without asking anything |
| `missing` | the questions to answer: at least one when not complete, at most 3; each `{ question, options }` (2 to 5 hypotheses), or a bare question when the agent sees none (ORC-210) |
| `screen` | whether the ticket changes something a user sees |
| `duplicates` | optional, at most 3: the work in progress elsewhere that does the same, each its link and why ([below](#duplicates-existing-code-and-scope-orc-207)) |
| `reuse` | optional, at most 10: existing code close to the request (`path`, `symbol`, why), given to `build` |
| `scope` | optional: `refuse`, why the ticket is out of scope, and `split`, the sub-tickets proposed (a title and a summary each, at most 5) |

Before the ticket's first run (no Claude session yet), the factory runs the deterministic checks of `tracker.pickup.checks` (`src/core/pickup.ts`) and journals the failed ones with the attempt's end (`pickup` of `run.finished`): they no longer block on their own, they are inputs of the guard.

At its end, `decide` records the assessment in the ticket's state:

- `size`, the last assessment's;
- `risk`, the higher of the ticket's and the proposed one: within a run, the risk never goes down (I4, property in `test/properties/decide.prop.test.ts`);
- `visualProof: required` when the ticket speaks of a screen; never lifted within a run: the model cannot make visual proof `not_applicable`. Deciding it from the real diff is `verify`'s (ORC-176): required too when the diff touches `visual_paths`.

A new run starts again from its own level (ORC-365). A delegation whose decision starts a run, on a ticket already assessed, marks the run's boundary: `risk` and `visualProof` go to `null`, a run not yet assessed, so the new run's intake sets them from what it proposes. A delegation that starts nothing (refused by the matrix, made while a run is active, on a blocked ticket, or one waiting on its blockers) leaves the run as it is. A ticket from before ORC-365 has no boundary marked: it stays in its run and decides as before.

Each later attempt of the ticket carries its risk in its labels (`risk`, ORC-226).

Then the guard before In Progress: a failed deterministic check, a probable duplicate, a ticket out of scope or an incomplete ticket does not start, it goes to `clarify` ([below](#clarify-questions-reminder-and-expiry-orc-210)); nothing moves to In Progress. A complete ticket starts `dev` (`on_success.run`), which moves it to In Progress. `dev` runs its own pickup checks again before its first run: they pass when the guard did, unless the ticket changed in between.

`intake` is off in the pack: a repository turns it on by making delegation start with it (`ticket.delegated: - { when: "state in [todo, dev] && !blocked", run: intake }`). Without it, `dev`'s pickup checks block directly, as before.

### Waiting on a blocked-by ticket (ORC-363)

A ticket « blocked by » a Linear ticket that is not done waits instead of starting. Done is a status of Linear's `completed` type; a cancelled blocker delivered nothing and still holds; a deleted one (in Linear's trash), or one the factory's token cannot read, holds nothing. The blockers are read with the ticket (`blockedBy` of the [tracker port](ports/tracker.md)), before its first run, where the pickup checks run:

- **`intake` on**: they are an input of its guard, journaled with its end (`blockedBy` of `run.finished`). A ticket incomplete or failing a check is asked its questions first (`clarify`, below): the human has something to answer; `intake` runs again after the last answer, and the wait comes then. A complete one waits, and what `intake` would start (`on_success.run`, `dev`) is the start it waits for; an `on_success.post` is posted at once, an `on_success.move` is not made (the start moves the ticket itself).
- **`intake` off** (the pack): the guard lives at the launch of the job with `pickup: true` (`dev`), in the orchestrator, after the pickup checks: a failed check still blocks; else, an open blocker makes that very start wait, as it was decided (its input, its restrictions).

The wait is no block: no `Bloqué` label, no blocking comment, nothing to answer. The session gets a thought naming the blockers and their status. `/status` says it. The ticket stays where it is (Todo): nothing moves to In Progress. While it waits, a reply, a move or a debounced reply starts no dev work; a message stays in `humanInbox` for the run that starts later. A delegation again keeps the wait. A stop (a block), an undelegation or a dev run started all the same end it.

**The resume comes from the reconciliation**, every 5 minutes ([Linear](linear.md)): it reads each waiting ticket's relations again and, when none is open (blockers done, or a relation taken off), sends `blockers.done`; `decide` makes the start it waited for, and the session hears it, unless a human moved the ticket meanwhile out of Todo and In Progress: then the wait only ends. Not a webhook: the blocker's move to Done comes on another issue, maybe of a team the factory does not follow, and a relation taken off sends no webhook the factory reads; the reconciliation already reads these tickets each pass, so the wait costs no extra call. The price is up to 5 minutes before the resume. `dev` reads the blockers again at its launch: one reopened meanwhile makes it wait again.

### Duplicates, existing code and scope (ORC-207)

At the launch of `intake`, before its first run, the factory searches for duplicates through the adapters: every open PR of the repository, the most recently updated first, with its first 30 files and their count (the [forge port](ports/forge.md), GraphQL, every page: a list of PRs it cannot read to its end fails the launch, never reads as « no duplicate »), the 100 most recently committed branches but the default one, and the tickets of the team the tracker finds close to the title (`Tracker.search`, its 10 best matches: a ranking, not a list). Then:

- **The ticket's own work** (a `factory/<id>-…` branch, every page of them, named by its open PR when it has one) is a certain duplicate, found without judgement: a failed check, with its link, journaled in `pickup` of `run.finished`. It is the `not_started` check, absorbed into the search: it runs when `pickup.checks` lists it (the pack does), at intake's launch or at a `pickup: true` job's without intake. A PR from a fork names a branch of another repository: it is never the ticket's own, and hides no branch.
- **The rest** goes to intake as data, in a « Work in progress elsewhere » section of its prompt: the open PRs with their files (30 per PR), the close tickets, then the recent branches without an open PR, capped at 12,000 characters in that order, what is cut counted. Intake judges which is a probable duplicate (same files or same subject, for the same purpose) and names it in `duplicates`.
- **Existing code**: intake names the functions and modules close to the request in `reuse`. The ticket keeps the last assessment's (`reuse` of its state); `build` gets them in an « Existing code to reuse » section of its prompt.
- **Scope**: a ticket of performance, of architecture or a large refactor is refused in `scope.refuse`, with the sub-tickets intake proposes in `scope.split`. The factory creates none in Linear and starts none.

A probable duplicate and a refusal of scope are inputs of the guard, as a failed check: they go to `clarify` ([below](#clarify-questions-reminder-and-expiry-orc-210)) as one question that names each with its link, or the explanation and the split, and asks the human to confirm or lift them. Never a silent drop: once answered, intake reads the ticket again with the answer.

**Not yet**: creating the proposed sub-tickets in Linear, not delegated (the ticket leaves it open: refusing with the split in a question is its other branch); handing intake's understanding to `build`, after which `factory:dev`'s « Understand » section can shrink (ORC-254). Each job runs at its step's network level narrowed by the repository's (ORC-183): `limited` for intake as for the build, `claude-api` for the review.

## `clarify`: questions, reminder and expiry (ORC-210)

`clarify` runs no agent of its own: the questions are `intake`'s (`missing`), the separate intent agent being EVP 1's ([decision](decisions/ORC-210.md)). At the guard, the factory asks at most 3 of them in the ticket's Linear session, one `elicitation` activity each, one at a time (the next once one is answered: Linear sends a picked option back as a plain reply, so the list on screen is the question it answers): with Linear's `select` signal and the question's options when it has some, a free answer always possible (Linear lets the human type instead of picking). A failed deterministic check comes first, as a free question asking to complete the ticket; past 3, the last of intake's are dropped, and intake asks them again on its next pass.

The ticket then waits, **not blocked** (`TicketState.clarify`): nothing moves, the `Blocked` label stays off. Two timers are armed (ORC-161), on the decision's clock:

| After | If questions are still open |
| -- | -- |
| 24 h (`clarify.remind`) | the question on screen is asked again, prefixed « Reminder » |
| 72 h (`clarify.expire`) | the ticket is blocked on `intake` at step `clarify`, cause « question », the open questions in the blocking comment; a reply relaunches `intake` (ORC-196) |

A timer only acts on the round that armed it (`at`): a round answered, asked again, or ended by whatever moves the ticket on (a block, an undelegation, a delegation again, a dev run, a move) does nothing.

**Answers.** A reply in the ticket's session is checked against the matrix (`answer_clarify`: the requester or a team member, ORC-186); refused, it is traced, answered in the session and counts for nothing. Accepted, it is kept in `humanInbox` as any reply (ORC-180) and answers the question on screen, a picked option or free text alike; any other authorized reply in the session counts too (a « +1 » included). A command (`/status`) answers none, nor does a question back (classified `question`): it is answered by `ask`, the question stays. A comment on the ticket is not read while it waits (`ticket.commented` awaits only a block's reply, and the matrix keeps `answer_clarify` to the session): the questions say to answer here. Once every question has its answer, `intake` starts again with the inbox as feedback, reads the ticket again and judges it anew: complete, `dev` starts; otherwise it asks again.

**Decisions.** Each accepted answer, signed (I12), is recorded on the ticket (`decisions`: question, answer, author, time). Every later run of the dev queue but intake (which reads them as its feedback) gets them in its prompt (« Decisions », as data), so the `tests` step writes them as tests; the freeze after `red` and `/refreeze` hold the ticket's decisions as they are then (`frozenTests.decisions`). Nothing clears them yet: a ticket delegated again keeps them.

**Not yet**: resuming intake's Claude session (`--resume`) after the answer: `intake` runs in a session of its own, not the ticket's (ORC-217, ORC-254), so it starts afresh with the answers; the `Questions` step of the session plan stays canceled (ORC-171); a `knowledge.candidate` event per answer (ORC-258); not asking again what was already decided (ORC-254).

## `spec_draft`, `spec_check` and the `spec_review` gate (ORC-212)

The `spec` job (agent, skill `factory:spec`, Sonnet, effort high, the repository's network, in the ticket's worktree, its own session) writes the spec of the ticket and writes nothing else: since ORC-383 the run holds it to that, with `Read`, `Grep` and `Glob` only. With no shell, it no longer reads the linked tickets (`factory-agent issue`): it judges from what the ticket says of them. It hands it back in the `spec` field of `submit_result` (`src/core/spec.ts`):

| Section | What it holds |
| -- | -- |
| `goal` | what the ticket delivers |
| `out_of_scope` | what it does not do |
| `criteria` | the acceptance criteria, each a testable example (« Given …, when …, then … »), at least one |
| `properties` | optional « for any input » properties, each with its `statement`, input `domain` and `target` (frozen as property tests by ORC-261) |
| `files` | the files the change touches |
| `architecture` | its impact on the architecture |
| `risks` | what could go wrong |
| `assumed` | what is taken as correct without checking it: present even empty |
| `decisions` | the `clarify` answers it applies, by their question (ORC-210) |

Every section is optional to the schema: a missing one is `spec_check`'s verdict, not a refused result. Their sizes are capped like the rest of `submit_result` (ORC-214), the spec as published included.

**`spec_check`**, deterministic, at the end of the job: every section present (an empty list counts), at least one criterion and none empty, each property with its statement, domain and target, and each decision `clarify` recorded on the ticket carried in `decisions` with the answer given (read once `TicketState.decisions` exists, ORC-210). A spec that fails goes back to the job once (counter `spec_check`, `limits.specCheckReturns`), in a session of its own, with what is wrong and the refused draft (« Spec refused by spec_check »); the next failure blocks the ticket on the job, step `spec_check`, cause « failed ». A spec that passes resets the count.

**Publication.** A spec that passes is a new version of the ticket's spec (`TicketState.spec`: its job, its number, its content, when), without approval. The factory posts it in the ticket's Linear session, through the `OutputPolicy` like every text it publishes: « Spec published (risk: medium). 3 acceptance criteria → tests. », the sections in a fixed order, then the commands. The ticket does not move (it stays in Todo, the spec in its session, until ORC-139 decides on a « Spec » status) and is not blocked: it waits for the review.

**`spec_review`**, a human gate always at the MVP. Three commands, replied in the ticket's session (a reply, not only after a mention: `webhook.ts` reads them as commands, never as feedback), all three reserved for the project's designated validators and never the run's initiator (matrix row `validate_spec`, ORC-186), checked even on an event without resolved roles. Refused, the command is traced (`authz: refused validate_spec …`) and answered in the session; sent anywhere else (a mention, another session), it is refused as not through this channel; written as a plain comment on the ticket, it is not read (a comment is read only as the reply to a block).

| Command | Effect |
| -- | -- |
| `/approve` (or `/approve <version>`, which must be the version waiting) | records who approved the version and when (`spec.approval`), then starts the job after the spec (`on_success.run`: `tests` in the pack) |
| `/changes <comment>` | the comment goes into `humanInbox` as an instruction (ORC-180), and the job drafts the next version from it and its last one (« Spec under review »), in a session of its own, never the ticket's; a version is never approved by an earlier approval. Until it is published (`spec.drafting`, a start still in the queue included), nothing is approved, changed or rejected. 3 rounds since the last approval (counter `spec_review`, `limits.specChanges`): the 4th blocks the ticket on the job, step `spec_review`, cause « limit » |
| `/reject` | blocks the ticket on the job, step `spec_review`, cause « stopped »: a reply drafts again |

A command with no spec waiting (none yet, a ticket blocked or undelegated), on a version already approved, or while a new version is being drafted, is answered and changes nothing. A human's reply to a block on the job gives the return and the rounds back.

**The spec changed during the run.** A `/changes` on the approved version: the work on it stops (`work.cancelled`, `stop_run`, a start still in the queue included), the approval goes, and the job drafts the next version, which goes through `spec_check` and waits for a new `/approve`: the run starts again from the review.

**After approval.** Every later step of the ticket's dev queue reads the approved spec in its prompt (« Approved spec »): `tests` writes its criteria as the acceptance tests, the build works within it. The freeze after `red` (ORC-131) keeps the approved criteria with the frozen tests (`frozenTests.criteria`); like its files, a later freeze adds the criteria of a version approved since to those already frozen, and the tests of a changed criterion stay frozen until `/refreeze`, which keeps the criteria approved then. A new delegation clears the ticket's spec: the work starts afresh. A redraft reads its last version (« Spec under review »).

`spec` is off in the pack: a repository turns it on by running it after `intake` (`jobs.intake.on_success: { run: spec }`) or at delegation.

**Not yet**: the « Spec » status or the spec as an editable comment (ORC-139), and with it a spec edited by hand; a `knowledge.candidate` event for each `/changes` and `/reject` (ORC-258); the decisions of the scope given to `spec_draft` (ORC-254); the properties frozen as tests (ORC-261); « assumed without verification » in the PR description (ORC-195); the spec's critique (out of scope).

## `review` step (ORC-183)

Once `dev`'s commit is published (`on_success: { move: ai_review, post: summary, run: review }`), the AI review starts: two agent sessions on Opus, effort high, 25 turns, one after the other, each a fresh session of its own (role `reviewer`), never the implementer's. Every job that writes goes back through it the same way: `fix-ci`, `fix-review`, `fix-human`, and `dev-feedback` since ORC-170. When `dev`'s publication is refused and a later job publishes, that end makes the move `dev` owed and starts the review it came with (on a version frozen before ORC-170, `dev-feedback` has no move of its own: the owed move and its review are what reach the reviewer).

| Job | Lens | What it looks at |
| -- | -- | -- |
| `review` | `correctness` | the diff against the ticket, what it breaks elsewhere, the repository's rules, comments that contradict the code |
| `review-security` | `security` | unvalidated input, access, secrets, destructive changes; tests that cannot fail, weakened or missing |

Both flag over-engineering (an abstraction with one user, code outside the ticket). The skill is `factory:review`, built on `factory:code-review`; the prompt names the lens.

**What a lens reads.** A fresh clone of the commit the factory published (`verifiedSha`, the one `verify` found green), made by the factory, detached, under `_trunk/<runId>/` and gone with the run (workspace `published`): never the agent's worktree, nor a head pushed since. Its diff against the trunk is read on the factory's repository before the session starts and given in the prompt, past 60,000 characters the list of changed files instead (`capDiff`). The session has `Read`, `Grep` and `Glob` only (`claude --tools`): no write tool, no shell, no subagent. Its sandbox runs at network `claude-api`: the proxy lets the Claude API through, nothing else, whatever the repository's level. A reply on a ticket blocked on the review relaunches its first lens, which still reads the diff alone.

**What a lens hands back.** Through `submit_result`, a `findings` list (`[]` when it found nothing): `{ file, line, severity: blocking | minor | out_of_scope, explanation, suggestion, fact? }`, at most 50. `fact` is the id of a Claim Ledger fact the finding violates, for when the reviewers get them as a checklist (ORC-254, ORC-229). A lens without a findings list, or a ticket without a published commit, is blocked.

**What the factory publishes.** Each lens's findings are kept in the `findings` table, by ticket, commit and lens, a lens run again on the same commit replacing its own. At the end of `review-security` (`on_success.post: review`), every lens's findings on that commit go out as one GitHub review on the PR (a comment, it neither approves nor requests changes), each blocking or minor finding a comment on its line, the out-of-scope ones (on code the diff does not change) listed in the review's text; when GitHub cannot place one (a line the diff does not show), all of them are listed there instead, shortened if they would not fit in one text. The texts are vetted together, one secret scan for them all. Then the `factory/review` check on the commit: failed while a blocking finding stands, green otherwise, its title the count (« 1 blocking finding, 2 minor, 0 out of scope »). Every text goes through the `OutputPolicy`: a refused one is replaced by its notice, its place kept. Nothing goes to Linear. Then the move to Human Review, which records the reviewed commit as before. A review that fails to go out is retried by the outbox; a dead one blocks the ticket, and the move waits.

**No human move needed (ORC-170).** A commit `dev-feedback` publishes (a reply in In Progress, or to a block with no step of its own) ends as `fix-human` does: `on_success: { move: ai_review, post: reply, run: review }`, then Human Review on that commit. Messages that came in meanwhile are handed over at the review's end, in Human Review: a round of `fix-human`.

**Nothing new, no review (ORC-170).** The end of a job that writes and whose `on_success` starts the AI review (`dev`, `dev-feedback`, `fix-ci`, `fix-review`, `fix-human`) starts it only when there is something new to review. With no PR (nothing ever published: an answer before the first commit), or on the commit shown in Human Review, already reviewed (`reviewSha`: an answer that committed nothing), it posts its reply or summary, moves nothing and starts no review: the ticket stays where it is, and messages waiting are handed over as at any end with no step behind it. Only in Human Review: out of it (the review loop, or after a human's move, which keeps the reviewed commit), the end is judged again, a `fix-review` that contests without committing included. The lenses chain as before. On a version frozen before ORC-170, `dev-feedback` moves nothing: a human moves the ticket to AI Review to have its commit reviewed. A push by a human is verified (ORC-159), not reviewed: the AI review reads only what the factory published.

## Human review feedback (ORC-190)

```
human_review (gate) → feedback? [ fix → verify_fix → publish → AI review → human_review ]   ≤ 3 rounds
```

**What starts a round.** In Human Review, a reply in the ticket's session, or a review written on the open PR (`pr.reviewed`, from the GitHub webhook). Nobody moves the ticket: the move from Human Review back to In Progress starts nothing any more. A review must carry words and not be an approval (an approval, or a review with no text, asks for nothing), and its author must have write access to the repository: the matrix checks the GitHub login that signed the webhook (`review_feedback`, `github:<login>`); a refusal is only journaled and logged, never written in the ticket, since a stranger can comment on a public repository's PR. A review whose author was not resolved is not read at all; a ticket frozen on a version before ORC-190 only journals reviews, as it did. The feedback is kept in `humanInbox`, untrusted for a review (I12), and grouped for 3 minutes like any reply. Out of Human Review a review starts nothing: during other work (a fix running, the AI review) it waits for that work's end, which hands it over (`handOver`), else for the next step's launch. A round armed in Human Review does not start once the ticket left it (moved to Done or back to In Progress). A blocked ticket keeps a review in its inbox; only a reply in Linear relaunches.

**The fix.** `fix-human` (step `fix`, skill `factory:feedback`) resumes the ticket's session in its worktree, on the same branch and PR. Its input is the feedback: the session's messages, the reviews' text, and the PR's unresolved review threads, read from GitHub at the launch (an inline comment is read in its thread, not as the inbox kept it, so a thread resolved meanwhile is not sent). Then `verify_fix`, `publish`, both lenses of the AI review and Human Review again, never straight back. The feedback counts as blocking: the review that follows decides on the new commit, and its own blocking findings take the review loop below.

**Counted.** Each start of `fix-human` is a round (`humanReviewRounds` of the ticket, `limits.humanReviewRounds`), apart from `review_ci`: a relaunch after a cut and a return of `verify_fix` are no new round. With 3 rounds started, the next feedback blocks the ticket (kind `limit`, step `fix`) instead of starting `fix-human`, its feedback kept; a reply relaunches `fix-human` on it and gives the rounds back, as a human relaunch gives every bound back. Another PR starts them over too. A human who writes feedback starts work: the count of `review_ci` starts over with it (ORC-184's rule), so each human round gets the review loop's two rounds again.

## The review → fix loop (ORC-184)

```
loop ≤ 2 [ AI review → fix → verify_fix → publish → AI review ]
```

**Counted.** Each lens's blocking findings are counted on the commit it read (`reviewBlocking` of the ticket). Once `review-security` ends with one standing, of either lens, its `on_blocking` job starts in place of its `on_success`: `fix-review`, one round of `review_ci`, the counter red CI and conflicts use (`ciFixAttempts`). The review is published all the same, `factory/review` red, and the ticket stays in AI Review. Past the bound, nothing starts: the ticket is blocked (kind `limit`, step `fix`), the findings on the PR; a reply resumes `fix-review` on it, which then goes back through the review, and gives the counter back. A red CI during the merge gate uses a round too.

**The fix.** `fix-review` (step `fix`, skill `factory:feedback`, Sonnet, effort medium, 60 turns, the repository's network) resumes the ticket's session in its worktree. Its input (`findings`) is the review's blocking findings, read from the `findings` table on the reviewed commit, each under an id (its lens and its rank, `correctness-1`), then the PR's unresolved review threads as they are, untrusted. One commit per finding fixed, or the finding contested with a justification: its `submit_result` says which of each id, in `fixed` (`{ finding, commit }`) and `contested` (`{ finding, justification }`), and refuses two findings on one commit. Then `verify_fix`, `publish` and both lenses again; `fix-ci` takes the same way back since ORC-184. The review starts at the publication, as after `dev`, without waiting for the CI.

**Contested.** A contested finding stays open: the ticket keeps it (`contested`) with the commit it was found on, and the next review's lenses read it, with its justification, after the diff (« Contested findings »), resolved once for the round: the first lens replacing its findings on a commit reviewed again does not change what the second reads. They judge it again, and report it again unless the justification holds. Once that review has published, the findings standing are its own.

**Not yet.** That each finding fixed is in the commit it names is the agent's word: `verify` does not check the commits against `fixed`. The fix's summary goes to Linear (`post: reply`), not to the PR's threads.

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
3. It reads the runner's machine report (ORC-342): the JSON report of vitest (`--reporter=json`) or jest (`--json`), the JUnit report of pytest (`--junitxml`), written to a temporary file and printed after the output behind a random marker. The runner is the one the command names (`npx vitest run`, `python -m pytest`), or the one the `package.json` script runs when the command goes through `npm` or `pnpm` past a `--` (`npm test --` in the pack), as the last command of that script. Only the report's failure messages and the errors of the files that did not load are classified, never a test's name: a passing test called "fails on an AssertionError" changes nothing. Without a known runner, or when the runner wrote no report (it crashed before, the flags went elsewhere), the text output is read as before, a word of a test's name included. It classifies (vitest, jest, pytest), errors before "no tests" (pytest writes `collected 0 items / 1 error` before an import error):

| Output | Cause | Red |
| -- | -- | -- |
| failure on an assertion (`AssertionError`, `expect(received)`, `E assert`) | `assertion` | verified |
| module not found ("Cannot find module", TS2307, `ModuleNotFoundError`) none of whose paths exist at `baseSha`: relative to the test file in TypeScript, in a package of the repository in Python | `missing_module` | verified |
| symbol an existing module does not export (TS2305, "does not provide an export named", `is not a function` for a function imported by the test, `cannot import name`), absent from the module at `baseSha`: not among the exports of its syntax tree in TS and JS (a mention in a comment or a string is not one, ORC-342), not defined, assigned or imported at the top level of a Python module (read line by line: no Python parser) | `missing_export` | verified |
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

**What is frozen**, read from the factory's repository at the step's final commit, never in the agent's worktree: the step's tests, and anywhere in the repository the harness files: `vitest.config.*`, `jest.config.*` (JSON included), their `setup` and `workspace`, `setupTests.*`, `tsconfig*.json`, `jsconfig.json`, `bunfig.toml`, what `npm test` runs of each `package.json`, `conftest.py`, `pytest.ini`, `.pytest.ini`, `pytest.toml`, `.pytest.toml`, and the section pytest reads in `pyproject.toml` (`[tool.pytest…]`), `tox.ini` (`[pytest]`) and `setup.cfg` (`[tool:pytest]`). And, since ORC-342, the configuration of any tool, by the shape of its name: `<tool>.config.*`, `<tool>.conf.*`, `.<tool>rc*` (`vite.config.ts`, which holds vitest's `test` and the aliases a test imports through, `babel.config.js`, `.swcrc`, `next.config.mjs`, `playwright.config.ts`, `.mocharc.yml`, `.npmrc`…), but those of the tools that change no test (ESLint, Prettier, Stylelint, commitlint, lint-staged, markdownlint, cspell, Tailwind, PostCSS, browserslist, Renovate, husky, nvm) and those under a `src/` folder, the application's own. Each file has its sha256 fingerprint (of its content, or of only the part read by the tests for `package.json` and the three shared files; a `tox.ini` or `setup.cfg` without a pytest section is not frozen). What `npm test` runs of a `package.json`: its `test`, `pretest` and `posttest` scripts, every script they run in turn (`npm run x`, `yarn x`, `run-s x`) with its own `pre` and `post`, and the keys of the test tools (`jest`, `mocha`, `ava`, `babel`, `c8`, `nyc`). A freeze made before ORC-342 keeps the harness and the `package.json` part (its `test` script) it was made with: a deploy blocks no ticket frozen before it on files it did not freeze; a `/refreeze` takes it to the new rules. The freeze of tox's and nox's own sections (`[testenv]`, `noxfile.py`) is not there: the factory runs the job's test command itself, not tox. The freeze (commit and fingerprints) is in the ticket's state (`frozenTests`), set by the journaled event that read it: who and when are in the journal.

**The check.** Once the freeze is set, every run of the ticket in its worktree (`dev`, `dev-feedback`, `fix-ci`; the AI review writes nothing since ORC-183) goes through verification, even without a `verify` command: the factory reads the files changed from the freeze commit up to the branch's head. A frozen file modified or deleted (an added `skip` or `only` is a modification), or an added harness file, makes `factory/tests-gelés` fail: the verification fails, the run starts again with the summary, then the ticket is Blocked at the end of `verify`, without moving to Human Review. The check does not look at the author: a human commit on a frozen test fails the same way. A check that cannot read the branch fails too, and a file of the commit that is unreadable at freeze time makes its reading fail: the freeze never opens on a failure. A second pass through `tests` adds its new tests to the freeze, without touching those already frozen; a harness file added since the first freeze does not enter it and keeps failing.

**`/refreeze`.** The only way out of the freeze: a designated maintainer (ORC-186's matrix) mentions the agent in the ticket with `/refreeze`, or replies `/refreeze` in its session. Before the decision, the factory reads the freeze at the branch's local head, without `fetch` (the already-frozen files and the harness), and journals it with the command; if accepted, it replaces the old one and the reply in the ticket gives the commit; the next verification starts from it. If refused (another role, unsigned actor, or no role resolved), the command is journaled (`authz: refused refreeze …`) and answered in the ticket, and the freeze does not move. Refreezing relaunches nothing: a Blocked ticket is relaunched as usual. On a ticket without a freeze, `/refreeze` does not create one: the reply says there is nothing to refreeze. The one exception is a diff of the verification configuration held for this very `/refreeze` (ORC-198, below): it freezes the harness at the head. The freeze records who refroze it (`frozenTests.refrozenBy`).

**Not yet**: the check published on the PR (ORC-273); the worktree's uncommitted files are not read: a test left uncommitted is not frozen, but since ORC-151, with sandboxes, the `verify` commands do not see them either: they and the freeze read the same commit, in a fresh clone; a trunk change brought in by a `merge` or a `rebase` counts as a change since the freeze, and requires a `/refreeze`; only setups and fixtures named like the harness are frozen, an existing `test/setup.ts` is frozen only if the step changed it; `/refreeze` from a PR comment; the `freezes` table separate from the journal; the scan for disabled tests outside frozen files remains that of `anti-triche` (ORC-158).

## The class of the diff and the review label (ORC-198)

**The class.** `verify` classifies the diff of the commit it checks against the default branch, on the same reads as the path rules (in the fresh clone, or on the host without sandboxes), and journals it in `verify.passed` (`diffClass`: the class and at most 20 of the paths that made it so); the ticket keeps it with `verifiedSha`. A commit found green again keeps the class read of it before. The classes, lowest to highest; a diff takes the highest it touches:

- `normal`: the rest;
- `sensitive`: a path of the repository's `sensitive_paths` (`.factory/config.yml`, read on the default branch);
- `verification-config`: what verifies the work, the frozen harness of the freeze above (a shared file such as `package.json` only when the part the tests read changed), `.factory/**` and `.github/workflows/**`. The last two are forbidden paths too, so a branch that touches them is refused by `factory/chemins-interdits` anyway.

**Approvers per class.** The preset declares them (`approvers`), as the authz actions their approval takes, whose roles are ORC-186's matrix: `done_merge` (Done by a human with merge rights) for every class, which `compilePreset` requires, so the factory never merges on its own; `verification-config` also takes `refreeze` (a designated maintainer). Such a diff is held **before publication**: the ticket is blocked, nothing is pushed, and the block names the paths and `/refreeze`. The maintainer reviews it and sends `/refreeze`, which freezes the harness as it is at the head (it opens a freeze on a ticket that had none); a reply in the thread relaunches, and the commit goes out, since `factory/tests-gelés` holds the harness as approved: changed again, it fails. A freeze made by the factory after `red`, not by a `/refreeze`, approves nothing. A verdict journaled before ORC-198 has no class and is published as before.

**The label.** When the ticket moves to Human Review, the factory labels its PR, one label of the group at a time (`setExclusiveLabel`: the others of the group taken off, the PR's other labels left alone, nothing written when it is already in place):

- `revue: requise`: a `sensitive` or `verification-config` diff, blocking findings of the AI review on the commit shown (`blockingFindings`), or a class unknown (none journaled, or read of another commit);
- `revue: échantillon`: of the rest, a deterministic 10 % draw on the ticket's id (sha256);
- `revue: auto`: the rest.

At the MVP the label changes nothing of the path: **every PR goes through Human Review**, whatever its label, and only a human's Done merges. No auto-merge in any form. Best effort, as the move out of draft: a label the forge refuses is logged.

**Not yet**: the active control plan (CUSUM, review-level switches, sampling that acts on the label) is out of scope; the classes and their approvers were decided by the coordinator for ORC-198 (see its PR), the MVP doc leaving them open.

## The `factory/anti-triche` check (ORC-158, ORC-342)

On each `verify` with sandboxes, in the clone, on what the branch changed since it left the base (`src/checks/anti-cheat.ts`). The diff is read with full context, so each changed file is whole in it, before and after. A finding is something on a line the diff adds; each finding blocks.

- **The four forms**: a test disabled (`skip`, `only`, `todo`, `xit`, `fit`, the runner's ignore lists), a check bypassed (checker directives, an assertion on constants, a success exit), code that behaves differently under test (`NODE_ENV` compared to `test`, the runners' variables). JS and TS files, the scripts of Vue, Svelte and Astro components included, are read on their syntax tree (ORC-342): an alias (`const later = it.skip`, `import { test as check } from 'vitest'`, `const { exit } = process`), another syntax (`it['skip']`, `test(name, { skip: true }, fn)`, a test context's `skip()`, `switch (process.env.NODE_ENV) { case 'test': }`, `['test'].includes(import.meta.env.MODE)`) or a constant spelled in parts (`'te' + 'st'`, a `const` bound to it) reads as the plain form. `expect(c)` on a constant counts only when its matcher compares with constants too (`expect(1).toBe(1)`, not `expect(1).toBe(count())`). Aliases are read in the file, by name, without scopes nor other files. Python and the other files are read line by line, with patterns, as before: there is no Python parser in the daemon.
- **A test removed or renamed**: the set of tests of each test file (`*.test.ts`, `test_*.py`…) before and after the diff. JS and TS tests by name under their suites (`scores > rounds`, a title that is not a constant by its source), Python ones by function under their classes (`TestScores::test_rounds`, read by indentation). A test file deleted or renamed removes all its tests; a case renamed, or moved under another `describe`, removes its old name. Each is a finding, unless a commit of the branch justifies the file with a `Removed-test: <path>: <reason>` trailer, which the summary sent to the agent recalls; a frozen test changed is already refused by the freeze. A helper or a fixture is not a test file.

## Default reactions and their scenarios (ORC-227)

Each default reaction of the MVP doc has a harness scenario in `test/scenarios/`, tied to the ticket that delivered it. A reaction whose ticket is not delivered yet has none: its ticket brings both.

| Reaction | Delivered by | Harness scenario |
| -- | -- | -- |
| A human message on a Blocked run relaunches the blocked step | ORC-196 | `block-comment.test.ts`, « a member answers on the ticket: the blocked step starts again… » |
| A human message during a run goes to `humanInbox`, with a sign of life; a question starts the answering agent at once, instructions are regrouped over 3 min | ORC-180 | `human-inbox.test.ts`, « a human reply during a run… », « a question during a run is answered at once… », « with no agent at work, replies regrouped over 3 minutes… » |
| Statuses, labels and human commits come in as typed events, never as free text | ORC-160, ORC-134 | `typed-events.test.ts`; `github-webhook.test.ts`, « criterion 2: a push on the agent branch… is a push.human in the inbox » |
| Done by an authorized human merges if the checks are green on the last commit and nothing was pushed since the human review; otherwise back to Human Review with the reason | ORC-148 | `merge.test.ts`, « merges the PR on the reviewed commit… », « merges nothing for a human without the merge right… », « merges nothing after a push since the review… », « merges nothing on a red check… » |
| A red CI comes into the inbox and the engine starts the step that handles it | ORC-134, ORC-270, ORC-184 | `github-webhook.test.ts`, « criterion 5 » (both); the mandatory « CI red 3 times »: `workflow.test.ts`, « CI red 3 times: the first two use the 2 rounds of the one counter, the third blocks the run… » |
| An AI review with a blocking finding starts the fix, on the same counter as red CI | ORC-184 | `review.test.ts`, « the review → fix loop (ORC-184) » |
| A conflict with the default branch comes into the inbox and the engine starts the step that handles it | inbox: ORC-134; the step: ORC-146 (in progress) | inbox only: `github-webhook.test.ts`, « writes reviews and conflicts to the inbox without reacting to them yet » |
| A human push on the branch starts again from `verify` | ORC-159 | `human-push.test.ts`, « criteria 1 and 2… », « criterion 3… », « criterion 4… »; `engine-push.test.ts`; `clean-verify.test.ts`, « a human's push on the agent's branch »; `publish.test.ts`, « criterion 2 of ORC-159… » |
| A spec changed during the run starts again from `spec_review` | ORC-212 (not delivered) | none yet |
| A PR closed by a human cancels the run | ORC-134 | `github-webhook.test.ts`, « criterion 4: a factory PR closed by a human without merge cancels the run » |
| A cancelled ticket cancels the run | ORC-170 (its cancel) | `cancel.test.ts`, « ticket cancelled by a human (ORC-170) » |
| The delegation withdrawn cancels the run | ORC-227 | `cancel.test.ts`, « delegation withdrawn (ORC-227) » |

## Compilation and version

`compilePreset(preset, { repoNetwork, budgets })` checks the core invariants and returns the preset's hash, or throws a `PresetError` listing all violations:

- **bounded cycles**: `next` links alone form no cycle, and every step back names a declared counter, with a positive integer limit;
- **tests frozen before the build**: no step that writes code (`fix`, or `agent_step` with `writes: code`) is reachable without going through a `verify` in `freeze` mode;
- **merge gate**: from written code, a `publish` in `merge` mode is only reachable through a `merge` human gate;
- **read-only reviewer**: every `review` step is read-only, Claude API network at most;
- **offline checks**: every `verify` step runs without network;
- **network**: no step at Full (reserved for `setup`), none above the repository's level;
- **budget caps**: every agent step has a maximum number of turns; given `budgets` (`factory validate` gives them, the daemon does not yet: the values are to calibrate), every agent step has its `per_step_tokens`, the ticket its `per_ticket_tokens`, and the worst case stays under it (ORC-216).

**Worst case** (`src/presets/budget.ts`): from the entry, the run follows `next` and, at each step with a failure edge (red CI and conflict included) whose counter is not spent, may take it instead. The worst case is the exact maximum over these runs of Σ cap of each agent step run, in tokens (`per_step_tokens`) and in turns (`maxTurns`, lowered by `max_turns`). A `verify` step that passes refills its own counter, as the engine's `verify.passed` resets `verifyAttempts` and `redAttempts`: each entry into a checked loop gets all its retries. A way back that refills the counter it spends has no bound, and is refused. On `factory/default` that is 41 agent attempts at most: `spec_draft` 5, `tests` 3, `build` 4, `fix` 20 (5 entries, the review loop twice and the human one three times, each with its 3 retries of `verify`), `review` 6, the others once. A conflict spends the same `review_ci` as a red CI, and its way back (`rebase`, 60 turns, through `verify_rebase` with its 3 retries) weighs what `fix`'s does with equal caps: the worst case takes `rebase` instead where its `per_step_tokens` is higher, up to 8 attempts (2 entries × 4) in place of 8 of `fix`, and `factory validate` needs `per_step_tokens.rebase` like any agent step's (ORC-146). Not counted: a human relaunch, which gives every bound back and is the ticket's `per_ticket_tokens` to bound at run time; and what an attempt spends past its cap before it is stopped (the cap is checked as each message reports its usage). With the review loop at 5 rounds, the worst case was almost twice the cap per ticket of the MVP doc: it is 2 (`review_ci`), the count shared with red CI, and `limits.review_rounds` (« Max review rounds » of the review prompt) defaults to it.

The hash is the sha256 of the preset's canonical JSON (sorted keys): it does not depend on key order and changes as soon as a bound, a model or a step changes. Each run will be frozen on the hash it started with (`workflow_versions` table, ORC-149).
