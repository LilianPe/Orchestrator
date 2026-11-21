# Daemon configuration

The factory is configured at these levels:

| Level | File | Scope | Doc |
|---|---|---|---|
| Instance | `<FACTORY_HOME>/config.yaml` | The daemon: port, host, projects, webhook relay, knowledge base. | this page |
| Secrets | `<FACTORY_HOME>/secrets.json` | Linear credentials. | this page |
| Server | `<FACTORY_HOME>/factory.yml` | Secrets as references, the GitHub App, Claude accounts, budgets, tools, repositories' variables and secrets (ORC-209). | [below](#factoryyml-orc-209) |
| Project | `.factory/config.yml` in each repository, read on its default branch | Its setup, its checks, its sensitive paths and limits; it can only tighten the preset. A `.factory/workflow.yml` is ignored since ORC-388: the workflow is the `factory/default` preset ([`preset.md`](preset.md)). | [`repository-configuration.md`](repository-configuration.md) |

The instance files are read **at startup** of `factory up`: restart after a change (but `claude.active` of `factory.yml`, ORC-215).

## Environment variables

| Variable | Read by | Default | Effect | Secret |
|---|---|---|---|---|
| `FACTORY_HOME` | all `factory` commands | `$HOME/.factory` | Instance directory (see [`installation.md`](installation.md#the-daemons-home-directory)). | no |
| `FACTORY_DATABASE_URL` | `factory up`, `factory plan` | — | Postgres connection string (`postgres://user:password@host:5432/database`). When set, the daemon keeps its state in Postgres (`PgStore`) and applies the Drizzle migrations from `drizzle/` at startup (`factory plan` reads it without migrating it); an unreachable database prevents startup, with no fallback to SQLite. Absent: SQLite database `<FACTORY_HOME>/factory.db`, until it is removed (ORC-178); in production (`NODE_ENV=production`, set by the image) its absence prevents startup, unless `FACTORY_STORE=sqlite` (ORC-350). Never passed to runs (`FACTORY_` prefix), never written to the daemon's log. | **yes** |
| `FACTORY_STORE` | `factory up`, `factory plan` | — | `sqlite`: in production, without `FACTORY_DATABASE_URL`, start on the SQLite database all the same (ORC-350). Otherwise a production start without `FACTORY_DATABASE_URL` is refused, so that a variable lost in a deployment never starts the factory on an empty database. No effect outside production or with `FACTORY_DATABASE_URL`. The commands that open the store (`plan`, `replay --export`, `run repair`…) refuse the same way. | no |
| `FACTORY_CONTAINER_CLI` | `factory up` | — | `docker` or `podman`. When set, each attempt runs in a disposable container (ORC-204): created when it launches, destroyed when it ends, and those a crash left behind are destroyed at the next startup. The repository's `setup` runs there too. Absent: `factory up` refuses to start, unless `FACTORY_ALLOW_HOST_RUNS=1` (ORC-349). No effect with `--fake-runner`. See [`interface-and-security.md`](interface-and-security.md#known-limitations). | no |
| `FACTORY_ALLOW_HOST_RUNS` | `factory up` | — | `1`: without `FACTORY_CONTAINER_CLI`, the agents run on the host, under the daemon's user, next to its secrets, and the daemon says so at startup. For development only. Otherwise, without a container engine, `factory up` refuses to start (ORC-349). No effect with `FACTORY_CONTAINER_CLI` or `--fake-runner`. See [`interface-and-security.md`](interface-and-security.md#known-limitations). | no |
| `FACTORY_ALLOW_HOST_VERIFY` | `factory up` | — | `1`: without a sandbox, `verify` and the red check run the agent's code on the host, next to the daemon's secrets. Otherwise, they refuse and the ticket is blocked. No effect with `FACTORY_CONTAINER_CLI`: a failed engine never falls back to the host. See [`interface-and-security.md`](interface-and-security.md#known-limitations). | no |
| `FACTORY_MESSAGE_MODEL` | `factory up` | — | `off`, `0`, `false` or `none` (any case): no small model classifies human messages, the `?` fallback rule does it alone (ORC-336). Any other value is logged as a warning and leaves the model on. See [`operations.md`](operations.md#the-small-model-of-messages). | no |
| `FACTORY_RUNNER_IMAGE` | `factory up` | — | Image of the run containers (`docker/runner.Dockerfile`: node and pnpm, python and uv, git, gitleaks, claude): without gitleaks, every `verify` is a failure (ORC-151). Required with `FACTORY_CONTAINER_CLI`. | no |
| `FACTORY_BROWSER_IMAGE` | `factory up`, `factory doctor` | — | The capture image of the visual proof (`docker/browser.Dockerfile`, ORC-404): the runner image plus Playwright's Chromium. When the engine has it with its label `factory.browser`, built on `FACTORY_RUNNER_IMAGE` (an image left from before the runner's update is refused), the sandboxes that shoot run it and the daemon wires the browser; otherwise a required visual proof is unavailable, its check neutral. Said at startup and by `factory doctor`. No effect without `FACTORY_CONTAINER_CLI`. | no |
| `FACTORY_EGRESS_CONTROL` | `factory up` | — | Control socket of the `proxy` service (ORC-203). When set, the daemon drives that service instead of running the egress proxy in its own process. | no |
| `FACTORY_INSTALL_DIR` | `docker/entrypoint.sh` | — | Where to copy the installation, at a path the engine sees on the host; the daemon runs from that copy, one per image ([`deployment.md`](deployment.md#why-the-same-paths-on-both-sides)). | no |
| `FACTORY_ALLOW_ROOTFUL_ENGINE` | `docker/entrypoint.sh` | — | `1`: allows the daemon container to start on an engine that is not rootless. Development workstation only. | no |
| `FACTORY_COMMIT` | `factory up` | set when the image is built | The factory's commit, recorded on each attempt. | no |
| `FACTORY_AGENT_PORT` | `factory up` | UI port + 1 | Port of the server that only serves the factory MCP (`/agent/mcp`), for containers. Started only with `FACTORY_CONTAINER_CLI`. | no |
| `FACTORY_AGENT_HOST` | `factory up` | `127.0.0.1` | Listen address of that server. Containers reach it through the daemon's egress proxy (ORC-213), not through the network: loopback is enough. Under compose, `0.0.0.0`: the `proxy` service reaches it over the internal network. | no |
| `FACTORY_SANDBOX_AGENT_HOST` | `factory up` | `host.docker.internal` | Name of the daemon in the runs' `FACTORY_API` (`http://<name>:<FACTORY_AGENT_PORT>/agent`). The container does not resolve it: the egress proxy recognizes this name and relays to the server of the factory MCP. | no |
| `FACTORY_SANDBOX_PIDS` | `factory up` | `512` | Maximum number of processes in a run container (`--pids-limit`): a fork bomb hits it without starving the other attempts (ORC-218). `0` or `none`: no limit, and `factory doctor` then no longer requires the `pids` controller (ORC-451). A value that is not a positive integer prevents startup, before anything opens, and `factory doctor` refuses it with the same message (ORC-450). | no |
| `FACTORY_SANDBOX_MEMORY` | `factory up` | `4g` | Memory of a run container, with no swap beyond it (`--memory` and `--memory-swap`): a memory hog is killed by the OOM killer. Size: a positive integer, no leading zero, optionally followed by one unit letter `b`, `k`, `m` or `g` (any case; without one, bytes), exactly `^[1-9][0-9]*[bkmg]?$`: `512m`, `4g`, `4G`. No decimal, no two-letter unit, no space: `1.5g`, `4gb` or `512 m` are refused even though an engine may accept them; write `1536m` or `4g`. At least `6m` (6 MiB: `6m`, `6144k` or `6291456`), the minimum Docker and Podman accept: `5m` is refused (ORC-452). `0` or `none`: no limit, and `factory doctor` then no longer requires the `memory` controller (ORC-451). Another value prevents startup, and `factory doctor` refuses it (ORC-450). | no |
| `FACTORY_POSTGRES_IMAGE` | `factory up` | `docker.io/library/postgres:16-bookworm` | Image of the Postgres the factory starts for each attempt of a repository with `services: [postgres]` (ORC-309, [`repository-configuration.md`](repository-configuration.md#services)). Fully qualified for rootless Podman. | no |
| `FACTORY_SANDBOX_CPUS` | `factory up` | `2`, or the host's CPU count if it has fewer | CPUs of a run container (`--cpus`, decimals accepted: `0.5`). `0` or `none`: no limit, and `factory doctor` then no longer requires the `cpu` controller (ORC-451). Another value prevents startup, and `factory doctor` refuses it (ORC-450). | no |
| `FACTORY_REFUSALS_LOG` | `factory up` | `$CLAUDE_CONFIG_DIR/factory-refusals.jsonl` | File for the `PreToolUse` hook's refusal log; passed to runs on the host only if it is set. In a sandbox, ignored: each run writes to `<FACTORY_HOME>/runs/<runId>/refusals/refusals.jsonl` (ORC-217). See [`pack-and-skills.md`](pack-and-skills.md#pretooluse-hook-and-refusal-log). | no |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude`, in a sandbox and on the host | — | Claude Code account token when `factory.yml` does not choose one (`claude.active`). In a sandbox, the egress proxy sets it on the model calls, and the sandbox holds a placeholder (ORC-337). | **yes** |
| `GH_APP_ID` | daemon (fallback for `github.appId`) | — | Identifier of the factory's GitHub App. | no |
| `GH_APP_KEY` | daemon (fallback for `github.privateKey`) | — | PEM private key of the GitHub App, or path to the `.pem` file. | **yes** |
| `GH_APP_INSTALLATION_ID` | daemon (fallback for `github.installationId`) | — | App installation to use; optional, the daemon can find it per repository. | no |
| `GH_APP_CLIENT_ID` | daemon (fallback for `github.clientId`) | — | Client id of the GitHub App, for the dashboard's GitHub sign-in (ORC-399). **Required**, with its secret, as soon as `host` is not a loopback address. | no |
| `GH_APP_CLIENT_SECRET` | daemon (fallback for `github.clientSecret`) | — | Client secret of the GitHub App, for the dashboard's GitHub sign-in (ORC-399). | **yes** |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | git (inherited by runs) | the machine's git identity; in Docker `Orchestrator <factory@localhost>` | Identity of the agents' commits. | no |
| `PATH` | the daemon | — | Must contain `git`, the engine's CLI with `FACTORY_CONTAINER_CLI`, and `claude` for runs on the host (the daemon image has none: in a sandbox, `claude` is the runner image's). | no |

> **Transition note**: `ANTHROPIC_API_KEY` is still read, in transition. On the host only (`FACTORY_ALLOW_HOST_RUNS=1`), it authenticates `claude` without `claude login` or an active account, and is dropped as soon as an account is chosen; it is never passed to a sandbox (ORC-211) and goes with host runs (ORC-179). It is also read as the key of the small model of messages when `message_model.api_key` is not set in `factory.yml`, with a warning at the start (ORC-445, [`operations.md`](operations.md#the-small-model-of-messages)). The code also keeps the old `RELAIS_*` variables out of runs and refuses them in a repository's `env` (ORC-167); none is read any more, `RELAIS_HOME` included: set `FACTORY_HOME`.

Variables reserved for tests (no effect on the daemon): `LINEAR_API_KEY` (live test of the Linear queries), `FACTORY_E2E=1` (pack test with the real `claude`). See [`acceptance.md`](acceptance.md#optional-live-checks).

Variables **set by the factory** in each run's environment (do not set them yourself): `FACTORY_API` and `FACTORY_RUN_TOKEN` (the factory MCP's address and credential), `FACTORY_TICKET`, `FACTORY_REFUSALS_LOG` when the daemon has it (in a sandbox, always, pointing to the run's directory), `FACTORY_READ_MAX_LINES` when `factory.yml` declares `read_guard.max_lines`, `FACTORY_FULL_READ_PATHS` when a file must be read in full, `FACTORY_TOOLS` with the run's built-in tools (the hook refuses any other, ORC-383) and, for a run in the ticket's worktree, `PORT`. See ["What does not leave the daemon"](#what-does-not-leave-the-daemon). In a container, these paths are the container's, and its `PATH` is its image's, never the host's. Of the factory's install, only the pack (`/factory/pack`) and the run settings (`/factory/settings.json`) are mounted in a sandbox, read-only; nothing is put on its `PATH` since the agent's CLI is gone (ORC-192).

## `config.yaml`

Written by `factory init`, editable by hand. Missing file = all default values. An invalid field prevents startup with `invalid config.yaml: <field>: <message>`.

| Key | Type | Default | Effect |
|---|---|---|---|
| `port` | integer > 0 | `4100` | HTTP server port (UI, API, webhooks, OAuth). Also the port the CLI queries (`http://127.0.0.1:<port>`). |
| `host` | text | `127.0.0.1` | Listen address. Any value other than loopback (`localhost`, `127.x.x.x`, `::1`) puts the interface behind a GitHub sign-in (ORC-399): it requires the App's OAuth client, `dashboard` in `factory.yml`, an `https://` `publicUrl` and `secrets_key` (ORC-398), see [`interface-and-security.md`](interface-and-security.md#network-exposure-and-github-sign-in). In Docker: `0.0.0.0`. |
| `publicUrl` | URL | — | Public HTTPS URL of the factory: the server's domain, behind its reverse proxy ([`deployment.md`](deployment.md#tls-and-webhooks)), or a development tunnel. If set, it is used as the base for the OAuth callback URL (`<publicUrl>/oauth/callback`) and the webhook URL (`<publicUrl>/webhooks/linear`), and `factory init --dev` does not create a smee channel. Without it: `http://localhost:<port>`. |
| `relay` | `{ kind: smee, url: <URL> }` or `{ kind: none }` | `{ kind: none }` | Linear webhook relay, for a workstation only: `none` on the server. `factory init --dev` creates a smee.io channel when there is neither `publicUrl` nor a relay; without `--dev`, `init` creates none (ORC-411). The daemon starts it with `dev: true`, refuses it with `dev: false` or with `dev: true` beside a `publicUrl`, and warns without the key (ORC-444, ORC-446, see `dev`); `factory doctor` says the same. See [`linear.md`](linear.md#3-webhooks-production-and-development). |
| `dev` | boolean | — | The development mode (ORC-444), written `true` by `factory init --dev` alone, beside a `smee` relay: the daemon starts a `smee` relay only in it. `dev: false` with a `smee` relay refuses the start, naming `publicUrl` and `factory init --dev`; `dev: true` with a `smee` relay and a `publicUrl` refuses it too, naming `relay: { kind: none }`: a `publicUrl`, a server's or a tunnel's, brings Linear's webhooks already (ORC-446). A `config.yaml` without the key, written before it, starts with a warning to run `factory init --dev` again. `factory doctor` warns and refuses as the start does (ORC-446). |
| `projects` | list of `{ id, repoPath, linearTeamKey, authz?, effects?, preset? }` | `[]` | One project = one local repository + one Linear team. See [`projects-and-workspaces.md`](projects-and-workspaces.md). `authz`: see [Authorization](#authorization). `effects: none`: nothing of the project leaves the factory, its effects kept as artifacts; `preset: factory/fantome`: the replay of closed tickets, always without effects, whose tickets only the daemon delegates, never Linear (ORC-231, ORC-376, [ghost-replay.md](ghost-replay.md)). |
| `limits` | `{}` | `{}` | Empty since ORC-216: the daily budget in dollars (`perDayUsd`) is gone, a file that still has it loads without it, and nothing counts a day in dollars, not even for display (ORC-194). Budgets count tokens and turns: `budgets` of `factory.yml`. |
| `knowledge.repoPath` | path | — | Local clone of the knowledge base repository. Read only, by the server: pulled at each launch, its index in the session's system prompt, its notes searched by the factory MCP's `kb_search` (ORC-232); no job writes to it (ORC-193); the factory itself commits there the start recipes it validated, `notes/preview/`, and pushes them (ORC-386, [preset.md](preset.md#jobs)). Absent: no index, and `kb_search` says there is no knowledge base. |
| `github` | `{ appId, privateKey, installationId?, webhookSecret? }` | — | The daemon's GitHub App. Absent: the factory reads and publishes nothing on GitHub (ORC-181). See [GitHub App](#github-app). |

Example:

```yaml
port: 4100
host: 127.0.0.1
dev: true                        # workstation only (factory init --dev)
relay:
  kind: smee                     # workstation only (factory init --dev)
  url: https://smee.io/AbCdEf123 # the workstation relay's channel (factory init --dev)
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
knowledge:
  repoPath: /home/moi/.factory/knowledge
github:
  appId: "123456"
  privateKey: /home/moi/.factory/github-app.pem
  installationId: "987654" # optional
```

### GitHub App

The `github` section configures the **daemon**'s identity on GitHub. It is optional, but without it the factory reads no PR, publishes nothing and merges nothing: it has no other way to GitHub since ORC-181 ( [`github.md`](github.md#without-a-github-app)).

| Key | Type | Default | Effect |
|---|---|---|---|
| `github.appId` | text or integer | — | App ID of the GitHub App. |
| `github.privateKey` | text | — | PEM private key **inline**, or path to a `.pem` file (recommended, mode `0600`). |
| `github.installationId` | text or integer | discovered per repository | Installation to use. Absent: the daemon calls `GET /repos/{owner}/{repo}/installation`. |
| `github.webhookSecret` | text | `GH_WEBHOOK_SECRET` | GitHub webhook secret (`POST /webhooks/github`, signature `X-Hub-Signature-256`). Absent: the `GH_WEBHOOK_SECRET` variable; without either, every GitHub webhook is refused (401). See [`github.md`](github.md#github-webhooks). |
| `github.clientId`, `github.clientSecret` | text | `GH_APP_CLIENT_ID`, `GH_APP_CLIENT_SECRET` | The App's OAuth client, for the dashboard's GitHub sign-in off the loopback (ORC-399). One without the other prevents startup. In `factory.yml`: `client_id`, `client_secret: env:NAME`. |

The `GH_APP_ID`, `GH_APP_KEY` and `GH_APP_INSTALLATION_ID` variables serve as a fallback, field by field. A partial configuration (`appId` without a key, or the reverse) prevents startup.

The daemon exchanges an RS256 JWT for an **installation token limited to the requested repository**, keeps it in memory for at most an hour (60 s safety margin) and never passes it to runs. Permissions, creating the App and key rotation: [`github.md`](github.md#github-app-recommended).

> The section still lives in `config.yaml`, and the `github` section of `factory.yml` replaces it key by key ([below](#factoryyml-orc-209), ORC-209). The environment variables remain the fallback for Docker and existing installations.

### Authorization

`projects[].authz` gives the roles of the [authorization matrix](linear.md#authorizations-who-can-do-what) that no source provides (ORC-186). Everything is written as **Linear user ids** (UUID, for example `query { users { nodes { id name } } }` in Linear's GraphQL explorer): these are the ids that signed webhooks carry.

| Key | Type | Default | Effect |
|---|---|---|---|
| `authz.maintainers` | list of Linear ids | `[]` | Designated maintainers: only they will be able to `/refreeze` (wired by ORC-131). |
| `authz.validators` | list of Linear ids | `[]` | Designated validators: only they will be able to validate a spec, never one from a run they launched: `/approve`, `/changes`, `/reject` of the spec gate (ORC-212). Every delegation goes through that gate (ORC-395): with none designated, or with a delegator as the only one, no ticket gets past its spec. |
| `authz.githubLogins` | map Linear id → GitHub login | `{}` | The GitHub login of each Linear user whose permissions on the repository matter. Without an entry, a user has no GitHub permissions, and therefore cannot trigger the agent nor (with ORC-148) merge through *Done*. |

A project whose `authz.validators` is empty, or holds a single id, cannot get every spec approved: the initiator of a run never approves its spec, so with none every ticket stops at the spec gate, and with one the tickets that validator delegates. `factory doctor`, for the repository it checks, and the daemon's start, for every project, warn of it, naming `authz.validators` (ORC-421); a project on `factory/fantome` approves its own specs.

Linear team members and GitHub permissions are not configured: they are read (Linear, then the GitHub App) and read again every 60 s. The App only needs read access to *Metadata* to read a user's permission.

> **Target.** These designations will move to `.factory/config.yml` (ORC-209), and the matrix itself to the `factory/default` preset (ORC-187).

### Budgets

There is no budget in dollars (ORC-216): a run's cost (`costUsd`, the one Claude Code reports, or the estimate from its tokens when larger, ORC-340) is a measure shown on the dashboard, never a cap. Budgets count tokens and turns, per step and per ticket: `budgets` of `factory.yml` (below), and the repository's `budgets.per_ticket_tokens`, which only lowers the ticket's. Without `budgets.per_ticket_tokens`, `factory up` logs `Warning: no ticket budget (budgets.per_ticket_tokens in factory.yml): a ticket runs whatever it spends; `factory validate` refuses until it is set.`

### Ports

- `port` (4100): the factory's server.
- `workspace.portBase` of the workflow (4200, fixed by the preset): each run in a ticket's worktree receives `PORT = base + slot no.`, from `base` to `base + concurrency - 1`; a run on a clone (`ask`, `intake`, the AI review) receives none. Useful if the agent starts a dev server; the visual proof's application listens on `PORT` too ([`repository-configuration.md`](repository-configuration.md)). On the host, these ports must be free on the machine.

## `secrets.json`

Written by `factory init` (application credentials) then by the OAuth connection (tokens), always with mode `0600`.

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
| `clientId`, `clientSecret` | entered during `factory init` | OAuth and token refresh. |
| `webhookSecret` | entered during `factory init` (required) | Verifies the HMAC signature of Linear webhooks. Empty or absent: all webhooks are refused (401). |
| `accessToken`, `refreshToken`, `expiresAt` | « Connect Linear » | Application token, refreshed automatically. |
| `appUserId`, `organizationId` | « Connect Linear » | The agent's identity in Linear (used to list the tickets delegated to it). |

Rerunning `factory init` with the **same** client ID keeps the tokens; with a different one, Linear must be reconnected.

**Encrypted at rest (ORC-398).** `secrets_key` is required when the daemon is exposed off the loopback (`host` other than `localhost`, `::1` or `127.x.x.x`, as for the GitHub sign-in of ORC-399): without it the daemon refuses to start and names `secrets_key`. On the loopback it stays optional, and `factory doctor` warns of `secrets.json` in clear. With `secrets_key` in `factory.yml` (a reference, read at the start like the other server secrets, at least 32 characters: `openssl rand -base64 32`), the daemon encrypts `secrets.json` at its start if it is still in clear (`secrets.json: encrypted at rest with secrets_key` in its log), and at each write. Envelope encryption: a data key drawn at each write encrypts the JSON (AES-256-GCM), and is itself encrypted by a key derived from `secrets_key` (HKDF-SHA256). A sealed file without its key cannot be read: `factory init`, `plan` and `baseline` then need the daemon's environment, and `init` refuses (`secrets.json is encrypted at rest…`) once the file is sealed: write the Linear values in `factory.yml` instead. Losing `secrets_key` loses the Linear tokens: reconnect Linear.

## `factory.yml` (ORC-209)

`<FACTORY_HOME>/factory.yml` is the factory's server configuration. It is **optional** and coexists with `config.yaml` and `secrets.json` until they are removed (ORC-199). Every secret is written there as a reference `<source>:<path>`: `env:NAME` reads the daemon's environment, another source is read at the start (see [Server secrets](#server-secrets-orc-398)); a plaintext secret is refused. A repository's secrets (`repos[].secrets`) are references too, read at each `setup` (see [Repository secrets](#repository-secrets-orc-308)). It is read **once, at startup**: an invalid file prevents `factory up` from starting, with the path of the offending key, and a change made while the daemon is running only counts at the next startup. Only `factory up`, `factory doctor` (GitHub App) and `factory plan` (Linear credentials) read it, with the daemon's environment; the other commands (`status`, `stop`, `init`…) do without it, and therefore work in a shell that does not have its variables.

```yaml
linear:   { app_client_id: env:LINEAR_CLIENT_ID, client_secret: env:LINEAR_CLIENT_SECRET, webhook_secret: env:LINEAR_WEBHOOK_SECRET }
github:   { app_id: env:GH_APP_ID, private_key: env:GH_APP_KEY, webhook_secret: env:GH_WEBHOOK_SECRET, client_id: Iv1.0123456789abcdef, client_secret: env:GH_APP_CLIENT_SECRET }
dashboard: { logins: [armand], org: acme, team: acme/factory-ops }   # who may sign in off the loopback (ORC-399): any of them
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
tools: { per_step: { build: [Read, Grep, Glob, Edit, Write, Bash, Skill] } }   # a step's built-in tools, in place of the preset's
repos:
  - linear_team: ORC
    github: LilianPe/Orchestrator
    env: { NODE_ENV: test }                 # the values of what .factory/config.yml declares under env
    secrets: { NPM_TOKEN: env:ORC_NPM_TOKEN } # and under setup_secrets: references <source>:<path>, read at the setup
read_guard: { max_lines: 350 }
audit: { serious_defect: "..." }   # the definition of a serious defect (ORC-153): absent, nothing is counted
acknowledge: reaction              # how a human message is acknowledged (ORC-380): comment (default) or reaction
message_model: { api_key: env:FACTORY_MESSAGE_API_KEY }   # the Messages API key of the small model of messages (ORC-445)
statuses: { spec_draft: Spec }     # the Linear status each step shows (ORC-382), ORC-170's for the others
spec: { publish: comment+doc, threshold: 5000 }   # where a spec is published (ORC-382): comment, comment+doc (default) or doc
egress: { max_versions_per_package: 10, max_assets_per_repo: 5 }   # caps of the reads that move a public counter, per run (ORC-370)
```

| Section | Effect today |
| -- | -- |
| `github` | **Applied**: its keys replace those of `github` in `config.yaml`; a key it does not declare (`installation_id`, `webhook_secret`, `client_id`, `client_secret`) stays the one from `config.yaml`. `client_id` and `client_secret` are the App's OAuth client of the dashboard's GitHub sign-in (ORC-399). |
| `dashboard` | **Applied** (ORC-399), off the loopback: who may sign in to the dashboard with GitHub. `logins` (a list of GitHub logins, compared whatever their case), `org` (its active members) and `team` (`<org>/<team-slug>`, its active members): any of them lets a person in, and at least one must be given. An org or a team asks the App for the organization permission *Members: read* ([`github.md`](github.md#creating-the-app)). Required when `host` is not a loopback address; ignored on the loopback. Read at each sign-in; a change counts from the next startup. |
| `linear` | **Applied**: `app_client_id`, `client_secret` and `webhook_secret` replace those in `secrets.json`. The OAuth tokens stay in `secrets.json`, written by « Connect Linear ». |
| `claude` | **`accounts` and `active` applied** (ORC-211): the active account's token is the runner's only credential. **`effort` applied** (ORC-136): `per_step` replaces a preset step's effort, `default` is used for jobs outside the preset (`ask`). **A change of `active` counts from the next launch, without a restart** (ORC-215): the `claude` section alone is validated again at each launch, so an invalid key elsewhere in the file does not stop a switch (a file that is no longer YAML does); a section that no longer parses, or a file gone, keeps the last account, with a `Warning: factory.yml: the Claude account is not read again, <name> stays active: …` in the daemon's log. A run keeps the account it was launched on: a usage limit it hits holds that account, whatever is active by then. The tokens are read from the daemon's environment, so a new account's variable must be set before the daemon starts. |
| `concurrency` | **Applied** (ORC-203): capacity of the `dev` queue, 3 by default; the workflow's `limits.parallel_sessions` is no longer read (ORC-390). The `questions` queue has a fixed capacity of 2. |
| `budgets` | **`max_turns` and `per_step_tokens` applied** (ORC-136), per step: `max_turns` can only lower the step's turns, `per_step_tokens` is a per-attempt cap, with no default value. An attempt stopped at its token or turn cap blocks the ticket with the kind `budget` (cause `limit` in the Flow) and the standard comment: « The run <job> spent its token budget (budgets.per_step_tokens, or what the ticket had left). » or « … its turn budget (max_turns of its step). » (ORC-216). **`per_ticket_tokens` applied** (ORC-340): the tokens of the ticket's code runs (the `dev` queue; questions such as `ask` do not count; cache reads left out). Once spent, the next code run is refused before any workspace is prepared, and the ticket is blocked (kind `budget`, ORC-216) with `Token budget of the ticket reached: <spent> tokens spent of <cap> by its code runs (budgets.per_ticket_tokens).`. The block message says when a raised cap takes effect: `factory.yml` is read once, so its cap counts after a daemon restart, while the repository's cap is read again at each launch. A run never gets more than what is left, and keeps that cap if the daemon restarts under it. The repository's `budgets.per_ticket_tokens` can only lower it. **`on_usage_limit: wait` applied** (ORC-340): a run that did not succeed because the subscription's usage limit stopped it (a rejected `rate_limit_event` that neither a model turn nor an `allowed` event followed, or the result `Claude AI usage limit reached|<reset>`) neither blocks the ticket nor counts as an attempt. The limit belongs to the active Claude account (`claude.active`): until the announced reset, no run on that account starts, for any ticket, and the queues wait. The wait is never shorter than 5 minutes after the run's end, and an hour when no reset was announced: a result sent after a long stop holds nothing once that is past. The hold is also kept in the daemon's memory: a store that fails to record it still holds that daemon's launches. The stop is visible in three places: `factory up` logs `usage limit of the Claude account <name> reached ...: launches held until <time>`, the cut ticket's Linear session says `Usage limit reached; resuming at <time>.`, and the dashboard shows a banner until the reset. The cut code step waits in the queue as a relaunch after a cut (ORC-357), and runs at the first tick past the reset (each minute), reading what the cut run read, in the session of its role. Its launch refuses it as any other start: on a ticket undelegated, blocked or whose PR is merged since. The ticket's other steps requested meanwhile wait behind it in the queue. A step the limit cuts more than 3 times in a row is blocked (cause `limit`). A question the limit stopped is told `The usage limit is reached: I will answer after <time>.` and is asked again at the reset, in its thread, at most 3 times in a row. After that, its thread is told `The usage limit is still reached; ask again later.` once. A step waits only on a delegated, undelivered, unblocked ticket, and a human relaunch resets the relaunch count. Without the key, such a run blocks the ticket like any failure. `factory validate` computes the preset's worst case from these caps and refuses it over `per_ticket_tokens`, or while a cap is unset (ORC-216, see [`cli.md`](cli.md#factory-validate-repo)). **`off` disables a token cap** (ORC-381): `per_step_tokens: off`, `per_ticket_tokens: off`, or `budgets: off` for both. Unlike a cap left unset, `factory validate` accepts it. Without `per_step_tokens` there is no worst case in tokens. A repository's `per_ticket_tokens` still lowers a ticket cap that is `off`, and its `.factory/config.yml` cannot set `off`. `max_turns` keeps the step's own turns, and `on_usage_limit` is no cap of the factory's: the usage limit of the Claude subscription still holds launches until its reset. |
| `max_diff` | **Applied** (ORC-381): only `off` exists. It disables the baseline of `factory/taille-du-diff` (15 files, 400 lines outside tests) in `verify`: a diff is then bounded only where the repository's own `max_diff` sets a bound. Without it, the baseline applies. A repository's `.factory/config.yml` cannot set `off`. |
| `repos` | **`env` and `secrets` applied** (ORC-211), the entry being found through the project's `origin` remote; `secrets` are read at each `setup` (ORC-308, [below](#repository-secrets-orc-308)): see [`repository-configuration.md`](repository-configuration.md#variables-and-secrets). For the rest, `projects[].repoPath` in `config.yaml` remains the working copy as long as the runner does not clone by itself (ORC-204). |
| `audit` | **Applied** (ORC-229): `serious_defect` is the definition of a serious defect, as written (a non-empty text). Absent by default, and until ORC-153 decides it: the defects entered on the audit sheets are kept but none is counted, and the Overview shows the AI reviewers' miss rate as **not counted**, with why ([interface](interface-and-security.md)). Each defect is kept with the definition in force when it was entered; only those entered under the definition in force are counted. It counts from the next startup. |
| `tools` | **Applied** (ORC-383): `per_step` gives an agent step its built-in tools in place of the preset's ([tools per step](preset.md#the-agents-tools-per-step-orc-383)). The daemon refuses to start on a list that gives a step more than it may have: a write tool or a shell to a read-only step (`intake`, `clarify`, `spec_draft`, `review`), `WebFetch` to a step below network `limited`, `WebSearch`, or a tool the factory does not know. A repository's `.factory/config.yml` can only restrict the list. It counts from the next startup, for the tickets that start then. |
| `acknowledge` | **Applied** (ORC-380): `comment` (the default) or `reaction`. With `reaction`, a human message gets 👀 on its Linear comment in place of the ack's comment; a message with no comment to react on, or a reaction Linear refuses, gets the comment, logged. A delegation has no message: it keeps its comment « Got it. ». The session's `thought` stays in both modes. See [`linear.md`](linear.md#triggering). It counts from the next startup. |
| `message_model` | **Applied** (ORC-445): `api_key` is the Messages API key of the small model that classifies human messages, a server secret written as a reference. Used with sandboxes, or on the host without a Claude account; see [`operations.md`](operations.md#the-small-model-of-messages). It counts from the next startup. |
| `statuses` | **Applied** (ORC-382): the Linear status each step shows, by step (`intake`, `spec_draft`, `build`, `review`, `human_review`), in place of ORC-170's (Todo, none, In Progress, AI Review, Human Review). The daemon refuses to start on a step the preset does not have or that shows no status, two steps of one status named differently, or one name for two statuses. `factory doctor` warns of a status the Linear team lacks; « Connect Linear » creates it. See [Linear statuses](preset.md#linear-statuses). It counts from the next startup, for the tickets that start then. |
| `spec` | **Applied** (ORC-382): where a version of the spec is published. `publish`: `comment+doc` (the default) puts it in a comment of the ticket, or, past `threshold` characters (5 000 by default), in a Linear document linked to the ticket with the comment giving its summary and its link; `comment` always in the comment; `doc` always in the document. The session tells the validator where to read it. See [the spec's publication](preset.md#spec_draft-spec_check-and-the-spec_review-gate-orc-212). It counts from the next startup. |
| `read_guard` | **Applied**: `max_lines` (positive integer, 350 without this key) is the number of lines beyond which the pack's hook refuses a full read ([ORC-279](pack-and-skills.md#full-read-of-a-large-file)). It counts from the next startup. |
| `egress` | **Applied** (ORC-370): per run, the egress proxy counts the reads that move a counter anyone can read: the distinct versions of an npm package or a PyPI project it downloads (`max_versions_per_package`, 10 by default) and the release assets of a GitHub repository (`max_assets_per_repo`, 5 by default, whatever their tag). Past the cap, it refuses the read (`403`) and journals it as `suspicious` in the run's security log. A version or an asset read again is not a new one, but its sixth read in a run is refused the same way: each download moves its counter. Only a GET counts. Each key is a positive integer: the caps cannot be turned off, and a repository's `.factory/config.yml` has no key for them. See [the security log](interface-and-security.md#reads-that-move-a-public-counter-orc-370). It counts from the next startup. |

### Repository secrets (ORC-308)

A secret under `repos[].secrets` is a reference `<source>:<path>`. `env` is the default source, built in: `env:NAME` is the daemon's variable `NAME`. Other sources are declared under `secret_sources`, each with the adapter (`kind`) that reads it:

```yaml
secret_sources:
  coffre: { kind: <adapter>, ... }   # the adapter's own options
repos:
  - linear_team: ENG
    github: org/app
    secrets:
      NPM_TOKEN: env:NPM_TOKEN
      DB_SEED_KEY: coffre:kv/app#seed_key
```

**Adapters shipped**: `env`, built in (it is not declared under `secret_sources`), and `systemd-creds` (ORC-398, [below](#server-secrets-orc-398)). No adapter that needs a network credential (a cloud KMS, Vault) before ORC-151 and ORC-179 take `verify` and the runs off the host: their code can read the daemon's environment, and with it a manager's credential, worth far more than one secret. The port and how to add an adapter: [`ports/secret-source.md`](ports/secret-source.md).

- **At startup**, only the syntax is checked: the source is `env` or declared under `secret_sources`, and its adapter accepts the path (for `env`, a variable name). Otherwise the daemon does not start, with the path of the key (`repos[0].secrets.DB_SEED_KEY: its source is neither `env` nor declared under secret_sources`). An unknown `kind`, or options its adapter refuses, are refused the same way. A variable that is not set is **not** refused at startup any more.
- **At each `setup`** that gets the repository's secrets, the daemon reads the values of the names `.factory/config.yml` declares under `setup_secrets`, and of those only, before the setup's container exists. A value shorter than 8 characters is refused there: sealing it would purge every file holding those letters.
- **A source that fails**, a variable not set or a path it does not hold: no setup container is created, the worktree is removed and the ticket is blocked as a launch error, with `The worktree setup failed: the secret DB_SEED_KEY (coffre:kv/app#seed_key) could not be read: <why>`. The message names the reference, never the value. There is no fallback. The reference is told to the ticket as written: a value pasted in place of a variable name (`env:ghp_…`) passes the syntax check and is then shown on the Linear ticket, so check the references before the first launch.
- The values read are sealed as before (ORC-211), with the values of this launch. The `env:` values are masked in the transcripts from the daemon's start, as before; those of another source once a setup read them. The daemon's environment is fixed at its start: an `env:` secret rotated counts after a restart. The journal only receives names, the references included when the ticket is blocked (above).

### Server secrets (ORC-398)

`linear.client_secret`, `linear.webhook_secret`, `github.private_key`, `github.webhook_secret`, `github.client_secret`, `claude.accounts[].token`, `message_model.api_key` (ORC-445) and `secrets_key` are references `<source>:<path>`, like a repository's. `env:NAME` is resolved as before; another source is read **once, at the start**: one that fails, or a credential it does not hold, prevents the start with `the secret github.private_key (creds:github-app-key) could not be read: <why>`, never the value. To keep the GitHub App's key off the disk, use `systemd-creds` ([its options](ports/secret-source.md#systemd-creds)):

```yaml
secret_sources:
  creds: { kind: systemd-creds, store: /etc/credstore.encrypted }
github: { app_id: 123456, private_key: creds:github-app-key, webhook_secret: creds:github-webhook }
secrets_key: creds:factory-secrets-key
```

- Switching sources is a change of `factory.yml`, not of the code. An option of a source written `env:NAME` is resolved at the start and masked.
- A Claude account read from another source than `env` keeps the value read at the start; one added since waits for the next start.
- `factory doctor` says, before the workflows, each server secret in clear (`env`, a GitHub key in `config.yaml` or `GH_APP_KEY`, `secrets.json` without `secrets_key`) and the rotation date of the sealed ones (a warning past 180 days, or when unknown). Never part of its verdict.

`factory.yml` is only ever read: `init` and token writing never copy any of its values into `config.yaml` or `secrets.json`. Its secrets are masked in the runs' transcripts, like those of `secrets.json`.

## What does not leave the daemon

The daemon holds the secrets; Claude Code runs do not need them and must not access them.

1. **Run environment by allowlist (ORC-211).** In a sandbox, a run receives its run variables (`FACTORY_API`, `FACTORY_RUN_TOKEN`, a random token valid during the run, `FACTORY_TICKET`…), the pack hook's settings, without secrets (`FACTORY_READ_MAX_LINES`, `FACTORY_FULL_READ_PATHS`), the variables the repository declares ([`repository-configuration.md`](repository-configuration.md#variables-and-secrets)) and a placeholder as `CLAUDE_CODE_OAUTH_TOKEN`, the egress proxy setting the `claude.active` account's token (without `factory.yml`, the daemon's variable of that name) on the model calls (ORC-337): nothing else, no Anthropic key nor base URL (`ANTHROPIC_*`), no GitHub token. On the host, a run additionally receives the system variables (`PATH`, `HOME`, `LANG`, `TMPDIR`…), the commit identity (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`) and, in transition, an Anthropic API key (see the transition note under [Environment variables](#environment-variables)). Any other variable stays in the daemon.
2. **No Linear for the agent.** The agent never sees the Linear token and reads no ticket: the prompt carries the run's ticket. Its run token opens only the factory MCP (`submit_result`, `kb_search`), for its own run (ORC-192). See [`interface-and-security.md`](interface-and-security.md#factory-mcp).
3. **`run-settings.json`.** On each `factory up`, the factory writes `<FACTORY_HOME>/run-settings.json`: the pack's permissions (`packs/standard/settings.json`) plus refusals on the **real** path of `FACTORY_HOME`: `Read`/`Edit` of `secrets.json`, `Read` of `factory.db*`, `transcripts/**`, `logs/**`, and any Bash command that mentions `secrets.json` or `factory.db`. This file is passed to each run through `--settings` (mounted read-only in a sandbox). The worktrees (`workspaces/`) stay readable.
4. **GitHub App token kept out of runs.** The installation token is requested for the run's repository only, kept in the daemon's memory and never mounted in the runner's environment nor written to a transcript. The factory publishes (ORC-125), and the daemon holds no other GitHub token since ORC-181. See [`github.md`](github.md#tokens).

Known limit: these refusals are Claude Code guardrails, not a security boundary. An agent that executes code (`node`, `npm`) as the same system user as the daemon can read `secrets.json`. Details and consequences: [`interface-and-security.md`](interface-and-security.md#known-limitations).
