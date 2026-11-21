# Installation

This page covers installing the factory on a machine (dev workstation or server without Docker). For Docker, see [`deployment.md`](deployment.md).

To take a first real ticket from delegation to its PR on your machine, follow [`first-run.md`](first-run.md): it starts with what to create (GitHub App, Linear application, Claude token, Podman, validators) and goes through `factory init`, `factory doctor` and `factory up`.

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | **24.22.1 or later** (`engines.node: ">=24.22.1"`) | The daemon uses `node:sqlite`, built into Node 24; 24.22.1 is the patched minimum from the October 2026 security release. |
| npm | the one shipped with Node 24 | Install and build. |
| git | recent (worktrees) | One git worktree per ticket. |
| A GitHub App | installed on the repository ([`github.md`](github.md#creating-the-app)) | The daemon reads and publishes on GitHub by its App alone: the `gh` CLI is no longer used (ORC-181). |
| Claude Code CLI `claude` | logged in (subscription; a run gets the token of `claude.active` in `factory.yml`, else the daemon's `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`) | Each run is a `claude -p … --output-format stream-json`. It must be on the daemon's `PATH`. |
| bash | — | The `setup` and `verify` commands of `.factory/config.yml` are run via `bash -c`, without a login profile: the `PATH` is the daemon's (or the sandbox image's). A tool that only your profile puts on the `PATH` (nvm, asdf, volta, `~/.local/bin`) must be on the daemon's: `Environment=PATH=…` in the systemd unit, for example. |

> **Transition note**: until the runs on the host go (ORC-179), `claude` on the host also logs in with an `ANTHROPIC_API_KEY` from the daemon's environment, when neither `factory.yml` nor `CLAUDE_CODE_OAUTH_TOKEN` gives a Claude token.

On the services side: a Linear workspace you are an admin of (to create the OAuth application, see [`linear.md`](linear.md)) and a GitHub repository cloned locally.

The exact Claude Code version is not pinned by the factory. It must accept the options used by the runner: `--output-format stream-json`, `--verbose`, `--session-id`, `--resume`, `--model`, `--plugin-dir`, `--settings`, `--setting-sources`, `--effort`, `--strict-mcp-config`, `--mcp-config`, `--permission-mode plan` and `--tools` (the AI review's `Read,Grep,Glob`, ORC-183). The acceptance run ([`acceptance.md`](acceptance.md), "Points to check") lists what to check on the installed version.

## Installing the factory

```bash
git clone https://github.com/LilianPe/Orchestrator.git && cd Orchestrator
npm ci
npm run build      # compiles dist/ and the web UI web/dist
npm link           # makes `factory` available on the PATH
```

`npm link` exposes the executable declared in `package.json` (`bin/factory`). This script runs `dist/src/cli/*.js` if it exists, otherwise the TypeScript sources via `tsx`: without `npm run build`, the CLI works but the web UI is not served (the `web/dist` directory is missing).

Check:

```bash
factory           # prints the help (exit code 1, this is normal)
```

## Configuring a first repository

```bash
cd <your repository>
factory init         # on a workstation without a public URL: factory init --dev (a smee.io relay for Linear's webhooks)
```

The wizard is described in [`cli.md`](cli.md#factory-init) and creating the Linear application in [`linear.md`](linear.md); the whole first run, step by step, in [`first-run.md`](first-run.md). Then:

```bash
factory up                # http://localhost:4100, then « Connect Linear »
```

To explore the UI without Linear or Claude: `factory up --fake-runner` (runs are simulated and cost nothing).

## The daemon's home directory

All of the instance's state lives in **`FACTORY_HOME`**, by default `~/.factory` (`$HOME/.factory`). Change it with the `FACTORY_HOME` environment variable (the Docker image defaults to `/data`, compose sets `${FACTORY_DIR}/data`, see [`deployment.md`](deployment.md)).

| Path | Contents | Sensitive |
|---|---|---|
| `config.yaml` | Instance configuration: port, host, projects, webhook relay, budget, knowledge base. See [`configuration.md`](configuration.md). | no |
| `secrets.json` | Linear credentials and tokens. Written with mode `0600`. On Windows, which has no POSIX mode, the file inherits the permissions (ACL) of its directory: put `FACTORY_HOME` in a directory that only the factory's user can read (the user profile is, by default). | **yes** |
| `factory.yml` | GitHub App, Claude token, budgets, every secret as an `env:` reference, never a value ([`configuration.md`](configuration.md)). Written by the first `factory init`. | no (references only) |
| `run-settings.json` | Claude Code permissions passed to each run (`--settings`), regenerated on each `factory up`. | no |
| `factory.db` | SQLite database: tracked tickets, events, runs, costs, queue, timers. Absent when `FACTORY_DATABASE_URL` points to a Postgres database ([`configuration.md`](configuration.md#environment-variables)). | yes (contains the history) |
| `transcripts/<runId>.jsonl` | `stream-json` output of each run, secrets masked, deleted 30 days after its last write ([`operations.md`](operations.md#logs-transcripts-and-data)). | yes (code, ticket contents) |
| `workspaces/<project>/<ticket>/` | Git worktree of each ticket in progress. | — |
| `workspaces/<project>/_trunk/<runId>/` | Detached copy of the main branch, one per read-only question, deleted when it ends. | — |
| `logs/` | Created at startup but not used yet: the daemon's logs go to standard output. | — |

Backing up an instance = backing up `config.yaml`, `secrets.json`, `factory.yml` and `factory.db` (or the Postgres database, with `pg_dump`, when `FACTORY_DATABASE_URL` is set). Worktrees are recreated from the pushed branches.

## Uninstalling

`npm unlink -g factory` removes the command. Deleting `FACTORY_HOME` erases the local state (branches, PRs and tickets remain in GitHub and Linear). Remember to delete the OAuth application in Linear.
