# Deployment

The daemon, `factoryd`, runs continuously to receive webhooks, poll PRs and launch runs. There is a single topology: `docker compose up -d` on a Linux server dedicated to the factory, with a rootless engine. The server itself is the subject of ORC-126.

To work on a workstation, without containers: `factory up` (see [`installation.md`](installation.md)). This is not a production mode.

## The services

| Service | Image | Role | Published |
|---|---|---|---|
| `factoryd` | `Dockerfile` | The daemon. The only one holding the engine socket, with which it creates the runners. | no |
| `proxy` | the same | The runners' egress proxy (`src/network/proxy.ts`, [ORC-213](decisions/ORC-213.md)), in its own process. | no |
| `postgres` | `postgres:16` | The daemon's state. On the internal network only. | no |
| `caddy` | `caddy:2.11.8-alpine` | TLS for the UI and webhooks, in front of `factoryd`. Production exposure is the subject of ORC-221. | 80, 443 |

Runners are not services: `factoryd` creates one per attempt, then destroys it. They run with `--network none`; their only way out is their run's socket, served by `proxy`. None receives the engine socket: the provider refuses that mount. The server must be dedicated to the factory: whoever holds this socket holds everything the engine can do.

`proxy` has none of the daemon's secrets. The egress authority's key is held by it alone, in `$FACTORY_DIR/egress-ca`, which `factoryd` does not mount. `factoryd` drives it through a control socket (`data/network/control.sock`), never mounted in a runner. If `proxy` stops, the runs' sockets die with it: `factoryd` sees it, and replaces those containers on their next request. If `factoryd` stops, `proxy` closes its runs, as if it ran in its process.

## Why the same paths on both sides

The engine reads a mount's paths **on the host**, not in the `factoryd` container. Three consequences:

- `$FACTORY_DIR` is an absolute path, mounted at the same place in the container.
- The paths in `config.yaml` are those paths (`repoPath: /srv/factory/repos/mon-app`, written in full).
- The factory's installation, which each runner mounts read-only, only exists in the image. At startup, `docker/entrypoint.sh` copies it into `$FACTORY_DIR/install/<fingerprint>`, once per image, and launches the daemon from that copy.

| Directory | Contents | Mounted by |
|---|---|---|
| `data` | `FACTORY_HOME`: `config.yaml`, `factory.yml`, `secrets.json`, transcripts, worktrees | `factoryd` |
| `data/network` | Run sockets and logs, control socket | `factoryd`, `proxy` |
| `repos` | The repository clones, over HTTPS | `factoryd` |
| `install` | The copy of the installation | `factoryd` |
| `egress-ca` | The egress authority, including its key | `proxy` |

## The images

- **`Dockerfile`** (`factoryd` and `proxy`): Node 24, `git`, the `docker` CLI and `gh`. `gh` stays until ORC-181. Claude Code is no longer in it: the agent runs in the runner. User `node` (uid 1000).
- **`docker/runner.Dockerfile`** (the runners): Node 24 with pnpm, Python 3 with uv and pip, `git`, Claude Code. Pinned versions. No `gh`, no engine CLI, no daemon code.

No image receives a secret at build time. Isolation test no. 7 looks for tokens in the history, the configuration and the files of every layer of the runner image.

## Current limits

