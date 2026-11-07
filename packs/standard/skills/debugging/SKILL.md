---
name: debugging
description: Diagnosis method for a bug, a red test, a failing CI or unexpected behavior: find the cause before any fix.
---

# factory:debugging

**Rule: no fix without an established cause.** Fixing a symptom moves the bug and costs one more round trip. A deliberate method is faster than a series of random attempts, especially when the "obvious" fix is tempting.

## When

A red test, a failing CI, a bug described in the ticket or in feedback, a broken build, unexpected behavior during your own development.

## 1. Understand what breaks

- **Read the whole error**: the first message, not only the last line; the stack trace; the files, lines and codes cited.
- **Reproduce it** with an exact command, in your working directory. Not reproducible: gather more clues (rerun, logs, exact inputs) instead of guessing.
- **Look at what changed**: `git log --oneline -15`, `git diff <base>...HEAD`, dependencies, configuration, environment variables.
- **Layered system** (CI → script → tool, route → service → database): find at which boundary the data goes wrong. Add temporary output at the entry and exit of each layer, run once, read, then remove that output.
- **Trace the data back**: where does the bad value come from? Who called with it? Go back to the source; fix it there, not where it blows up.

## 2. Compare with what works

Find nearby code that works (the same pattern elsewhere in the repository, a previous version: `git show <sha>:<file>`). List **all** the differences, even those that "cannot matter". If you apply a documented pattern, read the reference in full.

## 3. One hypothesis at a time

Write it down: "the cause is X because Y". Test it with the smallest possible change, one variable at a time. Confirmed: step 4. Refuted: a new hypothesis, without stacking the previous attempts (undo them).

You do not understand something: say so in your message rather than pretending.

## 4. Fix

1. A test that reproduces the bug and fails (`factory:tdd`). Without a test framework: a reproduction script run before and after.
2. **One** fix, at the cause. No "while I'm at it", no bundled refactoring.
3. Verify: the test passes, the neighboring tests too, the original symptom is gone (`factory:verification`).

## Three failed fixes: stop

If three successive fixes fail, or if each fix reveals a problem elsewhere, it is no longer a wrong hypothesis: it is the design. Do not try a fourth. Undo the attempts, describe in your message what you established, what was tried and why it was not enough, and ask the design question with `factory-agent ask "<question>"`, then end your turn.

## No cause in the code

If the investigation shows an external cause (network, third-party service, CI runner, missing secret, flaky test unrelated to the diff): that is a result, not a failure. Write what you checked and what establishes it. Do not blindly "fix" the code: no longer timeout without a measurement, no disabled test, no retry added to mask it. Most "no cause" findings are an incomplete investigation: first check that the failure does not reproduce.

## Stop signals

"Quick fix, we'll see later", "let's try changing X", several changes before rerunning, "it's probably X" without proof, a fix proposed before having followed the data, "one more try" after two failures: back to step 1.

## Done when

The cause is named (file, line, mechanism), a test shows it red then green, and the original command passes.
