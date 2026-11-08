---
name: review
description: AI review loop on a PR until zero blocking defects, with a capped number of rounds (launched by the factory, which publishes the fixes).
---

# factory:review

You bring the current branch's PR to a clean state: review, fixes, targeted review of the fixes, until no defect remains, then integration of the base if needed. **The factory publishes**: it verifies your last commit and pushes it at the end of your turn, then watches the CI. "Max review rounds" (in the prompt) caps the number of rounds. You are alone: your only channel to a human is `factory-agent ask "<question>"`, then end of turn.

**You have no network** but the model's API: no `gh` and no `git fetch`, they fail. The factory reads the PR and brings its commits for you: before your run (the prompt's `## Pull request` section), and again whenever you run `factory-agent pr`, which updates `origin/<branch>` and `origin/<base>` in your worktree and prints the PR's state.

## 0. Prepare

1. PR state: the prompt's `## Pull request` section (number, state, base, mergeable, URL). Missing, or a part "not read by the factory": `factory-agent pr`. PR closed or merged: stop and say so in your last message.
2. `git status`: nothing unexpected in progress (uncommitted changes that are not yours: stop and say so, do not overwrite them).
3. The PR's head is in your worktree: the factory fast-forwarded your branch to it before the run, and the prompt says so. This way you review the PR's head, the one the factory will record as reviewed: if your last commit is not the PR's head at the end of the run, nothing is recorded and the *Done* that follows does not merge. The prompt says the branches have diverged: stop and say so, force nothing.
4. Read the ticket (what the PR must do), the repository's `CLAUDE.md` and `docs/agent/`: the rules that will be used to judge the fixes.
5. Open your **decision log** (in your session notes, not in the repository): one line per decision, `<key> — <decision> — <reason> — round <n>`, where the key is the place (file + function, doc sentence) or the mechanism touched. Every fix, refused finding or point to decide goes into it.

## 1. Round 1: the whole diff, at the level it deserves

1. Choose the `factory:code-review` level from the PR's diff (`git diff --stat origin/<base>...HEAD`, then the hunks if the paths are not enough): **quick**, **standard** or **thorough**, according to its table. It is the only broad pass of the loop: a critical path (access, data, migrations, secrets) takes "thorough" right away rather than raising the level round after round.
2. Run `factory:code-review` at that level, on the PR's full diff (the PR's base, not a subset), with the instruction: only report defects in these lines or in what they break.
3. Keep the in-scope findings; set aside the "out of scope" and "rule conflicts" for the final message (never fixed here).
4. No blocking or important finding: go to step 3. Otherwise: step 2.

## 2. Fix, then review the fixes

**Fix** (every round) with `factory:receiving-review`: verify each finding and its proposed fix before writing, one commit per cause (`<ID>: review round <n> — <cause>`), each behavior fix proven by a test red then green, targeted tests only. The **minor** findings of round 1 may be fixed with the rest; after that, never again.

Do not fix, and note as **to decide**:

- a trade-off (fail open or closed, a limit, a timeout, a threshold): describe both failure scenarios;
- a fix disproportionate to the finding (large blast radius, a sensitive path already restructured by the loop);
- a finding that would reverse a decision in the log, or that concerns a key already changed by **two** rounds: it is a design question, not a queue of fixes;
- a text without an executable oracle (comment, doc, prompt, tuning constant) already changed once for a wording question: another reading of the same text does not justify a second change. A text that contradicts the code remains a defect to fix.

**Review** (round 2 and later): `factory:code-review` at the **standard** level, limited to the previous round's fix commits (`git show <sha>` for each) **and to what consumes them** (a narrowed type, a function whose contract changes, a shared state). Never a new review of the whole PR. Give it the log with the instruction: "these choices are decided; a finding that would reverse one is written `reversal: <key>`, not as a defect; a bug introduced by a fix is a defect".

**Convergence**:

- a round whose findings are all minor **has converged**: the remaining minor findings go into the final message, not into a new round;
- two rounds in a row with a serious defect (data loss, vulnerability, silent overwrite) on the same key: stop the loop, undo (`git revert --no-edit <sha>`) a fix that proved harmful, and report the mechanism as a design point;
- "Max review rounds" cap reached with a blocking or important defect still open: stop, do not commit an unreviewed fix, and report it.

After each round, note one line: `Round <n>/<max> — <x> findings (<k> fixed, <h> out of scope, <m> minor, <t> to decide)`.

Before declaring the loop converged, run the repository's type check (and the lint) **once**: a fix that breaks a type survives every targeted review. An error found there reopens the loop (fix, one targeted round, counted in the cap).

## 3. Has the base moved?

1. `factory-agent pr` (what arrived on the PR and its base since your run started), then `git log --oneline HEAD..origin/<base>`: what arrived on the base since the branch started. A human pushed to the PR meanwhile (`origin/<branch>` has commits your branch lacks): `git merge --ff-only origin/<branch>`, or, if it fails (diverged), stop and say so, force nothing.
2. A commit there that invalidates a premise of a fix (a timeout, a quota, a contract cited in a commit message) is a finding like any other.
3. Never integrate the base: no merge, no rebase, even on a conflict or a mergeable status at `BEHIND`. A conflict is the factory's: it starts its own `factory:rebase` step on it, after your run.

## 4. Hand back

Commit everything, then end your turn. You do not push and you do not wait for the CI: the factory verifies your last commit, publishes it, and launches `factory:fix-ci` if the CI fails.

## 5. When to ask a human

A point **to decide** that may be a defect, or a blocking defect still open at the cap: ask ONE question with `factory-agent ask`. It blocks the ticket: it does not move to "ready to merge" and your summary **is not published**. So the question carries the synthesis: rounds done, what is fixed, and the point to decide with its options and the key's history.

Points to decide that are only trade-offs or preferences, minor, out of scope: no question, they go into the summary.

## Forbidden

Never merge. Never push, to any branch: the factory publishes. Do not rebase, do not rewrite history (`--amend` included). Do not switch branches. Never fix an out-of-scope finding. Do not disable or weaken any test or CI step.

## `submit_result` summary (published in Linear)

End your turn with `mcp__factory__submit_result`: its `summary` is this message, which the factory publishes. Nothing else you write is.

In English:

```
**Review synthesis** — N rounds out of <max>, round 1 level: <quick|standard|thorough> (<reason>).
**Fixed** — bullets (<short sha> per cause).
**Left for a human** — points to decide (with both options), remaining minor findings (`file:line — finding`), rule conflicts (with the rule); or "nothing".
**Out of scope** — defects that predate the PR, one line each with importance (high/medium/low) and whether they deserve a ticket; or "nothing".
```
