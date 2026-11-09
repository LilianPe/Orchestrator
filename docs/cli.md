# Command line

Relais provides two executables (installed by `npm link`, see [`installation.md`](installation.md)):

- **`relais`**: for you, the operator;
- **`relais-agent`**: for the agents, during a run. You do not call it yourself.

All `relais` commands read `RELAIS_HOME` (default `~/.relais`) and `config.yaml`. An unknown or incomplete command prints the help and exits with code 1.

## `relais`

| Command | Role | Daemon required |
|---|---|---|
| `relais init` | Configure Relais for the current repository. | no |
| `factory doctor [repo]` | Refuse a repository whose CI can expose secrets to the factory's branches. | no (GitHub App) |
| `relais up [--fake-runner]` | Start the daemon. | — |
| `relais plan` | List the delegated tickets and say which ones would be picked up. | no (Linear connected) |
| `factory status` | State of the running instance: tickets, blocks, runs. | yes |
| `relais pause` / `relais resume` | Suspend / resume the queue. | yes |
| `factory stop <ID>` | Stop a ticket's run. | yes |
| `factory run repair <ID> [replay\|skip\|force] [<event>]` | List or repair a ticket's set-aside (dead-letter) events. | no (reads and writes the database) |

The commands that require the daemon call `http://127.0.0.1:<port>/api/…` with the `port` from `config.yaml`. If `RELAIS_UI_PASSWORD` is set in your shell, they send it as HTTP Basic (necessary when the daemon listens beyond loopback). In Docker, run them in the container: `docker compose exec factoryd node dist/src/cli/factory.js status`.

### `relais init`

Run it **in the repository** to entrust to Relais (otherwise it asks for the repository path). Interactive wizard:

