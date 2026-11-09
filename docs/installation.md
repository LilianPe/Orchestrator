# Installation

This page covers installing Relais on a machine (dev workstation or server without Docker). For Docker, see [`deployment.md`](deployment.md).

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | **24.22.1 or later** (`engines.node: ">=24.22.1"`) | The daemon uses `node:sqlite`, built into Node 24; 24.22.1 is the patched minimum from the October 2026 security release. |
| npm | the one shipped with Node 24 | Install and build. |
| git | recent (worktrees) | One git worktree per ticket. |
| GitHub CLI `gh` | **2.50 or later**, logged in (`gh auth login`) | Without a GitHub App, Relais reads through `gh pr …`, `gh api graphql`; pushing and opening PRs requires the GitHub App. Relais reads a PR's checks through `gh pr checks --json`, which appeared in 2.50: before that, it cannot read any open PR (the `gh` in the Ubuntu 24.04 repositories is 2.45, take the one from [cli.github.com](https://github.com/cli/cli/blob/trunk/docs/install_linux.md)). See [`github.md`](github.md). |
| Claude Code CLI `claude` | logged in (subscription or `ANTHROPIC_API_KEY`) | Each run is a `claude -p … --output-format stream-json`. It must be on the daemon's `PATH`. |
| bash | — | The `workspace.setup` and `verify` commands are run via `bash -c`, without a login profile: the `PATH` is the daemon's (or the sandbox image's). A tool that only your profile puts on the `PATH` (nvm, asdf, volta, `~/.local/bin`) must be on the daemon's: `Environment=PATH=…` in the systemd unit, for example. |

On the services side: a Linear workspace you are an admin of (to create the OAuth application, see [`linear.md`](linear.md)) and a GitHub repository cloned locally.

The exact Claude Code version is not pinned by Relais. It must accept the options used by the runner: `--output-format stream-json`, `--verbose`, `--session-id`, `--resume`, `--model`, `--plugin-dir`, `--settings`, `--setting-sources`, `--effort`, `--strict-mcp-config`, `--mcp-config`, `--permission-mode plan` and `--tools` (the AI review's `Read,Grep,Glob`, ORC-183). The acceptance run ([`acceptance.md`](acceptance.md), "Points to check") lists what to check on the installed version.

## Installing Relais

```bash
git clone <relais repository url> && cd relais
npm ci
npm run build      # compiles dist/ and the web UI web/dist
npm link           # makes `relais` and `relais-agent` available on the PATH
```

`npm link` exposes the two executables declared in `package.json` (`bin/relais`, `bin/relais-agent`). These scripts run `dist/src/cli/*.js` if it exists, otherwise the TypeScript sources via `tsx`: without `npm run build`, the CLI works but the web UI is not served (the `web/dist` directory is missing).

Check:

```bash
relais            # prints the help (exit code 1, this is normal)
```

## Configuring a first repository

```bash
cd <your repository>
relais init
```

The wizard is described in [`cli.md`](cli.md#relais-init) and creating the Linear application in [`linear.md`](linear.md). Then:

```bash
relais up                 # http://localhost:4100, then « Connect Linear »
```

To explore the UI without Linear or Claude: `relais up --fake-runner` (runs are simulated and cost nothing).

## The daemon's home directory

All of the instance's state lives in **`RELAIS_HOME`**, by default `~/.relais` (`$HOME/.relais`). Change it with the `RELAIS_HOME` environment variable (the Docker container uses `/data`).

| Path | Contents | Sensitive |
|---|---|---|
| `config.yaml` | Instance configuration: port, host, projects, webhook relay, budget, knowledge base. See [`configuration.md`](configuration.md). | no |
| `secrets.json` | Linear credentials and tokens. Written with mode `0600`. On Windows, which has no POSIX mode, the file inherits the permissions (ACL) of its directory: put `FACTORY_HOME` in a directory that only the factory's user can read (the user profile is, by default). | **yes** |
| `run-settings.json` | Claude Code permissions passed to each run (`--settings`), regenerated on each `relais up`. | no |
| `relais.db` | SQLite database: tracked tickets, events, runs, costs, queue, timers. Absent when `FACTORY_DATABASE_URL` points to a Postgres database ([`configuration.md`](configuration.md#environment-variables)). | yes (contains the history) |
| `transcripts/<runId>.jsonl` | `stream-json` output of each run, secrets masked, deleted 30 days after its last write ([`operations.md`](operations.md#logs-transcripts-and-data)). | yes (code, ticket contents) |
| `workspaces/<project>/<ticket>/` | Git worktree of each ticket in progress. | — |
| `workspaces/<project>/_trunk/<runId>/` | Detached copy of the main branch, one per read-only question, deleted when it ends. | — |
| `workspaces/_kb/<runId>/` | Worktrees of the knowledge repository for `learn` / `remember` runs. | — |
| `logs/` | Created at startup but not used yet: the daemon's logs go to standard output. | — |
| `knowledge/` | Location targeted by `relais init` for the knowledge repository (see [`projects-and-workspaces.md`](projects-and-workspaces.md#shared-knowledge-base)). | — |

Backing up an instance = backing up `config.yaml`, `secrets.json` and `relais.db` (or the Postgres database, with `pg_dump`, when `FACTORY_DATABASE_URL` is set). Worktrees are recreated from the pushed branches.

## Uninstalling

`npm unlink -g relais` removes the commands. Deleting `RELAIS_HOME` erases the local state (branches, PRs and tickets remain in GitHub and Linear). Remember to delete the OAuth application in Linear.
