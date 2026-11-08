# Daemon configuration

Relais is configured at three levels:

| Level | File | Scope | Doc |
|---|---|---|---|
| Instance | `<RELAIS_HOME>/config.yaml` | The daemon: port, host, projects, webhook relay, daily budget, knowledge base. | this page |
| Secrets | `<RELAIS_HOME>/secrets.json` | Linear credentials. | this page |
| Project | `.relais/workflow.yml` in each repository | Behavior: events, jobs, models, per-run limits, checks. | [`workflow.md`](workflow.md) |

The two instance files are read **at startup** of `relais up`: restart after a change.

## Environment variables

| Variable | Read by | Default | Effect | Secret |
|---|---|---|---|---|
| `RELAIS_HOME` | all `relais` commands | `$HOME/.relais` | Instance directory (see [`installation.md`](installation.md#the-daemons-home-directory)). | no |
| `RELAIS_UI_PASSWORD` | `relais up`, `relais status/pause/resume/stop` | — | HTTP Basic password for the UI and the API. **Required** as soon as `host` is not a loopback address: without it, `relais up` refuses to start. Ignored when `host` is loopback. See [`interface-and-security.md`](interface-and-security.md). | **yes** |
| `FACTORY_DATABASE_URL` | `relais up`, `relais plan` | — | Postgres connection string (`postgres://user:password@host:5432/database`). When set, the daemon keeps its state in Postgres (`PgStore`) and applies the Drizzle migrations from `drizzle/` at startup (`relais plan` reads it without migrating it); an unreachable database prevents startup, with no fallback to SQLite. Absent: SQLite database `relais.db`, until it is removed (ORC-178). Never passed to runs (`FACTORY_` prefix), never written to the daemon's log. | **yes** |
| `FACTORY_CONTAINER_CLI` | `relais up` | — | `docker` or `podman`. When set, each attempt runs in a disposable container (ORC-204): created when it launches, destroyed when it ends, and those a crash left behind are destroyed at the next startup. The repository's `setup` runs there too. Absent: `relais up` refuses to start, unless `FACTORY_ALLOW_HOST_RUNS=1` (ORC-349). No effect with `--fake-runner`. See [`interface-and-security.md`](interface-and-security.md#known-limitations). | no |
| `FACTORY_ALLOW_HOST_RUNS` | `relais up` | — | `1`: without `FACTORY_CONTAINER_CLI`, the agents run on the host, under the daemon's user, next to its secrets, and the daemon says so at startup. For development only. Otherwise, without a container engine, `relais up` refuses to start (ORC-349). No effect with `FACTORY_CONTAINER_CLI` or `--fake-runner`. See [`interface-and-security.md`](interface-and-security.md#known-limitations). | no |
| `FACTORY_ALLOW_HOST_VERIFY` | `relais up` | — | `1`: without a sandbox, `verify` and the red check run the agent's code on the host, next to the daemon's secrets. Otherwise, they refuse and the ticket is blocked. No effect with `FACTORY_CONTAINER_CLI`: a failed engine never falls back to the host. See [`interface-and-security.md`](interface-and-security.md#known-limitations). | no |
| `FACTORY_MESSAGE_MODEL` | `relais up` | — | `off`, `0`, `false` or `none` (any case): no small model classifies human messages, the `?` fallback rule does it alone (ORC-336). Any other value is logged as a warning and leaves the model on. See [`operations.md`](operations.md#the-small-model-of-messages). | no |
| `FACTORY_RUNNER_IMAGE` | `relais up` | — | Image of the run containers (`docker/runner.Dockerfile`: node and pnpm, python and uv, git, gitleaks, claude): without gitleaks, every `verify` is a failure (ORC-151). Required with `FACTORY_CONTAINER_CLI`. | no |
| `FACTORY_EGRESS_CONTROL` | `relais up` | — | Control socket of the `proxy` service (ORC-203). When set, the daemon drives that service instead of running the egress proxy in its own process. | no |
| `FACTORY_INSTALL_DIR` | `docker/entrypoint.sh` | — | Where to copy the installation, at a path the engine sees on the host; the daemon runs from that copy, one per image ([`deployment.md`](deployment.md#why-the-same-paths-on-both-sides)). | no |
| `FACTORY_ALLOW_ROOTFUL_ENGINE` | `docker/entrypoint.sh` | — | `1`: allows the daemon container to start on an engine that is not rootless. Development workstation only. | no |
| `FACTORY_COMMIT` | `relais up` | set when the image is built | The factory's commit, recorded on each attempt. | no |
| `FACTORY_AGENT_PORT` | `relais up` | UI port + 1 | Port of the server that only serves `/agent/*`, for containers. Started only with `FACTORY_CONTAINER_CLI`. | no |
| `FACTORY_AGENT_HOST` | `relais up` | `127.0.0.1` | Listen address of that server. Containers reach it through the daemon's egress proxy (ORC-213), not through the network: loopback is enough. Under compose, `0.0.0.0`: the `proxy` service reaches it over the internal network. | no |
| `FACTORY_SANDBOX_AGENT_HOST` | `relais up` | `host.docker.internal` | Name of the daemon in the runs' `RELAIS_API` (`http://<name>:<FACTORY_AGENT_PORT>/agent`). The container does not resolve it: the egress proxy recognizes this name and relays to the agent API server. | no |
| `FACTORY_SANDBOX_PIDS` | `relais up` | `512` | Maximum number of processes in a run container (`--pids-limit`): a fork bomb hits it without starving the other attempts (ORC-218). `0` or `none`: no limit. A value that is not a positive integer prevents startup. | no |
| `FACTORY_SANDBOX_MEMORY` | `relais up` | `4g` | Memory of a run container, with no swap beyond it (`--memory` and `--memory-swap`): a memory hog is killed by the OOM killer. Size in the engine's format (`512m`, `4g`). `0` or `none`: no limit. | no |
| `FACTORY_SANDBOX_CPUS` | `relais up` | `2`, or the host's CPU count if it has fewer | CPUs of a run container (`--cpus`, decimals accepted: `0.5`). `0` or `none`: no limit. | no |
| `FACTORY_REFUSALS_LOG` | `relais up` | `$CLAUDE_CONFIG_DIR/factory-refusals.jsonl` | File for the `PreToolUse` hook's refusal log; passed to runs on the host only if it is set. In a sandbox, ignored: each run writes to `<RELAIS_HOME>/runs/<runId>/refusals/refusals.jsonl` (ORC-217). See [`pack-and-skills.md`](pack-and-skills.md#pretooluse-hook-and-refusal-log). | no |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude`, in a sandbox and on the host | — | Claude Code account token when `factory.yml` does not choose one (`claude.active`). In a sandbox, the egress proxy sets it on the model calls, and the sandbox holds a placeholder (ORC-337). | **yes** |
| `ANTHROPIC_API_KEY` | `claude`, on the host only | — | Claude Code authentication on the host, without `claude login` or an active account. Never passed to a sandbox (ORC-211); removed along with host runs (ORC-179). | **yes** |
| `GH_TOKEN` | `gh` and, in Docker, git via `gh auth setup-git` | — | GitHub authentication for the daemon's `gh` fallback, and for its `git fetch`. Never passed to a run (ORC-125). Required in Docker until ORC-181. | **yes** |
| `GH_APP_ID` | daemon (fallback for `github.appId`) | — | Identifier of the factory's GitHub App. | no |
| `GH_APP_KEY` | daemon (fallback for `github.privateKey`) | — | PEM private key of the GitHub App, or path to the `.pem` file. | **yes** |
| `GH_APP_INSTALLATION_ID` | daemon (fallback for `github.installationId`) | — | App installation to use; optional, the daemon can find it per repository. | no |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | git (inherited by runs) | the machine's git identity; in Docker `Relais <relais@localhost>` | Identity of the agents' commits. | no |
| `PATH` | the daemon | — | Must contain `claude`, `gh`, `git`. Relais adds Relais's `bin/` to it for runs. | no |

Variables reserved for tests (no effect on the daemon): `LINEAR_API_KEY` (live test of the Linear queries), `FACTORY_E2E=1` (pack test with the real `claude`). See [`acceptance.md`](acceptance.md#optional-live-checks).

Variables **set by Relais** in each run's environment (do not set them yourself): `RELAIS_API`, `RELAIS_RUN_TOKEN`, `RELAIS_TICKET`, `RELAIS_KNOWLEDGE`, `RELAIS_ROOT`, `PATH`, `FACTORY_REFUSALS_LOG` when the daemon has it (in a sandbox, always, pointing to the run's directory), `FACTORY_READ_MAX_LINES` when `factory.yml` declares `read_guard.max_lines`, `FACTORY_FULL_READ_PATHS` when a file must be read in full and, for the `dev` queue, `PORT`. See ["What does not leave the daemon"](#what-does-not-leave-the-daemon). In a container, these paths are the container's: `RELAIS_ROOT=/factory/app` (Relais's `bin/` and what it needs, mounted read-only), `RELAIS_KNOWLEDGE=/factory/knowledge` (read-only), and a `PATH` specific to the container, never the host's.

## `config.yaml`

Written by `relais init`, editable by hand. Missing file = all default values. An invalid field prevents startup with `invalid config.yaml: <field>: <message>`.

| Key | Type | Default | Effect |
|---|---|---|---|
| `port` | integer > 0 | `4100` | HTTP server port (UI, API, webhooks, OAuth). Also the port the CLI queries (`http://127.0.0.1:<port>`). |
| `host` | text | `127.0.0.1` | Listen address. Any value other than loopback (`localhost`, `127.x.x.x`, `::1`) requires `RELAIS_UI_PASSWORD`. In Docker: `0.0.0.0`. |
| `publicUrl` | URL | — | Public URL of Relais (tunnel or domain). If set, it is used as the base for the OAuth callback URL (`<publicUrl>/oauth/callback`) and the webhook URL (`<publicUrl>/webhooks/linear`), and `relais init` does not create a smee channel. Without it: `http://localhost:<port>`. |
| `relay` | `{ kind: smee, url: <URL> }` or `{ kind: none }` | `{ kind: none }` | Linear webhook relay. `relais init` creates a smee.io channel when there is neither `publicUrl` nor a relay. See [`linear.md`](linear.md#3-webhooks-smee-or-public-url). |
| `projects` | list of `{ id, repoPath, linearTeamKey, authz? }` | `[]` | One project = one local repository + one Linear team. See [`projects-and-workspaces.md`](projects-and-workspaces.md). `authz`: see [Authorization](#authorization). |
| `limits.perDayUsd` | number > 0 | — (no cap) | Daily budget for the whole instance, in dollars. See [Daily budget](#daily-budget). |
| `knowledge.repoPath` | path | — | Local clone of the knowledge base repository. Absent: the `learn` and `remember` jobs are skipped and `relais-agent kb search` returns nothing. |
| `github` | `{ appId, privateKey, installationId?, webhookSecret? }` | — | The daemon's GitHub App. Absent: fallback to the `gh` CLI. See [GitHub App](#github-app). |

Example:

```yaml
port: 4100
host: 127.0.0.1
relay:
  kind: smee
  url: https://smee.io/AbCdEf123
projects:
  - id: mon-app
    repoPath: /home/moi/code/mon-app
    linearTeamKey: APP
    authz: # optional, see "Authorization"
      maintainers: [6f1c2e0a-0000-4000-8000-000000000001]
      validators: [6f1c2e0a-0000-4000-8000-000000000002]
      githubLogins:
        6f1c2e0a-0000-4000-8000-000000000001: lilian-gh
        6f1c2e0a-0000-4000-8000-000000000002: armand-gh
limits:
  perDayUsd: 40
knowledge:
  repoPath: /home/moi/.relais/knowledge
github:
  appId: "123456"
  privateKey: /home/moi/.relais/github-app.pem
  installationId: "987654" # optional
```

### GitHub App

The `github` section configures the **daemon**'s identity on GitHub. It is optional: without it, Relais uses the `gh` CLI and `GH_TOKEN` as before (migration fallback, read-only: without the GitHub App, the factory neither publishes nor merges; removed by ORC-181).

| Key | Type | Default | Effect |
|---|---|---|---|
| `github.appId` | text or integer | — | App ID of the GitHub App. |
| `github.privateKey` | text | — | PEM private key **inline**, or path to a `.pem` file (recommended, mode `0600`). |
| `github.installationId` | text or integer | discovered per repository | Installation to use. Absent: the daemon calls `GET /repos/{owner}/{repo}/installation`. |
| `github.webhookSecret` | text | `GH_WEBHOOK_SECRET` | GitHub webhook secret (`POST /webhooks/github`, signature `X-Hub-Signature-256`). Absent: the `GH_WEBHOOK_SECRET` variable; without either, every GitHub webhook is refused (401). See [`github.md`](github.md#github-webhooks). |

The `GH_APP_ID`, `GH_APP_KEY` and `GH_APP_INSTALLATION_ID` variables serve as a fallback, field by field. A partial configuration (`appId` without a key, or the reverse) prevents startup: Relais does not silently switch to `gh`.

The daemon exchanges an RS256 JWT for an **installation token limited to the requested repository**, keeps it in memory for at most an hour (60 s safety margin) and never passes it to runs. Permissions, creating the App and key rotation: [`github.md`](github.md#github-app-recommended).

> **Target.** The section still lives in `config.yaml`: the move to `factory.yml` is tracked by ORC-209. The environment variables will remain the fallback for Docker and existing installations.

### Authorization

`projects[].authz` gives the roles of the [authorization matrix](linear.md#authorizations-who-can-do-what) that no source provides (ORC-186). Everything is written as **Linear user ids** (UUID, for example `query { users { nodes { id name } } }` in Linear's GraphQL explorer): these are the ids that signed webhooks carry.

| Key | Type | Default | Effect |
|---|---|---|---|
| `authz.maintainers` | list of Linear ids | `[]` | Designated maintainers: only they will be able to `/refreeze` (wired by ORC-131). |
| `authz.validators` | list of Linear ids | `[]` | Designated validators: only they will be able to validate a spec, never one from a run they launched: `/approve`, `/changes`, `/reject` of the spec gate (ORC-212). |
| `authz.githubLogins` | map Linear id → GitHub login | `{}` | The GitHub login of each Linear user whose permissions on the repository matter. Without an entry, a user has no GitHub permissions, and therefore cannot trigger the agent nor (with ORC-148) merge through *Done*. |

Linear team members and GitHub permissions are not configured: they are read (Linear, then the GitHub App or `gh`) and read again every 60 s. The App only needs read access to *Metadata* to read a user's permission.

> **Target.** These designations will move to `.factory/config.yml` (ORC-209), and the matrix itself to the `factory/default` preset (ORC-187).

### Daily budget

`limits.perDayUsd` caps the sum of run costs since midnight **UTC**. A run's cost is the one reported by Claude Code at the end of the run, or the estimate from the tokens it used when that is larger. A run cut before that report (stopped at a turn, token or duration cap, stopped by a human, killed) is priced from the tokens it consumed, at the list price of the model its stream's init line reports, by family: Opus, Sonnet, Haiku, and a model of no known family at the dearest list price (ORC-340). It counts in the day's budget and in the ticket's cost like any other.

There is **no default cap**: on a subscription the dollar figure is an API-price equivalent, not a bill, and a default would be a guess that silently stops work. Without `perDayUsd`, `factory up` logs `Warning: no daily budget (limits.perDayUsd in config.yaml): runs start whatever they cost today.`

The cap is checked before each launch, on the runs ended so far: runs still in flight count once they end. The day can therefore overshoot the cap by what the runs running at once spend: the code runs (`concurrency`) and the question runs (`question_sessions`), each up to its per-run cap (`limits.per_run.usd`) when Claude Code reports its cost. A run cut before that report is priced by estimate, at the dearest list price when it died before its init line named its model, and that estimate can exceed its per-run cap.

When the cap is reached: no new run starts, requests stay queued and Relais comments once per ticket per day « Daily budget of Relais reached: this ticket stays queued until tomorrow (or until the cap is raised). ». Runs already launched run to completion. The queue restarts on its own when the day changes (the daemon re-evaluates the queue every minute) or after a restart with a raised cap.

The day's cost and the cap are shown in the UI and by `relais status`. **Per-run** caps (turns, duration, dollars) are set in `workflow.yml` ([`workflow.md`](workflow.md#limits)).

### Ports

- `port` (4100): the Relais server.
- `workspace.ports.base` (4200, in `workflow.yml`): each run in the `dev` queue receives `PORT = base + slot no.`, from `base` to `base + parallel_sessions - 1`. Useful if the agent starts a dev server. These ports must be free on the machine.

## `secrets.json`

Written by `relais init` (application credentials) then by the OAuth connection (tokens), always with mode `0600`.

```json
{
  "linear": {
    "clientId": "…",
    "clientSecret": "…",
    "webhookSecret": "…",
    "accessToken": "…",
    "refreshToken": "…",
    "expiresAt": 1760000000000,
    "appUserId": "…",
    "organizationId": "…"
  }
}
```

| Field | Source | Role |
|---|---|---|
| `clientId`, `clientSecret` | entered during `relais init` | OAuth and token refresh. |
| `webhookSecret` | entered during `relais init` (required) | Verifies the HMAC signature of Linear webhooks. Empty or absent: all webhooks are refused (401). |
| `accessToken`, `refreshToken`, `expiresAt` | « Connect Linear » | Application token, refreshed automatically. |
| `appUserId`, `organizationId` | « Connect Linear » | The agent's identity in Linear (used to list the tickets delegated to it). |

Rerunning `relais init` with the **same** client ID keeps the tokens; with a different one, Linear must be reconnected.

## `factory.yml` (ORC-209)

`<FACTORY_HOME>/factory.yml` is the factory's server configuration. It is **optional** and coexists with `config.yaml` and `secrets.json` until they are removed (ORC-199). Every secret is written there as `env:NAME` and read from the daemon's environment: a plaintext secret is refused. It is read **once, at startup**: an invalid file prevents `factory up` from starting, with the path of the offending key, and a change made while the daemon is running only counts at the next startup. Only `factory up`, `factory doctor` (GitHub App) and `factory plan` (Linear credentials) read it, with the daemon's environment; the other commands (`status`, `stop`, `init`…) do without it, and therefore work in a shell that does not have its variables.

```yaml
linear:   { app_client_id: env:LINEAR_CLIENT_ID, client_secret: env:LINEAR_CLIENT_SECRET, webhook_secret: env:LINEAR_WEBHOOK_SECRET }
github:   { app_id: env:GH_APP_ID, private_key: env:GH_APP_KEY, webhook_secret: env:GH_WEBHOOK_SECRET }
claude:
  runtime: claude-code
  accounts:
    - { name: compte-1, token: env:CLAUDE_TOKEN_1 }
  active: compte-1
  default_model: claude-sonnet-5-5
  per_step: { review: claude-opus-5-5 }
  effort: { default: medium, per_step: { spec_draft: high, review: high } }
concurrency: 1
budgets: { max_turns: { build: 150, fix: 60, review: 25 }, on_usage_limit: wait }
repos:
  - linear_team: ORC
    github: LilianPe/Orchestrator
    env: { NODE_ENV: test }                 # the values of what .factory/config.yml declares under env
    secrets: { NPM_TOKEN: env:ORC_NPM_TOKEN } # and under setup_secrets: env:NAME only, at least 8 characters
read_guard: { max_lines: 350 }
```

| Section | Effect today |
| -- | -- |
| `github` | **Applied**: its keys replace those of `github` in `config.yaml`; a key it does not declare (`installation_id`, `webhook_secret`) stays the one from `config.yaml`. |
| `linear` | **Applied**: `app_client_id`, `client_secret` and `webhook_secret` replace those in `secrets.json`. The OAuth tokens stay in `secrets.json`, written by « Connect Linear ». |
| `claude` | **`accounts` and `active` applied** (ORC-211): the active account's token is the runner's only credential. **`effort` applied** (ORC-136): `per_step` replaces a preset step's effort, `default` is used for jobs outside the preset (`ask`, `learn`). The rest of account selection comes with ORC-215. |
| `concurrency` | **Applied** (ORC-203): capacity of the `dev` queue, instead of the workflow's `limits.parallel_sessions`. The `questions` queue keeps `question_sessions`. |
| `budgets` | **`max_turns` and `per_step_tokens` applied** (ORC-136), per step: `max_turns` can only lower the step's turns, `per_step_tokens` is a per-attempt cap, with no default value. **`per_ticket_tokens` applied** (ORC-340): the tokens of the ticket's code runs (the `dev` queue; questions such as `ask` and `learn` do not count; cache reads left out). Once spent, the next code run is refused before any workspace is prepared, and the ticket is blocked with `Token budget of the ticket reached: <spent> tokens spent of <cap> by its code runs (budgets.per_ticket_tokens).`. The block message says when a raised cap takes effect: `factory.yml` is read once, so its cap counts after a daemon restart, while the repository's cap is read again at each launch. A run never gets more than what is left, and keeps that cap if the daemon restarts under it. The repository's `budgets.per_ticket_tokens` can only lower it. **`on_usage_limit: wait` applied** (ORC-340): a run that did not succeed because the subscription's usage limit stopped it (a rejected `rate_limit_event` that neither a model turn nor an `allowed` event followed, or the result `Claude AI usage limit reached|<reset>`) neither blocks the ticket nor counts as an attempt. The limit belongs to the active Claude account (`claude.active`): until the announced reset, no run on that account starts, for any ticket, and the queues wait. The wait is never shorter than 5 minutes, and an hour when no reset was announced. The stop is visible in three places: `factory up` logs `usage limit of the Claude account <name> reached ...: launches held until <time>`, the cut ticket's Linear session says `Usage limit reached; resuming at <time>.`, and the dashboard shows a banner until the reset. At the reset, the cut code step runs again as a relaunch after a cut, reading what the cut run read, in the session of its role. It does so only if the ticket is still where it was cut: still delegated, unblocked, in the same state, with no run started since. A recorded move to the same state, or a failed effect, does not count as moving on. The ticket's other steps requested meanwhile wait behind it. A step the limit cuts more than 3 times in a row is blocked (cause `limit`). A question the limit stopped is told `The usage limit is reached: I will answer after <time>.` and is asked again at the reset, in its thread, at most 3 times in a row. After that, its thread is told `The usage limit is still reached; ask again later.` once. A wait is recorded only on a delegated, undelivered ticket. A delegation again ends it, a human relaunch resets the relaunch count, and a reset that finds its wait no longer current clears it. Without the key, such a run blocks the ticket like any failure. The worst case of `factory validate` comes with ORC-216. |
| `repos` | **`env` and `secrets` applied** (ORC-211), the entry being found through the project's `origin` remote: see [`repository-configuration.md`](repository-configuration.md#variables-and-secrets). For the rest, `projects[].repoPath` in `config.yaml` remains the working copy as long as the runner does not clone by itself (ORC-204). |
| `read_guard` | **Applied**: `max_lines` (positive integer, 350 without this key) is the number of lines beyond which the pack's hook refuses a full read ([ORC-279](pack-and-skills.md#full-read-of-a-large-file)). It counts from the next startup. |

`factory.yml` is only ever read: `init` and token writing never copy any of its values into `config.yaml` or `secrets.json`. Its secrets are masked in the runs' transcripts, like those of `secrets.json`.

## What does not leave the daemon

The daemon holds the secrets; Claude Code runs do not need them and must not access them.

1. **Run environment by allowlist (ORC-211).** In a sandbox, a run receives its run variables (`FACTORY_API`, `FACTORY_RUN_TOKEN`, a random token valid during the run, `FACTORY_TICKET`…), the pack hook's settings, without secrets (`FACTORY_READ_MAX_LINES`, `FACTORY_FULL_READ_PATHS`), the variables the repository declares ([`repository-configuration.md`](repository-configuration.md#variables-and-secrets)) and a placeholder as `CLAUDE_CODE_OAUTH_TOKEN`, the egress proxy setting the `claude.active` account's token (without `factory.yml`, the daemon's variable of that name) on the model calls (ORC-337): nothing else, neither `ANTHROPIC_API_KEY`, nor `ANTHROPIC_BASE_URL`, nor `GH_TOKEN`. On the host, a run additionally receives the system variables (`PATH`, `HOME`, `LANG`, `TMPDIR`…), the commit identity (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`) and, in transition, `GH_TOKEN` (until ORC-125) and `ANTHROPIC_API_KEY` (until ORC-179, removed as soon as an active account exists). Any other variable stays in the daemon.
2. **Linear goes through `relais-agent`.** The agent never sees the Linear token: it calls the local API with its run token, which only gives access to the run's ticket, search, the knowledge base and the question (`ask`). See [`cli.md`](cli.md#relais-agent-agent-side).
3. **`run-settings.json`.** On each `relais up`, Relais writes `<RELAIS_HOME>/run-settings.json`: the pack's permissions (`packs/standard/settings.json`) plus refusals on the **real** path of `RELAIS_HOME`: `Read`/`Edit` of `secrets.json`, `Read` of `relais.db*`, `transcripts/**`, `logs/**`, and any Bash command that mentions `secrets.json` or `relais.db`. This file is passed to each run through `--settings`. The worktrees (`workspaces/`) stay readable.
4. **GitHub App token kept out of runs.** The installation token is requested for the run's repository only, kept in the daemon's memory and never mounted in the runner's environment nor written to a transcript. `GH_TOKEN` is no longer passed to any run (ORC-125): the factory publishes. See [`github.md`](github.md#tokens).

Known limit: these refusals are Claude Code guardrails, not a security boundary. An agent that executes code (`node`, `npm`) as the same system user as the daemon can read `secrets.json`. Details and consequences: [`interface-and-security.md`](interface-and-security.md#known-limitations).
