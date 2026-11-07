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
5. If no knowledge base is configured, offers to create a private GitHub repository `relais-knowledge` (`gh repo create`). See [`projets-et-workspaces.md`](projets-et-workspaces.md#shared-knowledge-base).
6. If `.relais/workflow.yml` does not exist, creates it: asks for the verification commands (suggested from the `lint`, `typecheck`, `test` scripts in `package.json`, separated by `;`) and sets `workspace.setup: ["npm ci"]` if the repository has a `package-lock.json`. Exact contents: [`workflow.md`](workflow.md#1-role-of-the-file-and-merging-with-the-pack).
7. Writes `config.yaml` and prints the next steps: `relais up`, « Connecter Linear », delegate a ticket.

`relais init` can be rerun: for a second repository (new project), or to change the Linear credentials. It never rewrites an existing `.relais/workflow.yml`. Remember to commit `.relais/workflow.yml` to the repository.

### `relais up`

Starts the daemon in the foreground: HTTP server (UI, API, webhooks, OAuth), smee relay, timers, Linear and GitHub reconciliation every 5 minutes through a database timer (PR polling every 30 s if GitHub webhooks are refused), queue re-evaluation every minute. Prints `Relais tourne : <url>`.

- Writes `<RELAIS_HOME>/run-settings.json` (see [`configuration.md`](configuration.md#what-does-not-leave-the-daemon)).
- Resumes whatever a previous shutdown or crash cut off, without human intervention: reattaches to the containers still alive, relaunches the other steps (see [`exploitation.md`](exploitation.md#shutdown-restart-and-interrupted-runs)).
- If Linear is not connected, logs `Linear non connecté : ouvrez <url>/oauth/start`.
- If the webhook secret is missing from `secrets.json`, logs a warning: all webhooks will be refused (401) until it is filled in.
- Refuses to start if `host` is not loopback and `RELAIS_UI_PASSWORD` is empty.

`Ctrl+C` (SIGINT) or SIGTERM: clean shutdown (runs in progress are interrupted, then taken back on the next start).

`--fake-runner`: replaces Claude Code with a simulated runner that answers « Terminé. » at no cost. For testing the UI and the Linear wiring.

### `factory validate [repo]`

Checks the repository's `.factory/config.yml` (the current repository by default) against the baseline: a configuration adds checks or prohibitions, it never removes any. Exits 1 with one line per violation (unknown key, negative pattern, widened `max_diff`, `full` network), 0 otherwise or without a file. Does not need an instance. See [repository configuration](configuration-depot.md) (ORC-209).

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
REL-12  pris  Ajouter l'export CSV
REL-15  pas pris  Corriger le login — La description fait moins de 30 caractères.
REL-9  déjà géré  Refonte du menu (human_review)
```

- `pris`: would pass the `tracker.pickup.checks` checks;
- `pas pris`: followed by the reasons;
- `déjà géré`: already tracked by Relais (with its logical state).

Requires Linear to be connected (`Linear non connecté : lancez relais up puis connectez Linear.` otherwise).

### `factory status`

```text
Linear : connecté · file : active (0 en attente) · places dev 1/3 · coût du jour 2.40 $
  REL-12  dev  Ajouter l'export CSV
    run 7f3a… : dev, depuis 12 min, 0.80 $
  REL-15  todo (bloqué)  Corriger le login
    Arrêté à la demande
```

For each ticket: its state, a check in progress, the reason for a block, and its runs in progress with what they are executing. `, bail expiré` follows a run the heartbeat no longer holds (ORC-220). Daemon unreachable or password missing: says so, exit code 1.

### `relais pause` / `relais resume`

`pause`: no more runs start; requests accumulate in the queue. Runs in progress continue. The pause state is kept in `relais.db` and survives a restart. `resume` restarts the queue. Equivalent to the UI's « Pause / Reprendre » button.

### `factory stop <ID>`

Stops the run of ticket `<ID>` (e.g. `REL-12`): SIGINT to the Claude Code process, then SIGKILL after 10 s, and the container is destroyed; a run the daemon reattached to after a restart stops the same way. The ticket is blocked until a reply in the Linear ticket (comment or session). Equivalent to the UI's « Stop » button, to the Linear session's "stop" and to the `agent:stop` label. Without options: an unknown ticket is refused, exit code 1.

### `factory replay <journal.json | directory>...` (ORC-174)

Replays exported ticket journals, without an instance or network: each journal line goes through the upcasters (`schemaVersion`, and timers recorded before ORC-161 through `upcastTimer`), then its decision is redone (`decide`, then `reduce`) from what the decision transaction recorded (projection read under the lock, workflow version, clock). A directory is read in full (`*.json`, in name order).

- **Regression** (default): the projection, the effects, the timers and the timer reset must come out **bit for bit** as recorded (canonical JSON, sorted keys). Each divergence is listed with the event that carries it. Exit code 0 without divergence, 1 if a journal diverges, 2 on an unknown option, an unreadable journal or one impossible to replay (missing workflow version) or a journal without any decision; the other journals in the directory are replayed anyway.
- **What-if** (`--what-if <workflow.yml>`): the decisions run on this workflow, laid over the standard pack (`--pack <directory>` for another), instead of the versions the tickets were pinned to. The replay stops at the first divergence and reports it:

```
test/replay/journals/check-failed-then-feedback.json : p/REL-1 : 4 décision(s) rejouée(s) — arrêt à la première divergence
  événement check:id-1 (verify.failed, n° 4 du journal) : ticket.blockReason enregistré absent, rejoué "Vérifications toujours en échec après 1 tentatives."
  événement check:id-1 (verify.failed, n° 4 du journal) : effects[0].kind enregistré "start_run", rejoué "activity"
1 journal(aux) sur 1 divergent.
```

`factory replay --export <ID> [--project <id>] [--out <file>]` writes the journal of one of the instance's tickets (store from `FACTORY_DATABASE_URL`, otherwise `factory.db`, opened without migration), with the workflow versions of its decisions. `--project` is required when the instance has several projects. A ticket without a logged event, or an instance without a database, is refused rather than exported empty. The format and CI setup: [`tests.md`](tests.md#the-replay-oracle).
### `factory run repair <ID> [replay|skip|force] [<event>]`

Repairs an event whose decision failed, or which exhausted its retries, and which the daemon set aside (`dead_letter` table) while blocking ticket `<ID>`. Without an action, lists the ticket's set-aside events (open and already repaired); with an action, repairs the only open one, or the one given as the last argument:

```text
$ factory run repair REL-12
Événements mis de côté pour REL-12 :
  l1  label.changed  ouvert  (1 échec) rule.when.every is not a function
$ factory run repair REL-12 replay
Événement l1 (label.changed) rejoué par armand : réparation journalisée, décidée au prochain passage du démon.
```

- `replay`: decide the event again, after a fix;
- `skip`: ignore it (refused for a run or verification result: use `force`);
- `force`: record its facts without its decision (no effect).

The ticket is unblocked and the repair logged (`dead_letter.repaired` event, with the user's name). The command writes to the instance's database (SQLite, or Postgres with `FACTORY_DATABASE_URL`): the daemon does not need to be running, it decides the repair on its next pass. An event without a ticket is designated by its id in place of `<ID>`. Details: [`exploitation.md`](exploitation.md#dead-letter-and-factory-run-repair-orc-175).

## `relais-agent` (agent side)

During a run, Relais adds Relais's `bin/` to the `PATH` and sets `RELAIS_API` and `RELAIS_RUN_TOKEN`. The agent then uses:

| Command | Effect |
|---|---|
| `relais-agent issue <ID>` | Prints the ticket: identifier, title, status, URL, description. **Limited to the run's ticket** (403 otherwise). |
| `relais-agent search <text>` | Searches Linear tickets. |
| `relais-agent kb search <words>` | Searches `notes/*.md` in the knowledge base (words of 3 letters or more, ignoring accents and case). Prints `file:line: text`. |
| `relais-agent ask <question>` | Posts the question in the ticket's block comment (ORC-196) and **blocks** the ticket. The agent must end its turn; the human reply restarts the work. |

Launched outside a run, it answers `relais-agent doit être lancé par Relais (RELAIS_API et RELAIS_RUN_TOKEN manquants).` (code 2). The token is only accepted while the run is in progress. The pack allows `Bash(relais-agent:*)` and the startup hook reminds the agent of these commands ([`pack-et-skills.md`](pack-et-skills.md)).

## Development scripts

See [Contributing](../README.md#contributing).
