# Replay of closed tickets (ORC-231)

Before the factory works on real tickets, it is measured on tickets already solved by a human. Each closed ticket is run again by
the factory, from where the human started, without any effect outside the factory; then a judge compares, blind, the factory's PR
with the human one.

Code: `src/presets/fantome.ts` (the preset), `src/runtime/outbox.ts` and `Orchestrator.keep` (the no-effect mode),
`src/ghost/history.ts` (the historical environment), `src/ghost/delegate.ts` (the daemon's delegation of the tickets, ORC-376),
`src/ghost/replay.ts` (blind pairs, report), `src/cli/ghost.ts` (the command).

## The `factory/fantome` preset

A variant of [`factory/default`](preset.md) at the **Rapide** level (`level: rapide`): the tickets are closed, nobody answers.

```
intake → spec_draft → spec_check → tests → red → freeze_tests → build → verify → publish (kept, the end of the run)
```

- **No question.** Where `intake`'s guard would ask (`clarify`: an incomplete ticket, a failed pickup check, a probable duplicate),
  the questions are assumed instead, each recorded as `Unasked: <question>` (`TicketState.assumed`), and the spec is drafted.
- **Assumptions written in the spec and counted.** A spec that passes `spec_check` is approved by the preset itself (approval
  `factory/fantome`), the assumptions written in its `assumed` section. The report counts them per ticket.
- **No human gate, no AI review, no merge.** The compiler refuses a human gate at the Rapide level. The run ends at its
  publication, which the no-effect mode keeps (below).
- The spec comes from `spec_draft` (ORC-212): the replay does not use the ticket's text plus the build's assumptions.

Until the engine runs the preset's steps itself (ORC-177), `asFantome` sets the workflow it drives: delegation runs `intake`,
`intake` the spec, the spec the tests, the tests `dev`, whose publication ends the run. A project runs it with `preset: factory/fantome`
in `config.yaml`; such a project always has no effects.

## No-effect mode

A project with `effects: none` in `config.yaml`, or on the `factory/fantome` preset, runs its tickets as any other, and nothing of
it leaves the factory: no push, no PR, no comment, no move, no activity. Also of use to try a prompt, a skill or a preset change
without touching Linear or GitHub.

**Enforced in the outbox, not the adapters.** `EFFECT_REACH` classifies every kind of effect, `inside` (runs, checks, workspaces,
the store) or `outside` (Linear and GitHub, `reconcile` included). The outbox executor hands each `outside` row of such a project
to `keep`, never to the adapters: an adapter that forgets the mode cannot push. A new effect kind does not compile until it is
classified. The few writes the orchestrator makes outside the outbox (the move to In Progress at a start, the run's activities,
a block notice, a wait's thought, a new Linear session) check the same mode (`silenced`).

**Kept as artifacts.** Each kept effect is a JSON file under `<FACTORY_HOME>/kept/<ticket>/` with its row in `artifacts`
(`kept:<kind>`). A `publish` keeps the PR the factory would have opened (`kept:pr`): title, body, branch, commit and the ticket's
diff; then the run goes on as after a publication (`publish.done`). Without a place to keep them, the effect fails and the ticket
is blocked: nothing goes out either way.

## Historical environment

- **Start point**: the parent of the human PR's merge commit (its first parent; for a squash, the commit it was squashed onto).
  A rebase merge puts the PR's commits one by one on the base, the merge commit being the last of them: when the merge commit has
  one parent and the last commits carry exactly the PR's commit headlines, the start is the commit before the first of them. The
  clone holds that commit and its history, nothing after it: no later commit enters the context. It is not shallow (ORC-376): the
  run's worktree and the verify clone are fetched from it, and a fetch refuses the refs of a shallow repository.
- **The run's repository** (ORC-376): the clone stands for the project's repository. The start is on a branch named as the
  project's default branch, and its `origin` is the clone itself, its `HEAD` on that branch: the ticket's worktree is made from it as
  from any repository, its trunk the start, and a `git fetch` of `origin` brings nothing that was not there. No forge is named in it.
- **Knowledge base at transaction time** (ORC-257): its last commit before the start commit was made, by commit date, not a date a
  note claims, so a note learned from the replayed PR does not leak into its own replay. `--memory off` gives none (ORC-260).
- **The ticket and its linked tickets** (ORC-376): read from the tracker once, when the daemon delegates the ticket (`history`:
  the ticket's comments, the tickets related to it either way with theirs), then kept as of the start, by the start commit's date:
  the ticket's comments written before it, the linked tickets created before it with their comments of before (`historyAsOf`,
  `linkedAsOf`). Kept beside the clone (`ticket.json`), the run reads them from there, never from Linear. Linear keeps no history of
  a description or a title: an edit made after the start stays.

## Running the tickets (ORC-376)

`factory ghost start` writes the replay and rebuilds each ticket; the daemon runs them. At its start, then each minute, it
delegates each ticket of a replay whose environment was rebuilt and whose run has not started to the replay's project, once
(`ticket.delegated`, its id `ghost:<replay>:<ticket>`, its payload `replay`). No human sent that delegation: no matrix checks it.
The ticket starts to do, whatever Linear says of it now (Done), and runs the fantome's pipeline without effects.

- **On its clone.** The project's repository, for that ticket, is its clone (`Orchestrator.runtimeFor`): the worktree, the diffs and
  the verification read it, not the project's checkout.
- **Its text as of its start.** The run reads the title, the description, the thread and the linked tickets kept at the delegation
  (`## The ticket's thread and its linked tickets, as of its start (data)` in its prompt), and `factory-agent issue` answers the same.
  No link to the live ticket is given.
- **Nothing of what came after.** The forge and Linear hold now the human's PR, its branch and what was written after the start:
  `intake`'s duplicate search and the read of the ticket's own branches are skipped, and `factory-agent search` is refused.
- **Only the daemon's delegations.** Linear's webhooks and the reconciliation never route a ticket to a project on `factory/fantome`:
  its tickets of the same team stay the other projects'.
- **Sandboxes required.** An agent run on the host gets the host's git login and could push by itself, which no effect mode holds
  back. `start` refuses a replay when the daemon said at its last start that it runs without sandboxes, or when no daemon has
  started yet (the `daemon-sandboxes` meta row); a daemon without sandboxes delegates no replayed ticket, and says why in its log.
- **Once per project.** A second run of a ticket would start on the state of the first (its session, its branch, its kept PR):
  `start` refuses a ticket its project replayed already, and the daemon delegates none twice. Replay it on another project.
- **The knowledge base at its start**: the session's index (its system prompt) and the MCP's `kb_search` read the one `start`
  rebuilt under `knowledge/`, never pulled, never the daemon's, which may hold a note learned from the ticket's own PR; neither
  with `--memory off`. No knowledge base is mounted in the sandbox (ORC-232).

## Threshold, judging, report

**Thresholds** (criterion 4, ORC-385): two shares of the compared tickets, decided by ORC-143: at least 60% of the factory's PRs
mergeable, as is or after edits (`--threshold`), of which at least 30% mergeable as is (`--as-is`). Both are required inputs of
`factory ghost start`, refused when missing or not a share, and an as-is share above the mergeable one is refused too; they are
written with the replay before any ticket runs. The store writes a replay once: starting it again with another threshold is
refused, the first ones stay. A replay recorded before ORC-385 kept one threshold: it stays readable, its as-is threshold shown
« not set » and its verdict given on the one threshold it was started with (adding one after the replay would change it after).

**Blind judging** (criterion 5): `factory ghost judge` shows the pairs in an order drawn from the replay's seed, each pair's two PRs
as PR A and PR B in a random order, by their diffs only (a branch, a description or an author would tell whose it is). Each PR is
graded on the fixed grid: 1 mergeable as is, 2 mergeable after edits, 3 to reject; a grade given stands. The judge names their
GitHub login (`--judge`, required): the tickets whose human PR they wrote are left out of their screen.

**Report**: ticket by ticket (grades, assumptions, cost, start commit), the environment failures apart and out of the comparison,
the total cost, both shares (mergeable, and mergeable as is) each against its threshold, and the verdict: `met` when both reach
their thresholds, `below` otherwise, or `incomplete` while a ticket has not run (`pending`) or a pair waits for its grades. A ticket the factory left without a PR, or blocked, counts as not mergeable.

## Commands

```
factory ghost start <project> --threshold 0.6 --as-is 0.3 --tickets REL-12=345,REL-14=351 [--memory off] [--id pilot]
factory ghost collect <replay>
factory ghost judge <replay> --judge <GitHub login>
factory ghost report <replay>
factory ghost list
```

`start` refuses a project not on `factory/fantome`, a daemon without sandboxes, and a PR that is not merged, before writing
anything. It reads each human PR with `gh` in the project's checkout, and rebuilds each ticket under
`<FACTORY_HOME>/ghost/<replay>/<ticket>/` (`repo/`, `knowledge/`; `ticket.json` once delegated). An environment that cannot be
rebuilt is counted apart, with why. `collect` reads what each ticket ran to on the project, within
the replay's time (from its start to the next replay of the same ticket): its last kept PR, its runs' cost, the assumptions of its
spec; a ticket whose run has not ended stays `pending`, and a PR already graded stays the one graded. The human diffs are read
from GitHub when judged.

## Not yet

- **The dry run on each start commit** (criterion 3) needs ORC-208, which waits on ORC-209. Every ticket's environment is
  `unchecked` until then, and the report says how many: the hook is `GhostTicket.env` (`ok`, `failed`, `unchecked`), which the
  report already keeps out of the comparison when `failed`.
- The pilot repository (ORC-137) is a decision still to take.