1. Asks for the **Linear team key** (e.g. `REL`), uppercased.
2. Adds (or replaces) the project in `config.yaml`: `id` = name of the repository directory (slug, 30 characters max), `repoPath` = git root, `linearTeamKey`.
3. Without `publicUrl` or a configured relay, creates a **smee.io channel** and records it in `relay`.
4. Prints the exact values to enter in Linear (callback URL, webhook URL, categories) then asks for **Client ID**, **Client secret** and **Webhook signing secret** (asked again as long as the answer is empty), recorded in `secrets.json`. Details: [`linear.md`](linear.md).
5. If `.relais/workflow.yml` does not exist, creates it: asks for the verification commands, separated by `;`, suggested from what it detects (Node: the `lint`, `typecheck`, `test` scripts in `package.json`, through pnpm when its lockfile is the only one; Python: uv's commands when there are a `pyproject.toml` and a `uv.lock`, ORC-172), and sets `workspace.setup` and the red check's test command to match. Exact contents: [`workflow.md`](workflow.md#1-role-of-the-file-and-merging-with-the-pack).
6. Writes `config.yaml` and prints the next steps: `relais up`, « Connect Linear », delegate a ticket.

`relais init` can be rerun: for a second repository (new project), or to change the Linear credentials. It never rewrites an existing `.relais/workflow.yml`. Remember to commit `.relais/workflow.yml` to the repository.

### `relais up`

Starts the daemon in the foreground: HTTP server (UI, API, webhooks, OAuth), smee relay, timers, Linear and GitHub reconciliation every 5 minutes through a database timer (PR polling every 30 s if GitHub webhooks are refused), queue re-evaluation every minute. Prints `Relais is running: <url>`.

- Writes `<RELAIS_HOME>/run-settings.json` (see [`configuration.md`](configuration.md#what-does-not-leave-the-daemon)).
- Resumes whatever a previous shutdown or crash cut off, without human intervention: reattaches to the containers still alive, relaunches the other steps (see [`operations.md`](operations.md#shutdown-restart-and-interrupted-runs)).
- If Linear is not connected, logs `Linear not connected: open <url>/oauth/start`.
- If the webhook secret is missing from `secrets.json`, logs a warning: all webhooks will be refused (401) until it is filled in.
- Refuses to start if `host` is not loopback and `RELAIS_UI_PASSWORD` is empty.
- Refuses to start without `FACTORY_CONTAINER_CLI` (the agents would run on the host), unless `FACTORY_ALLOW_HOST_RUNS=1` chooses it, for development (ORC-349). `--fake-runner` launches no agent and needs neither.

`Ctrl+C` (SIGINT) or SIGTERM: clean shutdown (runs in progress are left running, then reattached on the next start, or started again if they vanished meanwhile, ORC-344).

`--fake-runner`: replaces Claude Code with a simulated runner that answers « Done. » at no cost. For testing the UI and the Linear wiring.

### `factory validate [repo]`

Checks the repository's `.factory/config.yml` (the current repository by default) against the baseline: a configuration adds checks or prohibitions, it never removes any. Exits 1 with one line per violation (unknown key, negative pattern, widened `max_diff`, `full` network). See [repository configuration](repository-configuration.md) (ORC-209).

It then computes the worst case of the `factory/default` preset (ORC-216) with the `budgets` of `factory.yml` (in `FACTORY_HOME`) and the repository's `budgets.per_ticket_tokens`, which only lowers the ticket's cap: every way back taken as often as its counter allows, where it costs the most, Σ attempts × `per_step_tokens` over the agent steps (and the same in turns, with each step's `maxTurns` lowered by `max_turns`). It refuses (`Budgets of factory/default refused:`) a worst case over `per_ticket_tokens`, and refuses while a cap is still unset (`per_step_tokens` of an agent step, or `per_ticket_tokens`) rather than passing. Accepted, it prints `Worst case of factory/default: <tokens> tokens and <turns> turns per ticket, within budgets.per_ticket_tokens <cap>.` and exits 0. An invalid `factory.yml` is refused too.

### `factory doctor [repo]`

Check before entrusting a repository: refuses (exit code `1`) a CI that can expose secrets to a `factory/*` branch without human approval, and accepts (code `0`) a CI without secrets or whose jobs with secrets are under a protected environment with required reviewers.

- Reads `.github/workflows` and `GET /repos/{owner}/{repo}/environments` with the GitHub App: no `gh` fallback.
- Resolves `owner/name` through `git remote get-url origin`; current repository by default.
- `--json`: machine report (workflows, triggers, secrets yes/no, environments, verdict).
- Never prints a secret; when in doubt (ambiguous YAML, dynamic `on`, indirect secrets, API error), refuses.

Full rule, examples and limits: [`github.md`](github.md).

### `relais plan`

Starts nothing. For each project, lists the tickets delegated to the agent in Linear, sorted by priority:

```text
REL-12  taken  Add the CSV export
REL-15  not taken  Fix the login — The description is shorter than 30 characters.
REL-9  already handled  Menu redesign (human_review)
```

- `taken`: would pass the `tracker.pickup.checks` checks;
- `not taken`: followed by the reasons;
- `already handled`: already tracked by Relais (with its logical state).

Requires Linear to be connected (`Linear not connected: run `factory up`, then connect Linear.` otherwise).

### `factory status`

```text
Linear: connected · queue: active (0 waiting) · dev slots 1/3 · cost today 2.40 $
  REL-12  dev  Add the CSV export
    run 7f3a…: dev, for 12 min, 0.80 $
  REL-15  todo (blocked)  Fix the login
    Stopped on request
```

For each ticket: its state, a check in progress, the reason for a block, and its runs in progress with what they are executing. `, lease expired` follows a run the heartbeat no longer holds (ORC-220). Daemon unreachable or password missing: says so, exit code 1.

### `relais pause` / `relais resume`

`pause`: no more runs start; requests accumulate in the queue. Runs in progress continue. The pause state is kept in `relais.db` and survives a restart. `resume` restarts the queue. Equivalent to the UI's « Pause / Resume » button.

### `factory stop <ID>`

Stops the run of ticket `<ID>` (e.g. `REL-12`): SIGINT to the Claude Code process, then SIGKILL after 10 s, and the container is destroyed; a run the daemon reattached to after a restart stops the same way. The ticket is blocked until a reply in the Linear ticket (comment or session). Equivalent to the UI's « Stop » button, to the Linear session's "stop" and to the `agent:stop` label. Without options: an unknown ticket is refused, exit code 1.

### `factory replay <journal.json | directory>...` (ORC-174)

Replays exported ticket journals, without an instance or network: each journal line goes through the upcasters (`schemaVersion`, and timers recorded before ORC-161 through `upcastTimer`), then its decision is redone (`decide`, then `reduce`) from what the decision transaction recorded (projection read under the lock, workflow version, clock). A directory is read in full (`*.json`, in name order).

- **Regression** (default): the projection, the effects, the timers and the timer reset must come out **bit for bit** as recorded (canonical JSON, sorted keys). Each divergence is listed with the event that carries it. Exit code 0 without divergence, 1 if a journal diverges, 2 on an unknown option, an unreadable journal or one impossible to replay (missing workflow version) or a journal without any decision; the other journals in the directory are replayed anyway.
- **What-if** (`--what-if <workflow.yml>`): the decisions run on this workflow, laid over the standard pack (`--pack <directory>` for another), instead of the versions the tickets were pinned to. The replay stops at the first divergence and reports it:

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

The repository's known flaky tests, which `verify` marks indicative: failing, they do not count, and the agent is not sent back for them ([`workflow.md`](workflow.md)). A test is named as `verify` names it: `<file> > <full name>` for vitest and jest, its node id for pytest, as the journal's `flaky` field shows them.

```text
$ factory flaky p add 'src/cart.test.ts > cart total' --reason 'times out under load'
src/cart.test.ts > cart total is now a known flaky test of p: failing, it is indicative.
$ factory flaky p
Known flaky tests of p:
  src/cart.test.ts > cart total  (armand: times out under load)
$ factory flaky p remove 'src/cart.test.ts > cart total'
```

`--frozen` also covers the test while it is frozen for a ticket (ORC-131): without it, a frozen test always counts. Each entry keeps who added it (the user's name), why and when. Like `run repair`, the command writes to the instance's database, without the daemon.

## `relais-agent` (agent side)

During a run, Relais adds Relais's `bin/` to the `PATH` and sets `RELAIS_API` and `RELAIS_RUN_TOKEN`. The agent then uses:

| Command | Effect |
|---|---|
| `relais-agent issue <ID>` | Prints the ticket: identifier, title, status, URL, description. **Limited to the run's ticket** (403 otherwise). |
| `relais-agent search <text>` | Searches the Linear tickets of the current ticket's team (ORC-349). |
| `relais-agent kb search <words>` | Searches `notes/*.md` in the knowledge base (words of 3 letters or more, ignoring accents and case). Prints `file:line: text`. |
| `relais-agent ask <question>` | Posts the question in the ticket's block comment (ORC-196) and **blocks** the ticket. The agent must end its turn; the human reply restarts the work. |

Launched outside a run, it answers `relais-agent must be started by Relais (RELAIS_API and RELAIS_RUN_TOKEN missing).` (code 2). The token is only accepted while the run is in progress. The pack allows `Bash(relais-agent:*)` and the startup hook reminds the agent of these commands ([`pack-and-skills.md`](pack-and-skills.md)).

## Development scripts

See [Contributing](../README.md#contributing).
