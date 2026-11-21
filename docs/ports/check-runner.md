# CheckRunner port

A job's verification commands (`verify`), run outside the agent, and their verdict.

- Interface: `CheckRunner` (`src/adapters/checks/types.ts`), new port (ORC-225); `run` has the `Verifier` type from `src/core/verify.ts`. The ticket's `Verifier` is that type.
- Implementations: `FakeCheckRunner` (`src/adapters/checks/fake.ts`), and the fake runner's stand-in that passes and runs nothing (`src/app/bootstrap.ts`). `runVerify`, `bash -c` in the agent's worktree on the host, is gone (ORC-179). `verify` does not go through this port: `runCleanVerify` (`src/core/clean-verify.ts`, ORC-151) runs the commands in a fresh sandbox, on a clone of the frozen SHA, and rejects instead of answering when it has no verdict. This port remains for a daemon without sandboxes, the fake runner's or a test's (`DaemonDeps.verify`), where it stands in for `verify`, the red check and `setup`.
- Suite: `test/contracts/check-runner.contract.ts`, run by `src/adapters/checks/fake.test.ts`; its negative controls (`test/contracts/negative-controls.test.ts`) break a test-only `bash` runner, `test/helpers/bash-checks.ts`.

## Methods

| Method | What it guarantees | Replayed | Error |
|---|---|---|---|
| `run(cwd, commands, timeoutMs?)` | runs **all** the commands, in order; `ok` is true exactly when none fails; each failure carries its command, its exit code and its output; a command that exceeds `timeoutMs` fails with a `null` code; no commands is a success | reruns the commands | does not reject: a command that does not start is a failure with a `null` code |

## Idempotence

The port publishes nothing: replaying means rerunning the commands, with no further external effect. The verdict is only stable if the commands are.

## Fencing

The result carries no attempt: the engine is what ties it to its run (`verify.passed` and `verify.failed` carry the `runId`). Fencing for `runCleanVerify` is the same: its verdict, or `verify.errored`, carries the `runId`.

## What the suite asks of the implementation

`CheckRunnerSubject`: a directory, a command that passes, two commands that fail with distinct codes and the text they print, and optionally a command that exceeds 200 ms, a directory where no command starts (for a `bash` runner, a missing directory, where `bash` does not launch), and a command that passes while counting its launches, to check that a replay reruns. The fake interprets these commands through a fallback `Verifier` (the one from its constructor).

## Known gaps

None. `FakeCheckRunner` did not pass `timeoutMs` to its fallback `Verifier`: since ORC-189, it does, and the suite plays the slow command through its table, which only makes it fail under a timeout shorter than it.
