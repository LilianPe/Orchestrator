# Deployment

The daemon, `factoryd`, runs continuously to receive webhooks, poll PRs and launch runs. There is a single topology: `docker compose up -d` on a Linux server dedicated to the factory, with a rootless engine. The server itself is the subject of ORC-126.

To work on a workstation, without containers: `factory up` (see [`installation.md`](installation.md)). This is not a production mode.

## The services

| Service | Image | Role | Published |
|---|---|---|---|
| `factoryd` | `Dockerfile` | The daemon. The only one holding the engine socket, with which it creates the runners. Plain HTTP, for the reverse proxy in front of it. | `127.0.0.1:4100` (the host's loopback alone) |
| `proxy` | the same | The runners' egress proxy (`src/network/proxy.ts`, [ORC-213](decisions/ORC-213.md)), in its own process. | no |
| `postgres` | `postgres:16` | The daemon's state. On the internal network only. | no |
| `caddy` | `caddy:2.11.8-alpine` | **Optional**, under the `tls` profile, off by default: TLS for the UI and webhooks, in front of `factoryd`, for a server without a reverse proxy of its own. See [TLS](#tls-and-webhooks). | 80, 443 |

Runners are not services: `factoryd` creates one per attempt, then destroys it. They run with `--network none`; their only way out is their run's socket, served by `proxy`. None receives the engine socket: the provider refuses that mount. The server must be dedicated to the factory: whoever holds this socket holds everything the engine can do.

`proxy` has none of the daemon's secrets. The egress authority's key is held by it alone, in `$FACTORY_DIR/egress-ca`, which `factoryd` does not mount. `factoryd` drives it through a control socket (`data/network/control.sock`), never mounted in a runner. If `proxy` stops, the runs' sockets die with it: `factoryd` sees it, and replaces those containers on their next request. If `factoryd` stops, `proxy` closes its runs, as if it ran in its process.

## TLS and webhooks

Linear and GitHub call the server directly, in HTTPS (ORC-221): `<publicUrl>/webhooks/linear`, `<publicUrl>/webhooks/github`, and Linear's OAuth callback `<publicUrl>/oauth/callback`. The factory itself brings no TLS: `factoryd` listens in plain HTTP, published on the host's loopback alone (`127.0.0.1:${FACTORY_LOOPBACK_PORT:-4100}`; `port` in `config.yaml` stays at 4100, the container's side), and `publicUrl` in `config.yaml` says the public HTTPS URL. A reverse proxy in front of it holds the certificate, by one of two means:

- **the host's reverse proxy** (the default): the server's own nginx, Caddy, Traefik or Apache, the operator's choice, forwards the public name to `http://127.0.0.1:4100`;
- **the `caddy` service** of `compose.yaml`, for a server without one: `docker compose --profile tls up -d` (or `COMPOSE_PROFILES=tls` in `.env`). It takes ports 80 and 443 and a Let's Encrypt certificate for `FACTORY_PUBLIC_HOST` (`docker/Caddyfile`), and refuses to start without it.

What the proxy must do, and nothing more:

- **pass the `Host` on as the client sent it** (the public name, with its port when it is not 443). The interface refuses a write whose `Origin` is not that name (CSRF); the webhooks do not care. Caddy, Traefik and the `tls` profile keep it by default; nginx needs `proxy_set_header Host $http_host;`, Apache `ProxyPreserveHost On`;
- **pass the body as received**, and let it be large: the signatures are checked on its raw bytes, GitHub sends up to 25 MB and a take-over bundle up to 100 MB (nginx refuses above 1 MB by default);
- **not forward `/agent`**: the run-token agent API, which the runners reach through the `proxy` service on port 4101, never through the public name. The examples below and the `tls` profile answer it 404;
- **not buffer the live stream** (`/api/events`, server-sent events, one `ping` every 15 s): nginx needs `proxy_buffering off;`. Caddy flushes it on its own.

`factoryd` reads no `X-Forwarded-*` header: it decides nothing on the client's address or scheme, and `publicUrl` already gives the URLs it hands out. A forged `X-Forwarded-Host` changes nothing. The interface stays behind the GitHub sign-in (ORC-399, [interface and security](interface-and-security.md#network-exposure-and-github-sign-in)); the webhooks, the OAuth callbacks and the agent API answer to their own guards (signatures, `state`, run token).

An nginx on the host, with a certificate from certbot:

```nginx
server {
    listen 443 ssl;
    server_name usine.exemple.fr;
    ssl_certificate     /etc/letsencrypt/live/usine.exemple.fr/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/usine.exemple.fr/privkey.pem;

    client_max_body_size 100m;         # a take-over bundle (ORC-234); GitHub sends up to 25 MB

    location /agent { return 404; }    # the runners' API, never public

    location / {
        proxy_pass http://127.0.0.1:4100;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;
        proxy_buffering off;           # the dashboard's live stream
        proxy_read_timeout 1h;
    }
}
```

Or a Caddy on the host (`/etc/caddy/Caddyfile`), which fetches its certificate itself:

```caddyfile
usine.exemple.fr {
	@agent path /agent /agent/*
	respond @agent 404
	reverse_proxy 127.0.0.1:4100
}
```

Both examples take `127.0.0.1:4100`: the port of `FACTORY_LOOPBACK_PORT` if it is set. To check it: `curl -sS https://usine.exemple.fr/health` answers `{"ok":…,"store":…,"takingTickets":…}` (from `factoryd`, not the proxy: open, the state alone, ORC-405) and `curl -sS https://usine.exemple.fr/api/state` 401 `{"error":"sign in with GitHub first"}`, and the deliveries of a Linear webhook (the application's page) and of a GitHub webhook (the App's *Advanced* tab) show a 200. A 401 there is the signature's (secret, clock), not the proxy's.

**Smee and ngrok are for a workstation only, never the server** (ORC-221): `relay: { kind: none }` in production. The daemon refuses to start a smee relay with `dev: false`, and warns of one without `dev: true`, the development mode `factory init --dev` writes (ORC-444). A smee channel is public, and it relays a re-encoded body ([`linear.md`](linear.md#3-webhooks-production-and-development)).

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

- **`Dockerfile`** (`factoryd` and `proxy`): Node 24, `git` and the `docker` CLI; not the GitHub CLI, since the daemon reads and publishes by its GitHub App alone (ORC-181). Claude Code is no longer in it: the agent runs in the runner. User `node` (uid 1000).
- **`docker/runner.Dockerfile`** (the runners): Node 24 with pnpm, Python 3 with uv and pip, `git`, Claude Code. Pinned versions. No `gh`, no engine CLI, no daemon code.
- **`docker/browser.Dockerfile`** (the visual proof's captures, ORC-404, optional): the runner image plus Playwright (pinned) and its headless Chromium, built `FROM` the runner image so that the application starts with the same tools as its commands. Only the sandboxes that shoot run it, at network `none`, with nothing mounted but the checkout; every other sandbox stays on the runner image, which carries no browser. It weighs about 630 MB more than the runner image, uncompressed (measured on Docker Desktop: the Playwright layer is 626 MB, of which 278 MB of headless Chromium, the rest its system libraries and fonts); a capture at three widths takes about 3 s, the container's start included, for a page served by `node`. Without it, `FACTORY_BROWSER_IMAGE` unset, a required visual proof is unavailable and its check neutral: the daemon says so at its start, and `factory doctor` on every run.

No image receives a secret at build time. Isolation test no. 7 looks for tokens in the history, the configuration and the files of every layer of the runner image.

## Current limits

- **Publishing**: the factory pushes and opens the PR, with the GitHub App (ORC-125, [`github.md`](github.md#publishing)). Without it, a verified ticket is blocked: configure `github.*` or `GH_APP_*`. An agent in a runner has neither `gh` nor a token, and the proxy refuses `git push`. `factoryd` has neither either since ORC-181: the App reads the PRs.
- **`factoryd`'s own `git fetch`** (ORC-442): the image gives git no credential of its own (the GitHub CLI's credential helper went with ORC-181). A private repository's clone under `repos/`, and the knowledge base's, are read with the App's installation token, as the push is, when their `origin` is an `https://github.com/` URL the App is installed on: no SSH key nor credential helper is needed in the container. An `origin` over SSH, or a repository the App is not installed on, is still read with whatever credential the container's git finds; with none, a launch is refused with `the forge could not be read` ([`github.md`](github.md#the-daemons-own-git)).
- **`verify` no longer runs in `factoryd`** (ORC-151): its commands go into a fresh runner, on a clone, at network level `none`. Under compose, `FACTORY_CONTAINER_CLI` is set: a failed engine gives a ticket blocked for infrastructure reasons (`verify.errored`), never a fallback to `factoryd`. `FACTORY_ALLOW_HOST_VERIFY` is not passed through, and would have no effect. **`factoryd`'s `git`, next to the socket, reads nothing an agent wrote** (ORC-317): each agent has its own repository, and the git directory of `repoPath` is never mounted.

## Variables

In a `.env` file next to `compose.yaml` (not versioned). `docker compose` refuses to start if a required variable is missing; `FACTORY_PUBLIC_HOST` excepted, which compose would also ask of a plain `up` without the `tls` profile: missing, `caddy` exits at its start and restarts, the message in `docker compose logs caddy`.

| Variable | Required | Role |
|---|---|---|
| `CLAUDE_TOKEN_1`, `CLAUDE_TOKEN_2` | one at least (or the transition below) | Tokens for the Claude Code accounts, read by `factory.yml` (`token: env:CLAUDE_TOKEN_1`); the `claude.active` account is the runs' only credential. |
| `GH_APP_CLIENT_ID`, `GH_APP_CLIENT_SECRET` | yes, unless `factory.yml` gives `github.client_id` | The GitHub App's OAuth client, for the dashboard's GitHub sign-in (ORC-399): the container listens beyond loopback, and `factoryd` refuses to start without it. |
| `FACTORY_MESSAGE_API_KEY` | no | The Messages API key of the small model of messages, read by `factory.yml` (`message_model: { api_key: env:FACTORY_MESSAGE_API_KEY }`, ORC-445). Without it, the fallback rule classifies human messages ([operations](operations.md#the-small-model-of-messages)). |
| `FACTORY_DIR` | yes | Absolute path on the server (see above). |
| `FACTORY_ENGINE_SOCKET` | yes | Rootless engine socket, for example `/run/user/1000/docker.sock`. |
| `FACTORY_RUNNER_IMAGE` | yes | The runner image, built separately. |
| `FACTORY_BROWSER_IMAGE` | no | The capture image of the visual proof (`docker/browser.Dockerfile`), built on the runner image. Unset, or absent from the engine, the visual proof is unavailable. |
| `FACTORY_LOOPBACK_PORT` | no | Port of `factoryd` on the host's loopback, for its reverse proxy (4100 by default). |
| `FACTORY_PUBLIC_HOST` | with the `tls` profile | Domain of `publicUrl`, for `caddy`'s certificate. |
| `POSTGRES_PASSWORD` | yes | Database password, reused in a URL: letters and digits only. |
| `FACTORY_COMMIT` | no | At build time: the commit, recorded on each attempt. |
| `FACTORY_HTTP_PORT`, `FACTORY_HTTPS_PORT` | no | Ports published by `caddy`, under the `tls` profile (80 and 443 by default). |
| `FACTORY_ALLOW_ROOTFUL_ENGINE` | no | `1`: allows starting on an engine that is not rootless. For a development workstation, never for the server. |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | no | Commit identity (the product name and `factory@localhost` by default); compose copies them into `GIT_COMMITTER_*`. |

> **Transition note**: compose still passes `ANTHROPIC_API_KEY` through: Claude Code authentication without an active account, for the runs of this container that still run next to the daemon (until ORC-179). Compose does not require it, nor the tokens above: without any, runs fail at authentication.

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
   ```

   ```yaml
   # data/factory.yml: one ticket at a time to start with
   concurrency: 1
   # who may sign in to the dashboard with GitHub (ORC-399): logins, or an org, or a team
   dashboard: { logins: [armand] }
   # the key of secrets.json at rest (ORC-398), required off the loopback: FACTORY_SECRETS_KEY in .env, `openssl rand -base64 32`
   secrets_key: env:FACTORY_SECRETS_KEY
   ```

   **Upgrading an exposed server (ORC-398).** Without `secrets_key`, `factoryd` no longer starts off the loopback: add `FACTORY_SECRETS_KEY` to `.env` and the line above to `data/factory.yml`. At its next start, it encrypts `secrets.json` in place. Keep the key: without it, the Linear tokens are lost (reconnect Linear).

   The App's *Callback URL* is `https://usine.exemple.fr/auth/github/callback` ([`github.md`](github.md#creating-the-app)).

   Then give it all to the containers' uid 1000. In a rootless engine, this is a sub-uid of the user, not the user: only a container can do it. From then on, these directories are only modified from a container (`docker compose exec factoryd ...`).

   ```bash
   docker run --rm -v "$FACTORY_DIR:/base" node:24.22.1-bookworm-slim chown -R 1000:1000 /base
   docker run --rm -v "$FACTORY_DIR:/base" node:24.22.1-bookworm-slim chmod 600 /base/data/secrets.json
   ```

3. Build the images, one after the other (the runner image needs BuildKit, Docker's default builder, or Podman):

   ```bash
   docker build -f docker/runner.Dockerfile -t "$FACTORY_RUNNER_IMAGE" docker
   FACTORY_COMMIT="$(git rev-parse HEAD)" docker compose build
   ```

   For the visual proof, the capture image too, on the runner image just built, then `FACTORY_BROWSER_IMAGE` in `.env`:

   ```bash
   docker build -f docker/browser.Dockerfile --build-arg RUNNER_IMAGE="$FACTORY_RUNNER_IMAGE" -t "$FACTORY_BROWSER_IMAGE" docker
   ```

4. Point the host's reverse proxy at `http://127.0.0.1:4100`, or the port of `FACTORY_LOOPBACK_PORT` ([TLS](#tls-and-webhooks)), then `docker compose up -d`. Without a reverse proxy on the server: `docker compose --profile tls up -d`, with `FACTORY_PUBLIC_HOST`.
5. Open `https://usine.exemple.fr`, sign in with GitHub (a login of `dashboard`), click **Connect Linear**.

`factoryd` refuses to start on an engine that is not rootless: holding its socket would give root on the host.

Operations commands are run in the container, on the server (over SSH from elsewhere): they go through the daemon's socket `cli/factory.sock` in `FACTORY_DIR/data`, as `node`, with no GitHub sign-in (ORC-405):

```bash
docker compose exec factoryd node dist/src/cli/factory.js status
docker compose exec factoryd node dist/src/cli/factory.js pause
docker compose logs -f factoryd
```

`factory doctor` runs there too, on the clone `config.yaml` names, before a repository is entrusted to the factory: it asks the engine through the same socket ([`github.md`](github.md#factory-doctor-host-branch-protection-ci-secrets-and-factory-branches)):

```bash
docker compose exec factoryd node dist/src/cli/factory.js doctor /srv/factory/repos/mon-app
```

Acceptance run: [`acceptance.md`](acceptance.md#8-docker-criterion-8).

## What is only proven on the server

The stack ran once under Docker Desktop, which is not rootless. These points remain to be checked by the acceptance run, on the server (ORC-126):

- starting on a rootless engine (detection looks for `rootless` in `docker info`);
- uid 1000's access to the rootless socket through its group 0 (`group_add`);
- owners under the sub-uids: `factoryd`, `proxy` and the runners under the same uid, a run socket in `0600` opened by the runner;
- preparing the directories above;
- `factoryd` published on the host's loopback by a rootless engine, and a webhook of Linear and of GitHub arriving through the host's reverse proxy;
- under the `tls` profile, `caddy` on ports 80 and 443: a rootless engine only publishes below 1024 with `net.ipv4.ip_unprivileged_port_start=80`;
- a real certificate, and process, memory and CPU limits (cgroup v2, `loginctl enable-linger`);
- Podman behind the `docker` CLI: nothing has been measured, the deployment targets rootless Docker.

## Clean shutdown and restart

`SIGTERM` (`docker compose stop`) triggers a clean shutdown: timers and reconciliation are stopped; the runs in progress are **left running** (ORC-344): the daemon stops reading them, without stopping their agent, destroying their container or writing anything of them, then waits for what it still has to write (the inbox, a run that ended just before), closes the SSE connections and the database. `compose.yaml` gives it 30 s (`stop_grace_period`), which it no longer spends waiting for agents.

On the next start, the factory resumes on its own whatever was cut off (by a shutdown or a crash), the same way for both: it reattaches to a run still alive (or ended meanwhile with its result line), whose real result comes back, and starts again the step of one that vanished. No ticket is blocked because of it; details in [`operations.md`](operations.md#shutdown-restart-and-interrupted-runs). Queued requests, timers (grouped feedback) and the pause state are kept in the database (`factory.db` outside compose).

Under compose, this state is in Postgres, not in a file.

## Updating

```bash
git pull
docker build -f docker/runner.Dockerfile -t "$FACTORY_RUNNER_IMAGE" docker
# With the visual proof: the capture image again, on the new runner image.
docker build -f docker/browser.Dockerfile --build-arg RUNNER_IMAGE="$FACTORY_RUNNER_IMAGE" -t "$FACTORY_BROWSER_IMAGE" docker
FACTORY_COMMIT="$(git rev-parse HEAD)" docker compose build
docker compose up -d
```

Each image has its copy of the installation in `$FACTORY_DIR/install`. The old ones remain, since a container may still be running from one of them: remove them by hand once the update is done. `run-settings.json` is regenerated at startup.

**When moving to ORC-317:** workspaces become separate repositories. A ticket whose directory is still a `git worktree` is refused at launch (« is not the one the factory created »): delete `workspaces/<project>/<ticket>/` and `workspaces/<project>/_trunk/`, then `git -C <repoPath> worktree prune`. An unpushed commit there would be lost: push it first, by hand. And an agent may have written into the git directory of a repository already entrusted to the factory: check its `config`, its `hooks/` and `info/attributes`, or better, reclone it. The fix protects against what an agent will write, not against what it has already left behind.

**When moving to ORC-341:** a new workspace takes only an allow list of the repository's git config, its remote URL without credentials. A workspace made before keeps the config it was given, a token in `remote.origin.url` or an extraheader included, for as long as it exists: delete `workspaces/<project>/<ticket>/` once its commits are pushed, and the next launch recreates it. A credential that has already reached an agent should be revoked.
