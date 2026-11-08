# AgentRuntime port

Launch an agent on a prompt, follow its stream, stop it, and read its outcome. This is the current `Runner` port, not renamed as long as its shape does not change.

- Interface: `Runner`, `RunRequest`, `RunHandle`, `RunResult` (`src/adapters/runner/types.ts`).
- Implementations: `ClaudeCodeRunner` (`src/adapters/runner/claude-code.ts`, `claude -p` as a subprocess), `FakeRunner` (`src/adapters/runner/fake.ts`).
- Suite: `test/contracts/agent-runtime.contract.ts`, run by `src/adapters/runner/fake.test.ts` and `src/adapters/runner/claude-code.test.ts` (on the fake `claude` in `src/adapters/runner/fixtures/`, without network).

## Methods

| Method | What it guarantees | Replayed | Error |
|---|---|---|---|
| `start(req)` | a run, and its `RunHandle` | a second `start` launches a second run | does not throw: a launch failure ends in `failure` |
| `handle.events` | the stream's events, in order; the stream closes when the run ends | — | — |
| `handle.done` | the outcome: `success`, `failure`, `stopped` or `limit`, the cost (≥ 0), the turns (≥ 1 on a success), the agent's last text, and the token usage when the runtime returns it (`tokens`, ORC-235; `claude -p`: `usage` from its `result` line), never read from the agent's text | — | does not reject |
| `handle.stop()` | the run ends in `stopped` | no effect; after the end, the outcome does not change | — |

A run that exceeds `limits.durationMs` or `limits.turns` ends in `limit`. Two runs are independent: stopping one leaves the other running.

## Idempotence

`start` is not idempotent: the "Model call" row of ORC-162 puts idempotence in the engine (attempt id), not in the port.

## Fencing

A `RunHandle` belongs to a single `start`, hence to a single `runId`: the suite checks that stopping one run leaves the other running. Ignoring the result of an attempt that is no longer active is the engine's job (ORC-133, ORC-162).

## What the suite asks of the implementation

`AgentRuntimeSubject`: the runtime, optionally `elapse(ms)`, which advances its clock (absent, the suite waits in real time; present, a capped run must end in `limit` within the following 100 ms), and `script(name)`, which prepares the next run to behave as `success`, `failure`, `hang` (runs until stopped or capped), `chatty` (chains at least three turns) or `unlaunchable` (cannot start: `ClaudeCodeRunner` launches it in a missing directory), and returns what its request must carry for that (the fake `claude` reads its script from the environment).

The suite waits at most 1.5 s for the outcome of a run that cannot start, or of a run stopped by `stop`, and as long for its stream to close. A runtime that leaves a grace period before killing its process sets it shorter for the suite: `ClaudeCodeRunner` waits `killGraceMs` (10 s by default) and its suite sets it to 500 ms.

## Assumption on the open question (ORC-155)

ORC-155 will decide whether this port becomes an abstraction of the harness (Claude Code or another). The suite does not decide: it treats the runtime as a black box, and looks neither at the Claude-specific fields of `RunRequest` (`claudeSessionId`, `pluginDir`, `settingsPath`) nor at the CLI arguments (tested separately, `buildClaudeArgs`). A second runtime passes it as long as `start`, `RunHandle` and the four outcomes keep their shape; if ORC-155 changes that shape, the suite changes with the port.

## Known gaps

`RunRequest.sensitivePaths` (the mark of a run that reads untrusted content, ORC-274) is carried all the way to the port, and no implementation enforces it while the run writes: `ClaudeCodeRunner` ignores it, and the suite does not check it. It marks the ticket's branch untrusted, and what the branch then commits in the repository's `sensitive_paths` is refused afterwards, at `checkClone`, on `verify` and on the publication (ORC-338, see [workflow](../workflow.md#lifecycle-events-not-configurable)).

`FakeRunner` ignored `limits`: since ORC-189, it enforces them like the real runtime.

- Turns: a script whose `turns` exceeds `limits.turns` ends in `limit` right away, without waiting for `release`, and reports `limits.turns + 1` turns: the real runtime interrupts the agent on the turn that exceeds and reports the turns read until it exits, at least that one; the fake reports that minimum.
- Duration: on the simulated clock passed to the constructor (`new FakeRunner(clock)`), checked on each `tick()`. A held run (`hold`) ends in `limit` when the clock reaches `limits.durationMs` since its start. The scenario harness passes it its clock and calls `tick()` in `advance(ms)`: a scenario that advances the clock past the cap of a held run sees it end in `limit`.
