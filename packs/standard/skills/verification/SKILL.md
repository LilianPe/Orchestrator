---
name: verification
description: Verify before asserting: run the command that proves a result and read its output before saying it is done, that it passes or that it is fixed, and before each commit, push or PR.
---

# factory:verification

**Rule: no claim of success without fresh proof.** Your last message is published in Linear and a human relies on it. "It should pass" is not a result.

## The gate, before any claim

1. **Which command proves what I am about to say?**
2. **Run it now**, in full, on the current state of the code (not a result from before your last change).
3. **Read** the output and the exit code: number of tests, failures, warnings.
4. The output confirms: claim it, with the proof ("14 tests pass, `npx vitest run src/foo.test.ts`"). It does not confirm: state the real status.

| Claim | Proof required | Not enough |
|---|---|---|
| The tests pass | runner output: 0 failures | an old run, "should pass" |
| The bug is fixed | the original symptom replayed: it is gone | "the code changed" |
| The regression test works | red without the fix, green with it | "I wrote a test" |
| The types are correct | the repository's type check: exit code 0 | the lint, the tests (often without type checking) |
| It is committed | clean `git status`, and `git log -1` shows your commit | "I'm done": the factory only publishes what is committed |
| The CI is green | `gh pr checks <branch>` read, no check running or red | "the CI will run" |
| The ticket is handled | each criterion of the ticket reread and checked off | "the tests pass" |

## What to run, and what not to run

Other sessions run at the same time on the same machine, and the factory then reruns the project's checks (the workflow's `verify`) and then the CI.

- **The tests of what you touched**: the test file of each modified module and those of its direct consumers. With vitest, `npx vitest related <modified files> --run` finds them.
- **An empty list does not run "nothing"**: `vitest run` without a file runs the whole suite, `vitest related` without a file runs nothing and exits successfully. When your file list comes from a command (`git diff --name-only`…), check that it is not empty before running. "No test files found": no test covers these files; say so, it is not a green.
- **The repository's type check and lint**, once before handing back, if they exist and are light (`typecheck`, `lint` scripts of `package.json`, or the equivalent). A change to an exported type breaks files your tests do not run: only the full type check sees it.
- **Not the full suite nor the build**, even if the repository's `CLAUDE.md` recommends it: that is the role of `verify` and the CI. Exception: the repository has neither; then say so in your message.
- **Judge a run by its exit code**, never by a `grep` of its summary nor by the end of an output truncated by `| tail`.

## Pitfalls

- Saying "perfect", "all good", "done" before having run the command.
- Concluding from one checker to another: the lint does not compile, the tests do not always check types.
- Believing a report (from a subagent, a commit message, feedback) without looking at the diff or rerunning.
- A failure in a file you did not touch is not necessarily "not you": a changed dependency breaks an untouched test. To know whether it predates you, check whether it also fails on the trunk (the trunk's CI, or the file's `git log`); otherwise treat it as yours (`factory:debugging`).

## Done when

Every sentence of your last message that says "works", "passes", "fixed", "committed" or "green" rests on a command run after your last change, and you cite it. What you could not verify is written as such.
