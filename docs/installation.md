# Installation

This page covers installing the factory on a machine (dev workstation or server without Docker). For Docker, see [`deployment.md`](deployment.md).

To take a first real ticket from delegation to its PR on your machine, follow [`first-run.md`](first-run.md): it starts with what to create (GitHub App, Linear application, Claude token, Podman, validators) and goes through `factory init`, `factory doctor` and `factory up`.

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | **24.22.1 or later** (`engines.node: ">=24.22.1"`) | 24.22.1 is the patched minimum from the October 2026 security release. |
| npm | the one shipped with Node 24 | Install and build. |
| git | recent (worktrees) | One git worktree per ticket. |
| A GitHub App | installed on the repository ([`github.md`](github.md#creating-the-app)) | The daemon reads and publishes on GitHub by its App alone: the `gh` CLI is no longer used (ORC-181). |
| Podman, rootless (or Docker) | with cgroup v2 ([`first-run.md`](first-run.md)) | Every run, its `setup` and `verify` execute in a disposable container of the runner image (`FACTORY_CONTAINER_CLI`, `FACTORY_RUNNER_IMAGE`): `factory up` refuses to start without them, no run executes on the host (ORC-179). |
| A Claude token | from `claude setup-token` (subscription): `claude.active` in `factory.yml`, else the daemon's `CLAUDE_CODE_OAUTH_TOKEN` | Each run is a `claude -p … --output-format stream-json` in its sandbox, `claude` being the runner image's; the egress proxy sets the token on its model calls (ORC-337). No `claude` is needed on the daemon's `PATH`. |
| bash | — | The `setup` and `verify` commands of `.factory/config.yml` are run via `bash -c` in the sandbox, without a login profile: the `PATH` is the runner image's. |

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
| `factory.yml` | The instance (port, host, public URL, projects, webhook relay, knowledge base), the GitHub App, Claude token, budgets, every secret as a reference, never a value ([`configuration.md`](configuration.md)). **Required**: the daemon refuses to start without it. Written by `factory init`, which keeps the rest of an existing file. | no (references only) |
| `secrets.json` | Linear's OAuth tokens, which the daemon writes, and the credentials `factory init` asks; encrypted at rest with `secrets_key` (ORC-398), never written in clear (ORC-470). Written with mode `0600`. On Windows, which has no POSIX mode, the file inherits the permissions (ACL) of its directory: put `FACTORY_HOME` in a directory that only the factory's user can read (the user profile is, by default). | **yes** |
| `secrets.key` | On a workstation, the `secrets_key` `factory init --dev` drew (ORC-470), which encrypts `secrets.json`; mode `0600`, never printed, declared in `factory.yml` as a `file` source ([`configuration.md`](configuration.md#the-key-of-a-workstation-orc-470)). A server keeps its key in a sealed source instead. | **yes** |
| `transcripts/<runId>.jsonl` | `stream-json` output of each run, secrets masked, deleted 30 days after its last write ([`operations.md`](operations.md#logs-transcripts-and-data)). | yes (code, ticket contents) |
| `workspaces/<project>/<ticket>/` | Git worktree of each ticket in progress. | — |
| `workspaces/<project>/_trunk/<runId>/` | Detached copy of the main branch, one per read-only question, deleted when it ends. | — |

The daemon's logs go to standard output. `config.yaml`, `run-settings.json` and `logs/` are gone (ORC-199): left by an older install, they are never read, and the start and `factory doctor` name each one to delete. Nothing of `config.yaml` is migrated: its keys are written in `factory.yml` ([`configuration.md`](configuration.md#the-instance-in-factoryyml-orc-199)).

Backing up an instance = backing up `factory.yml`, `secrets.json` (and the key that opens it: `secrets.key` on a workstation, ORC-470) and the Postgres database of `FACTORY_DATABASE_URL` (`pg_dump`): the factory keeps its state nowhere else (ORC-178). A SQLite database file left from before Postgres is archived then deleted ([`operations.md`](operations.md#archiving-the-sqlite-data-orc-178)). Worktrees are recreated from the pushed branches.

## Uninstalling

`npm unlink -g factory` removes the command. Deleting `FACTORY_HOME` erases the local state (branches, PRs and tickets remain in GitHub and Linear). Remember to delete the OAuth application in Linear.
