# Command line

The factory provides one executable, `factory`, for you, the operator (installed by `npm link`, see [`installation.md`](installation.md)). The agents have none: during a run they reach the factory through its MCP alone (`submit_result`, `kb_search`, see [`interface-and-security.md`](interface-and-security.md#factory-mcp)); the agents' former CLI is gone (ORC-192).

All `factory` commands read `FACTORY_HOME` (default `~/.factory`) and `config.yaml`. An unknown or incomplete command prints the help and exits with code 1.

## `factory`

| Command | Role | Daemon required |
|---|---|---|
| `factory init [--dev]` | Configure the factory for the current repository (`--dev`: a smee.io relay for Linear's webhooks, on a workstation). | no |
| `factory validate [repo]` | Check `.factory/config.yml` against the baseline, the tools of each agent step and the worst case of the budgets. | no |
| `factory doctor [repo]` | Refuse a host without cgroup v2, a repository without a protected default branch or whose CI can expose secrets to the factory's branches. | no (GitHub App) |
| `factory up [--fake-runner]` | Start the daemon. | — |
| `factory plan` | List the delegated tickets and say which ones would be picked up. | no (Linear connected) |
| `factory status` | State of the running instance: tickets, blocks, runs. | yes |
| `factory pause` / `factory resume` | Suspend / resume the queue. | yes |
| `factory stop <ID>` | Stop a ticket's run. | yes |
| `factory dry-run <project>` | Run the dry run of a project's default branch (setup, build, tests in the sandbox) and print what breaks. | yes (with sandboxes) |
| `factory replay <journal>...` | Replay exported journals (bit-for-bit regression, `--what-if <preset>`, `--export <ID>`). | no (no instance needed, except `--export`) |
| `factory run repair <ID> [replay\|skip\|force] [<event>]` | List or repair a ticket's set-aside (dead-letter) events. | no (reads and writes the database) |
| `factory flaky <project> [add <test> --reason <why> [--frozen] \| remove <test>]` | The known flaky tests, which `verify` marks indicative. | no (the database) |
| `factory baseline <project> --since <YYYY-MM-DD> [--replace]` | Freeze the 90 days before the factory's start as the overview's baseline, from Linear and GitHub. | no (Linear connected, GitHub, the database) |
| `factory ghost start\|collect\|judge\|report\|list` | Replay closed tickets without effects, judge the factory's PRs blind against the human ones, report against two thresholds written before (mergeable, mergeable as is). | no (the database, the GitHub App for `start`, git) |

The commands that require the daemon go through its Unix socket, `cli/factory.sock` in `FACTORY_HOME`, when it is there (ORC-405): on the daemon's server, as the factory's user (mode 0600), with no GitHub sign-in, and their actions are journaled as `cli:<host>`. Otherwise they call `http://127.0.0.1:<port>/api/…` with the `port` from `config.yaml`, with no credential: a daemon that listens beyond loopback asks for a GitHub sign-in, which only the dashboard gives (ORC-399), and they then say so. From another machine: SSH to the server. In Docker, run them in the container: `docker compose exec factoryd node dist/src/cli/factory.js status`.

### `factory init`

Run it **in the repository** to entrust to the factory (otherwise it asks for the repository path). Interactive wizard:

1. Asks for the **Linear team key** (e.g. `REL`), uppercased.
2. Adds (or replaces) the project in `config.yaml`: `id` = name of the repository directory (slug, 30 characters max), `repoPath` = git root, `linearTeamKey`; a project already there keeps its `id` and its other fields (`authz`…).
3. With `--dev`, and without `publicUrl` or a configured relay, creates a **smee.io channel** and records it in `relay`: for a workstation only (ORC-411). `--dev` also writes `dev: true` beside a smee relay, new or already there: the development mode, without which the daemon warns of the relay, or refuses it with `dev: false` (ORC-444). With a `publicUrl`, it writes none. Without `--dev` nor `publicUrl`, it creates none, says to set `publicUrl` or run `factory init --dev`, and skips step 4: Linear gives its webhook secret only for a webhook URL.
4. Prints the exact values to enter in Linear (callback URL, webhook URL, categories) then asks for **Client ID**, **Client secret** and **Webhook signing secret** (asked again as long as the answer is empty and none is stored), recorded in `secrets.json`. An empty answer keeps the stored value as long as the client ID is the same; a new client ID asks for its secrets. Details: [`linear.md`](linear.md).
5. Prints a proposed [`.factory/config.yml`](repository-configuration.md) from what it detects, and writes nothing in the repository (ORC-388): `setup` (npm's `npm ci`, pnpm's `pnpm install --frozen-lockfile`, uv's `uv sync --frozen`) and `commands` (Node: the `lint`, `typecheck`, `test` scripts in `package.json`, through pnpm when its lockfile is the only one; Python: `ruff`, `mypy` and pytest through uv when there are a `pyproject.toml` and a `uv.lock`, ORC-172; pytest is proposed as `test`, the red check's command, when Node proposes no `test`, and otherwise as `pytest`, with a warning that the red check runs `commands.test` only, ORC-420) and `preview`, what starts the application for the visual proof on `PORT` (the first of the `dev`, `start` and `preview` scripts in `package.json`, by the same package manager; none for Python, ORC-397), all in one proposal. A `package.json` that does not parse proposes nothing of Node. Nothing detected, or a `.factory/config.yml` already there, nothing proposed. Commit the file on the default branch: the factory reads it there. A `.factory/workflow.yml` found, or the one of the former name's directory, is said to be ignored. When the repository will have no `commands.test`, the red check's command (none proposed, as for a Node repository without a `test` script, or, when a `.factory/config.yml` is there, none in the one of the default branch, where the daemon reads it), it warns that every ticket would block at the tests step (ORC-412); a file git cannot read there or that does not parse is `factory validate`'s and `factory doctor`'s to name.
   With the proposal comes the **maturity report** (ORC-410), one card per point, printed with its state (`[to approve]`, or `[approved by <who>]`) and the dashboard page where a person approves them (`#maturity`, [interface](interface-and-security.md)): **Stack** (Node and its package manager, Python and uv, the front-end framework among the dependencies, Node's peer and optional ones included), **Commands** (`setup` and the checks proposed), **main green or red** (the project's last dry run on its default branch stored in the database, ORC-408: green, or red with what breaks and `factory dry-run <project>` to run it again, its commit and when it ended; « not checked yet » without one, which cannot be approved: `init` reads files, never runs the repository; each dry run on the default branch the daemon records then sets the card, and drops its approval when the value changes, ORC-437), **Services** (a Postgres in a compose file, its image by name whatever its registry, owner or tag, the official one or a variant such as `pgvector` or `postgis`; or its driver among the dependencies: an ORM alone is not one), **Visual paths** (the directories a front end renders from, the `visual_paths` to approve), **Areas without tests** (source directories without a test file, directories of tests such as `__tests__` or `e2e` left out; without a source directory, the files of code `src/` or the root holds itself; the walk stops past a bound on a large repository, and says so). The cards are stored in the instance's database (`maturity_cards` table, migration `0017_maturity_cards` on Postgres, brought up to date first), and `init` says which: `Cards stored in Postgres (FACTORY_DATABASE_URL).`, or SQLite with its path and a note that a daemon started with `FACTORY_DATABASE_URL` reads Postgres and does not see them (ORC-437). Running `init` again replaces them, and a card keeps its approval only when its value is unchanged. A database `init` cannot reach leaves the cards printed and not stored, and says so. With a `.factory/config.yml` already there, no report: the stored cards are left as they are. A repository where nothing is detected still gets its report, each card saying what was not found.
6. Writes `config.yaml`, then prints how to create and install the factory's **GitHub App** by hand (its repository permissions, those of [`github-app-manifest.json`](github-app-manifest.json); its webhook `<publicUrl>/webhooks/github`, optional, with a `publicUrl`, disabled without one), ORC-411, on a first setup only (no Linear values yet, no `factory.yml`).
7. On that first setup, writes `FACTORY_HOME/factory.yml`: `github` (`app_id: env:GH_APP_ID`, `private_key: env:GH_APP_KEY`; never `webhook_secret`, which an enabled App webhook adds by hand), `claude` (one account, `main`, `token: env:CLAUDE_CODE_OAUTH_TOKEN`, and `active: main`) and the budgets of a first run, which `factory validate` accepts; every secret a reference, never a value, and the variables to export are printed. An existing `factory.yml` is kept as it is, and an instance that runs without one gets none. When `config.yaml` already has a `github` App, it prints no App steps and writes no `github` in `factory.yml`, whose App would replace it.
8. Prints the next steps: `factory up`, « Connect Linear », delegate a ticket.

`factory init` can be rerun: for a second repository (new project), or to change the Linear credentials. An empty answer keeps what is stored (ORC-83, ORC-411): the team key, the client ID, secret and webhook secret, and Linear's OAuth tokens while the client ID stays the same; `factory.yml` is never rewritten. It no longer writes `.factory/workflow.yml`: the workflow is the `factory/default` preset, and a repository's `.factory/workflow.yml` is ignored (`factory doctor` says so, and the daemon logs it at each start).

### `factory up`

Starts the daemon in the foreground: HTTP server (UI, API, webhooks, OAuth), the smee relay when `config.yaml` has one (`factory init --dev`, a workstation; refused with `dev: false` or with `dev: true` beside a `publicUrl`, warned without `dev: true`, the development mode, ORC-444, ORC-446), timers, Linear and GitHub reconciliation every 5 minutes through a database timer, queue re-evaluation every minute. Prints `Orchestrator is running: <url>`.

- Writes `<FACTORY_HOME>/run-settings.json` (see [`configuration.md`](configuration.md#what-does-not-leave-the-daemon)).
- Resumes whatever a previous shutdown or crash cut off, without human intervention: reattaches to the containers still alive, relaunches the other steps (see [`operations.md`](operations.md#shutdown-restart-and-interrupted-runs)).
- If Linear is not connected, logs `Linear not connected: open <url>/oauth/start`.
- If the webhook secret is missing from `secrets.json`, logs a warning: all webhooks will be refused (401) until it is filled in.
- Refuses to start if `host` is not loopback without the dashboard's GitHub sign-in: the App's OAuth client, `dashboard` in `factory.yml`, an `https://` `publicUrl` (ORC-399).
- Refuses to start without `FACTORY_CONTAINER_CLI` (the agents would run on the host), unless `FACTORY_ALLOW_HOST_RUNS=1` chooses it, for development (ORC-349). `--fake-runner` launches no agent and needs neither.

`Ctrl+C` (SIGINT) or SIGTERM: clean shutdown (runs in progress are left running, then reattached on the next start, or started again if they vanished meanwhile, ORC-344).

`--fake-runner`: replaces Claude Code with a simulated runner that answers « Done. » at no cost. For testing the UI and the Linear wiring.

### `factory validate [repo]`

Checks the repository's `.factory/config.yml` (the current repository by default) against the baseline: a configuration adds checks or prohibitions, it never removes any. Exits 1 with one line per violation (unknown key, negative pattern, widened `max_diff`, `full` network). See [repository configuration](repository-configuration.md) (ORC-209).

It then shows the tools of each agent step (ORC-383): `Tools of each agent step of factory/default:`, then `- <step>: <tools>`, as the launch hands them out: those of `factory.yml` (`tools.per_step`) or the preset's, kept to the repository's list, without `WebFetch` for a repository at network `none`. A `factory.yml` that gives a step a tool it may not have is refused (`factory.yml refused:`), as the daemon refuses it at startup; a tool the repository names that `factory.yml` does not give the step is a warning, ignored by the launch.

Last, it computes the worst case of the `factory/default` preset (ORC-216) with the `budgets` of `factory.yml` (in `FACTORY_HOME`) and the repository's `budgets.per_ticket_tokens`, which only lowers the ticket's cap: every way back taken as often as its counter allows, where it costs the most, Σ attempts × `per_step_tokens` over the agent steps (and the same in turns, with each step's `maxTurns` lowered by `max_turns`). It refuses (`Budgets of factory/default refused:`) a worst case over `per_ticket_tokens`, and refuses while a cap is still unset (`per_step_tokens` of an agent step, or `per_ticket_tokens`) rather than passing. Accepted, it prints `Worst case of factory/default: <tokens> tokens and <turns> turns per ticket, within budgets.per_ticket_tokens <cap>.` and exits 0. An invalid `factory.yml` is refused too.

A control `factory.yml` disables (ORC-381) is named right after the repository's file, before the tools: `Disabled in factory.yml: max_diff, budgets.per_step_tokens, budgets.per_ticket_tokens.` (those that are `off`). A cap `off` is not refused as unset. With `per_ticket_tokens: off` and no cap of the repository's, the last line ends with `under no ticket cap.`; with `per_step_tokens: off`, it is `No worst case of factory/default in tokens: budgets.per_step_tokens is disabled.`

### `factory doctor [repo]`

Check before entrusting a repository, run where the daemon runs (`docker compose exec factoryd …` under compose, [`github.md`](github.md#factory-doctor-host-branch-protection-ci-secrets-and-factory-branches)): refuses (exit code `1`) a host whose engine (`FACTORY_CONTAINER_CLI`, asked with `info`) cannot limit the sandbox (no cgroup v2, or no limit through the `cpu`, `memory` or `pids` controller of a `FACTORY_SANDBOX_*` limit set: one at `none` does not require its own, ORC-451) or that `factory up` would refuse, with its message (ORC-449: a `FACTORY_CONTAINER_CLI` neither `docker` nor `podman`, not asked, or no `FACTORY_RUNNER_IMAGE`; ORC-450: a `FACTORY_SANDBOX_PIDS`, `FACTORY_SANDBOX_MEMORY` or `FACTORY_SANDBOX_CPUS` malformed, a `FACTORY_SANDBOX_MEMORY` under `6m` (ORC-452), or a daemon without a uid or gid; each said beside the engine's answer), a default branch with neither a classic protection nor a ruleset requiring a pull request that the App cannot bypass ([branch protection](github.md#branch-protection-required-by-factory-doctor)), and a CI that can expose secrets to the factory's branches (the repository's naming, `feat/*` and `fix/*` by default, and the legacy `factory/*`) without human approval, and accepts (code `0`) a CI without secrets or whose jobs with secrets are each under a protected environment with required reviewers (the only approval it credits, ORC-283).

- Reads `.github/workflows`, `GET /repos/{owner}/{repo}/environments` and the default branch's protection with the GitHub App.
- Resolves `owner/name` through `git remote get-url origin`; current repository by default.
- `--json`: machine report (`host`, `branchProtection`, workflows with their triggers, secrets yes/no, environments and verdict; `accepted` false on any refusal). A refusal before the checks (the configuration below, no GitHub App) stays JSON too, with `accepted: false` and the message under `error` (ORC-449).
- Never prints a secret; when in doubt (ambiguous YAML, dynamic `on`, indirect secrets, API error), refuses.
- Warns about a `.factory/workflow.yml` (or the one of the former name's directory) in the repository's working copy: ignored since the workflow is the `factory/default` preset, to delete (ORC-388). It looks only at their presence, never reads them, and the verdict does not change; `--json` lists them under `ignored`.
- Warns when the project of the repository checked has a spec gate no validator can pass (ORC-421): `authz.validators` empty in `config.yaml`, every ticket stops at the gate, as its initiator cannot approve; a lone validator, the tickets they delegate themselves. `factory/fantome` projects approve their own specs. Said before the workflows, also by the daemon at its start; the verdict does not change; `--json` has the lines under `validatorWarnings`.
- Refuses (exit code `1`) every configuration `factory up` refuses to start on, with its message, by the same checks (ORC-448): an invalid `config.yaml` or `factory.yml`, a GitHub App secret its source cannot read, half the App or its OAuth client, off the loopback the GitHub sign-in (the OAuth client, `dashboard`, an HTTPS `publicUrl`) and `secrets_key`, a `relay: { kind: smee }` with `dev: false` or with `dev: true` beside a `publicUrl` (ORC-446), a step setting or a status of no step of `factory/default`, a Claude token a header cannot carry. It reads no server secret but the App's: a `secrets_key` or a Claude token of a sealed source is not read, only its presence counts. The daemon's own environment is the host check's (above): it refuses an unknown `FACTORY_CONTAINER_CLI` and a missing `FACTORY_RUNNER_IMAGE` (ORC-449), an invalid `FACTORY_SANDBOX_*` limit and a missing uid/gid (ORC-450) with the start's message, and refuses no engine at all even with `FACTORY_ALLOW_HOST_RUNS=1`, which the start accepts for development. A smee relay without `dev: true`, the development mode `factory init --dev` writes, is a warning, said before the workflows, that does not change the verdict; `--json` has it under `relayWarnings`.
- Warns when the `.factory/config.yml` of the default branch has no `commands.test` (ORC-412): the red check of the tests step has no command to run, and every ticket blocks there. The verdict does not change; `--json` has the line under `warnings`.
- Says first whether this instance can take the visual proof (ORC-404): `available` with the capture image of `FACTORY_BROWSER_IMAGE` and its Playwright version, or `unavailable` and why (no sandboxes, the variable unset, the image absent from the engine or the engine not answering, an image without the label of `docker/browser.Dockerfile`, or one not built on `FACTORY_RUNNER_IMAGE`). Of the instance, not the repository: the verdict does not change; `--json` has it under `visualProof` (`available`, `detail`), a failed check included.

Full rule, examples and limits: [`github.md`](github.md).

### `factory plan`

Starts nothing. For each project, lists the tickets delegated to the agent in Linear, sorted by priority:

```text
REL-12  taken  Add the CSV export
REL-15  clarify  Fix the login — intake, then clarify asks to complete the ticket: The description is shorter than 30 characters.
REL-9  already handled  Menu redesign (human_review)
```

- `taken`: would pass the `tracker.pickup.checks` checks; at the Rapide level, a failed check follows as `assumed`, written in the spec;
- `clarify`: fails a check: the delegation starts at `intake`, then `clarify` asks to complete the ticket, for the reasons that follow (ORC-423);
- `not taken`: followed by the reasons: repository to specify, invalid `.factory/config.yml`, or a failed check when the chain does not start at `intake` (its launch refuses the ticket);
- `already handled`: already tracked by the factory (with its logical state).

Requires Linear to be connected (`Linear not connected: run `factory up`, then connect Linear.` otherwise).

### `factory status`

```text
Linear: connected · queue: active (0 waiting) · dev slots 1/3
  REL-12  dev  Add the CSV export
    run 7f3a…: dev, for 12 min, 0.80 $
  REL-15  todo (blocked)  Fix the login
    Stopped on request
```

For each ticket: its state, a check in progress, the reason for a block, and its runs in progress with what they are executing. `, lease expired` follows a run the heartbeat no longer holds (ORC-220). Daemon unreachable, silent past 1 min (ORC-434), or asking for a GitHub sign-in: says so, exit code 1.

### `factory pause` / `factory resume`

`pause`: no more runs start; requests accumulate in the queue. Runs in progress continue. The pause state is kept in the database (`factory.db`, or Postgres with `FACTORY_DATABASE_URL`) and survives a restart. `resume` restarts the queue. Equivalent to the UI's « Pause / Resume » button.

### `factory stop <ID>`

Stops the run of ticket `<ID>` (e.g. `REL-12`): SIGINT to the Claude Code process, then SIGKILL after 10 s, and the container is destroyed; a run the daemon reattached to after a restart stops the same way. The ticket is blocked until a reply in the Linear ticket (comment or session). Equivalent to the UI's « Stop » button, to the Linear session's "stop" and to `/stop`. Without options: an unknown ticket is refused, exit code 1.

### `factory dry-run <project>` (ORC-409)

Asks the daemon to run the [dry run](dry-run.md) of project `<project>` (its `id` in `config.yaml`) on the forge's default branch:
its `setup`, then its build and test commands, in the sandbox, as `verify` runs them for a ticket. The daemon records it, then the
command prints it, which takes as long as the setup and the tests:

```
Dry run of app on 3f2a9c1b7d4e: red (npm run build · npm test).
  dependency, setup `npm ci`: a dependency is missing, or younger than the 7 days the setup allows: No matching version found for left-pad@9.9.9
    | npm error code ETARGET
    | npm error notarget No matching version found for left-pad@9.9.9.
The tickets of app are refused while its dry run is red: fix what breaks, then run this again. A ticket it refused starts on a reply once it is green.
```

Exit code 0 when green, 1 when red or when no dry run could run: no sandboxes (`FACTORY_CONTAINER_CLI` and
`FACTORY_RUNNER_IMAGE`), the container engine, the forge or a registry not answering (`No dry run recorded (409): …`). A dry run of
the project already under way, started by a delegated ticket, is waited for; then the command runs a new one, which reads what
changed meanwhile.

Run it before a project's first ticket, to see it green; and after fixing a cause outside the repository that the fingerprint does
not see (a variable's value in `factory.yml`, a registry, a test put on the known flaky list): the delegated tickets then read the
new result. The command waits for the answer as long as the dry run lasts, through the socket or over HTTP, up to 2 h (ORC-434):
past that, it gives up and says so, and the daemon may still record the dry run it started.

### `factory replay <journal.json | directory>...` (ORC-174)

Replays exported ticket journals, without an instance or network: each journal line goes through the upcasters (`schemaVersion`, and timers recorded before ORC-161 through `upcastTimer`), then its decision is redone (`decide`, then `reduce`) from what the decision transaction recorded (projection read under the lock, workflow version, clock). A directory is read in full (`*.json`, in name order).

- **Regression** (default): the projection, the effects, the timers and the timer reset must come out **bit for bit** as recorded (canonical JSON, sorted keys). Each divergence is listed with the event that carries it. Exit code 0 without divergence, 1 if a journal diverges, 2 on an unknown option, an unreadable journal or one impossible to replay (missing workflow version) or a journal without any decision; the other journals in the directory are replayed anyway.
- **What-if** (`--what-if <preset>`): the decisions run on the workflow of a preset compiled in the binary, `factory/default` or `factory/fantome` (ORC-389; a workflow file is refused, exit code 2), instead of the versions the tickets were pinned to. The replay stops at the first divergence and reports it:

```
test/replay/journals/check-failed-then-feedback.json: p/REL-1: 4 decision(s) replayed — stopped at the first divergence
  event check:id-1 (verify.failed, #4 of the journal): ticket.blockReason recorded absent, replayed "Checks still failing after 1 attempts."
  event check:id-1 (verify.failed, #4 of the journal): effects[0].kind recorded "start_run", replayed "activity"
1 journal(s) of 1 diverge, 0 in error or without decisions.
```

`factory replay --export <ID> [--project <id>] [--out <file>]` writes the journal of one of the instance's tickets (store from `FACTORY_DATABASE_URL`, otherwise `factory.db`, opened without migration), with the workflow versions of its decisions. `--project` is required when the instance has several projects. A ticket without a logged event, or an instance without a database, is refused rather than exported empty. The format and CI setup: [`tests.md`](tests.md#the-replay-oracle).
### `factory run repair <ID> [replay|skip|force] [<event>]`

Repairs an event whose decision failed, or which exhausted its retries, and which the daemon set aside (`dead_letter` table) while blocking ticket `<ID>`. Without an action, lists the ticket's set-aside events (open and already repaired); with an action, repairs the only open one, or the one given as the last argument:

```text
$ factory run repair REL-12
Events set aside for REL-12:
  l1  label.changed  open  (1 failure) rule.when.every is not a function
$ factory run repair REL-12 replay
Event l1 (label.changed) replayed by armand: repair journaled, decided at the next pass of the daemon.
```

- `replay`: decide the event again, after a fix;
- `skip`: ignore it (refused for a run or verification result: use `force`);
- `force`: record its facts without its decision (no effect).

The ticket is unblocked and the repair logged (`dead_letter.repaired` event, with the user's name). The command writes to the instance's database (SQLite, or Postgres with `FACTORY_DATABASE_URL`): the daemon does not need to be running, it decides the repair on its next pass. An event without a ticket is designated by its id in place of `<ID>`. Details: [`operations.md`](operations.md#dead-letter-and-factory-run-repair-orc-175).

### `factory flaky <project>` (ORC-164)

The repository's known flaky tests, which `verify` marks indicative: failing, they do not count, and the agent is not sent back for them ([`preset.md`](preset.md#the-workflow-the-engine-runs-orc-389)). A test is named as `verify` names it: `<file> > <full name>` for vitest and jest, its node id for pytest, as the journal's `flaky` field shows them.

```text
$ factory flaky p add 'src/cart.test.ts > cart total' --reason 'times out under load'
src/cart.test.ts > cart total is now a known flaky test of p: failing, it is indicative.
$ factory flaky p
Known flaky tests of p:
  src/cart.test.ts > cart total  (armand: times out under load)
$ factory flaky p remove 'src/cart.test.ts > cart total'
```

`--frozen` also covers the test while it is frozen for a ticket (ORC-131): without it, a frozen test always counts. Each entry keeps who added it (the user's name), why and when. Like `run repair`, the command writes to the instance's database, without the daemon.

### `factory baseline <project>` (ORC-230)

The state of reference the Overview compares the factory with ([`interface-and-security.md`](interface-and-security.md)): what the team delivered without it over the 90 days before `--since`, the factory's start (the day given, UTC midnight, left out). Read from the project's Linear team and its GitHub repository, with the daemon's credentials (Linear's saved tokens; the GitHub App, without which nothing is read on GitHub, ORC-181), then frozen in the store, one row per measure with its period:

- **Delivered**: the team's issues completed in the period that have a PR merged in it, linked by Linear (the PR attached to the issue) or naming the issue in its branch or title.
- **Median lead time**: from the issue's start (its first started state, In Progress) to its first merged PR; an issue never started is left out, and counted.
- **Ready at the first try**: the share of the delivered issues' merged PRs that no review asked changes of.
- **Tokens per merged ticket**: no source: human work spends none the factory can read. Stored without a value, shown as `no source`, never invented.

```text
$ factory baseline p --since 2026-11-01
Baseline of p over 2026-08-03 → 2026-11-01 (90 days), from Linear ORC and GitHub:
  Delivered: 12 (of 20 issues completed)
  Median lead time: 3.1 days (over 10 delivered issues, 2 without a start)
  Tokens per merged ticket: no source (human work)
  Ready at the first try: 75% (of 15 merged PRs)
Stored.
```

The same period again is refused, the stored rows kept and no figure printed, unless `--replace`: a baseline is what the factory is measured against, never recomputed by accident. A start still to come is refused before anything is read. Linear's archived issues are read too: a team archives closed issues after its own delay, which the period may be past. The Overview shows the baseline computed last. A list Linear or GitHub cannot give to its end (GitHub's search stops at 1000 PRs) stops the command, never a baseline read in part. Like `flaky`, the command writes to the instance's database, without the daemon.

### `factory ghost` (ORC-231)

The replay of closed tickets: `start <project> --threshold <share> --as-is <share> --tickets <ID>=<PR>,...` writes the replay and
its two thresholds, shares of the compared tickets: the factory's PRs to be mergeable, and those to be mergeable as is (both required, never
changed after, ORC-385) and rebuilds each ticket at the parent of its PR's merge commit, for a project on the
`factory/fantome` preset; the daemon then delegates each ticket to that project itself (ORC-376). It is refused when the daemon
runs its agents on the host (no sandboxes), or has never started: the agent could push by itself. `collect`, `judge` (the blind screen, PR A and PR B on the grid mergeable as is / after edits / to reject) and `report` follow. See
[the replay of closed tickets](ghost-replay.md). Like `flaky`, the command writes to the instance's database, without the daemon.

## Development scripts

See [Contributing](../README.md#contributing).
