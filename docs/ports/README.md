# Port contracts

The engine only talks to the world through six ports. Each has a **sheet** (what every implementation guarantees: methods, idempotence, errors, fencing) and a **conformance suite**, parameterized by the implementation: the harness's fake passes it, and a new adapter must pass it before being plugged in.

| Port (MVP doc) | Interface | Sheet | Suite | Run on |
|---|---|---|---|---|
| Tracker | `Tracker` | [tracker.md](tracker.md) | `test/contracts/tracker.contract.ts` | `FakeTracker`; `LinearTracker` live, read-only |
| Forge | `Forge` | [forge.md](forge.md) | `test/contracts/forge.contract.ts` | `FakeForge`, `GitHubAppForge` (on a scripted `fetch`), `GhCliForge` (on a scripted `gh`); `GhCliForge` live |
| Publisher | `Publisher` | [publisher.md](publisher.md) | `test/contracts/publisher.contract.ts` | `FakePublisher` (`GitPublisher` through its own tests) |
| SandboxProvider | `SandboxProvider` | [sandbox-provider.md](sandbox-provider.md) | `test/contracts/sandbox.contract.ts` | `FakeSandboxProvider`, `SandboxRouter`, `ContainerSandboxProvider` (isolation tests) |
| CheckRunner | `CheckRunner` | [check-runner.md](check-runner.md) | `test/contracts/check-runner.contract.ts` | `FakeCheckRunner`, `runVerify` |
| AgentRuntime | `Runner` | [agent-runtime.md](agent-runtime.md) | `test/contracts/agent-runtime.contract.ts` | `FakeRunner`, `ClaudeCodeRunner` (fake `claude` CLI) |

The interfaces keep their current name (`Runner` for AgentRuntime): they will take the target name when the port changes shape, not before.

## Plugging in a new implementation

A suite is a function `describe<Port>Contract(name, make)`. `make` is called per case and returns a fresh subject: the implementation, plus what the suite cannot invent (an existing ticket, a PR, failing commands…). Each suite's `<Port>Subject` type says what to provide; a missing optional field skips the cases that need it (`subjectWith`, `test/contracts/cases.ts`). A test next to the adapter calls it; for a future container adapter, for example:

```ts
import { describeSandboxContract } from '../../../test/contracts/sandbox.contract.js';

describeSandboxContract('ContainerSandboxProvider', () => ({
  provider: new ContainerSandboxProvider({ cli: 'podman', /* … */ }),
  request: { runId: 'r1', ticketId: 'ORC-1', workspacePath: '/w', network: 'none' },
  active: async () => listContainersLabelled('factory.run'),
}));
```

A suite starts no service: for an adapter that talks to a real service, the test is a live test (below).

Every error or effect guarantee in a sheet has its case. For a failure, the subject provides the means to cause it (a fake that fails on demand, like `FakeForge.offline`, or the real adapter pointed at a missing directory or a cut network); for an effect the port does not read back (a comment, an activity), the subject provides the means to read it back (the Tracker's `written`). A guarantee we cannot test is not written in the sheet.

## Negative controls

A case that passes against every subject proves nothing if it would also pass against a subject that violates its guarantee. `test/contracts/negative-controls.test.ts` runs every error case of the suites, every replay, idempotence, independence and stop case, the effects of the Tracker's writes and the "only those" of `listDelegated`, against subjects that each violate one guarantee on purpose: the case must fail there on an assertion. What they cover, per port:

| Port | Cases under control |
|---|---|
| AgentRuntime | failing run, run that cannot start, duration and turn caps, `stop` (during the run, replayed, after the end), independent runs |
| CheckRunner | failing command (code, output, order), timeout exceeded, command that does not start, replay |
| Forge | branch without a PR, unreachable forge, unreadable checks |
| Tracker | unknown ticket on read and on write, status missing from the team, replayed `moveTo`, final state of `setLabels`, effects of writes, `ensureSession`, `listDelegated` |
| SandboxProvider | `destroy` of an unknown or already destroyed id, replayed `create`, one sandbox per run, a new one after `destroy`, `exec` (result, unknown id), `spawnCommand` on an unknown id, `findByAttempt`, `list`, refusal of an unmet requirement |
| Publisher | republishing a branch, one PR per branch, a new PR after merge or close |

The faulty subjects for each case are named by the titles in `negative-controls.test.ts`. Happy-path cases have no control: a run that succeeds, a command that passes, a first `publish`, a first `create` and its network level, the nominal reads of the Tracker and the Forge (`getIssue`, `search`, `findPr` that finds the PR, snapshots).

A case that expects an answer from the port (a result, an `undefined`, a `destroy` or a replay with no effect) reads it through `resolved` (`test/contracts/cases.ts`): a subject that rejects instead of answering fails there on an assertion, not on its own error. Any rejection counts, including a `TypeError` from the faulty subject, as an exception to the rule of the next paragraph: a control that passes this way does not tell whether it hit the targeted guarantee.

All suites declare their cases through `describeContract` (`test/contracts/cases.ts`). Its third argument, `{ violates: [case names] }`, puts them in this mode: only those cases run, and each passes only if it fails on an assertion (another error, a `TypeError` from the subject for example, fails the control, as does a subject missing the field the case needs, instead of skipping it). A name that designates no case, or an empty list, fails the file, so that a renamed case does not leave its control running empty. A new error or effect case comes with its control.

## Known gaps

None: each implementation passes every case it runs. `LinearTracker` live runs only the reads (without `states`, the write cases are skipped): its writes go through no suite. The fakes that diverged were aligned by ORC-189; each sheet says which ones, and what a scenario must declare since then (`FakeTracker` status catalog, `FakeRunner` clock).

An implementation that does not hold a case does not declare it in its suite: it aligns, or the case leaves the contract along with the sheet, through a written decision.

## Live tests

Outside CI, skipped without their variables (rule from [`docs/transition.md`](../transition.md#live-tests-outside-ci)):

| Test | Variables | What it reads |
|---|---|---|
| `src/adapters/tracker/linear/tracker.live.test.ts` | `FACTORY_LIVE_LINEAR_TOKEN` (the app's OAuth access token, sent as `Bearer` as the instance does; not a personal API key), `FACTORY_LIVE_LINEAR_ISSUE` (a ticket, e.g. `ORC-1`); options `FACTORY_LIVE_LINEAR_SEARCH`, a word from its title, and `FACTORY_LIVE_LINEAR_DELEGATED` with `FACTORY_LIVE_LINEAR_NOT_DELEGATED`, two tickets from the same team, one delegated to the app (neither done nor canceled), the other not | the ticket and the tickets delegated to the app (the token's user), without writing anything |
| `src/adapters/forge/gh-cli.live.test.ts` | `FACTORY_LIVE_GH_REPO` (a local clone), `FACTORY_LIVE_GH_BRANCH` and `FACTORY_LIVE_GH_PR` (a branch and its PR, with finished checks: a merged PR works); `gh` logged in | the PR, without writing anything; the unreachable forge goes through a proxy on a closed local port |

```bash
FACTORY_LIVE_GH_REPO=$PWD FACTORY_LIVE_GH_BRANCH=orc-168-ci-postgres-docker-rootless FACTORY_LIVE_GH_PR=30 \
  npx vitest run src/adapters/forge/gh-cli.live.test.ts
```