- **Publishing**: the factory pushes and opens the PR, with the GitHub App (ORC-125, [`github.md`](github.md#publishing)). Without it, a verified ticket is blocked: configure `github.*` or `GH_APP_*`. An agent in a runner has neither `gh` nor a token, and the proxy refuses `git push`. `GH_TOKEN` only serves `factoryd`, until ORC-181.
- **`verify` no longer runs in `factoryd`** (ORC-151): its commands go into a fresh runner, on a clone, at network level `none`. Under compose, `FACTORY_CONTAINER_CLI` is set: a failed engine gives a ticket blocked for infrastructure reasons (`verify.errored`), never a fallback to `factoryd`. `FACTORY_ALLOW_HOST_VERIFY` is not passed through, and would have no effect. **`factoryd`'s `git`, next to the socket, reads nothing an agent wrote** (ORC-317): each agent has its own repository, and the git directory of `repoPath` is never mounted.

## Variables

In a `.env` file next to `compose.yaml` (not versioned). `docker compose` refuses to start if a required variable is missing.

| Variable | Required | Role |
|---|---|---|
| `CLAUDE_TOKEN_1`, `CLAUDE_TOKEN_2` | one of these means | Tokens for the Claude Code accounts, read by `factory.yml` (`token: env:CLAUDE_TOKEN_1`); the `claude.active` account is the runs' only credential. |
| `ANTHROPIC_API_KEY` | one of these means | Claude Code authentication without an active account, for the runs of this container, which still run next to the daemon (until ORC-179). Compose no longer requires it: without either, runs fail at authentication. |
| `GH_TOKEN` | yes | `gh` and HTTPS reads, until ORC-181; publishing goes through the GitHub App. Permissions: [`github.md`](github.md#permissions-required-for-the-gh-fallback). |
| `FACTORY_UI_PASSWORD` | yes | UI password (the container listens beyond loopback). |
| `FACTORY_DIR` | yes | Absolute path on the server (see above). |
| `FACTORY_ENGINE_SOCKET` | yes | Rootless engine socket, for example `/run/user/1000/docker.sock`. |
| `FACTORY_RUNNER_IMAGE` | yes | The runner image, built separately. |
| `FACTORY_PUBLIC_HOST` | yes | Domain of `publicUrl`, for `caddy`'s certificate. |
| `POSTGRES_PASSWORD` | yes | Database password, reused in a URL: letters and digits only. |
| `FACTORY_COMMIT` | no | At build time: the commit, recorded on each attempt. |
| `FACTORY_HTTP_PORT`, `FACTORY_HTTPS_PORT` | no | Ports published by `caddy` (80 and 443 by default). |
| `FACTORY_ALLOW_ROOTFUL_ENGINE` | no | `1`: allows starting on an engine that is not rootless. For a development workstation, never for the server. |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | no | Commit identity (the product name and `factory@localhost` by default); compose copies them into `GIT_COMMITTER_*`. |

GitHub webhooks read `github.webhookSecret` in `config.yaml` or `factory.yml` ([`github.md`](github.md#github-webhooks)): `compose.yaml` does not pass `GH_WEBHOOK_SECRET` through.

## First start

On the server, with the user's rootless engine running:

1. Write `.env`, create `$FACTORY_DIR` and its directories:

   ```bash
   . ./.env
   mkdir -p "$FACTORY_DIR"/data/network "$FACTORY_DIR"/repos "$FACTORY_DIR"/install "$FACTORY_DIR"/egress-ca
   ```

2. Clone the repositories into `repos/` (over HTTPS), create the Linear application with URLs based on `publicUrl` ([`linear.md`](linear.md)), and write `data/secrets.json` (`clientId`, `clientSecret`, `webhookSecret`, format: [`configuration.md`](configuration.md#secretsjson)), `data/config.yaml` and `data/factory.yml`:

   ```yaml
   # data/config.yaml, with FACTORY_DIR=/srv/factory
   host: 0.0.0.0
   publicUrl: https://usine.exemple.fr
   relay: { kind: none }
   projects:
     - { id: mon-app, repoPath: /srv/factory/repos/mon-app, linearTeamKey: APP }
   limits: { perDayUsd: 40 }
   ```

   ```yaml
   # data/factory.yml: one ticket at a time to start with
   concurrency: 1
   ```

   Then give it all to the containers' uid 1000. In a rootless engine, this is a sub-uid of the user, not the user: only a container can do it. From then on, these directories are only modified from a container (`docker compose exec factoryd ...`).

   ```bash
   docker run --rm -v "$FACTORY_DIR:/base" node:24.22.1-bookworm-slim chown -R 1000:1000 /base
   docker run --rm -v "$FACTORY_DIR:/base" node:24.22.1-bookworm-slim chmod 600 /base/data/secrets.json
   ```

3. Build the images, one after the other:

   ```bash
   docker build -f docker/runner.Dockerfile -t "$FACTORY_RUNNER_IMAGE" docker
   FACTORY_COMMIT="$(git rev-parse HEAD)" docker compose build
   ```

4. `docker compose up -d`.
5. Open `https://usine.exemple.fr` (password `FACTORY_UI_PASSWORD`), click **Connect Linear**.

`factoryd` refuses to start on an engine that is not rootless: holding its socket would give root on the host.

Operations commands are run in the container:

```bash
docker compose exec factoryd node dist/src/cli/factory.js status
docker compose exec factoryd node dist/src/cli/factory.js pause
docker compose logs -f factoryd
```

Acceptance run: [`acceptance.md`](acceptance.md#8-docker-criterion-8).

## What is only proven on the server

The stack ran once under Docker Desktop, which is not rootless. These points remain to be checked by the acceptance run, on the server (ORC-126):

- starting on a rootless engine (detection looks for `rootless` in `docker info`);
- uid 1000's access to the rootless socket through its group 0 (`group_add`);
- owners under the sub-uids: `factoryd`, `proxy` and the runners under the same uid, a run socket in `0600` opened by the runner;
- preparing the directories above;
- `caddy` on ports 80 and 443: a rootless engine only publishes below 1024 with `net.ipv4.ip_unprivileged_port_start=80`;
- a real certificate, and process, memory and CPU limits (cgroup v2, `loginctl enable-linger`);
- Podman behind the `docker` CLI: nothing has been measured, the deployment targets rootless Docker.

## Clean shutdown and restart

`SIGTERM` (`docker compose stop`) triggers a clean shutdown: timers, PR polling and reconciliation are stopped; each run in progress receives SIGINT (SIGKILL after 10 s) and is recorded as **interrupted**; the daemon waits for these runs to end, closes the SSE connections and the database. `compose.yaml` gives it 30 s (`stop_grace_period`).

On the next start, Relais resumes on its own whatever was cut off (by a shutdown or a crash): no ticket is blocked because of it; details in [`operations.md`](operations.md#shutdown-restart-and-interrupted-runs). Queued requests, timers (grouped feedback) and the pause state are kept in `relais.db`.

Under compose, this state is in Postgres, not in a file.

## Updating

```bash
git pull
docker build -f docker/runner.Dockerfile -t "$FACTORY_RUNNER_IMAGE" docker
FACTORY_COMMIT="$(git rev-parse HEAD)" docker compose build
docker compose up -d
```

Each image has its copy of the installation in `$FACTORY_DIR/install`. The old ones remain, since a container may still be running from one of them: remove them by hand once the update is done. `run-settings.json` is regenerated at startup.

**When moving to ORC-317:** workspaces become separate repositories. A ticket whose directory is still a `git worktree` is refused at launch (« is not the one the factory created »): delete `workspaces/<project>/<ticket>/` and `workspaces/<project>/_trunk/`, then `git -C <repoPath> worktree prune`. An unpushed commit there would be lost: push it first, by hand. And an agent may have written into the git directory of a repository already entrusted to the factory: check its `config`, its `hooks/` and `info/attributes`, or better, reclone it. The fix protects against what an agent will write, not against what it has already left behind.

**When moving to ORC-341:** a new workspace takes only an allow list of the repository's git config, its remote URL without credentials. A workspace made before keeps the config it was given, a token in `remote.origin.url` or an extraheader included, for as long as it exists: delete `workspaces/<project>/<ticket>/` once its commits are pushed, and the next launch recreates it. A credential that has already reached an agent should be revoked.
