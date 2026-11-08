# Web interface and security

## The interface

`relais up` serves a web interface at `http://localhost:<port>` (4100 by default). It requires `npm run build` (`web/dist` folder); without it, only the API and webhooks respond.

What it shows, live:

- **Header**: « Slots » (occupied `dev` slots out of the total), « Questions » (occupied `questions` slots), « Queue » (queue length), « Today's cost » with the budget, the « live » indicator; the **Connect Linear** button (as long as Linear is not connected) and **Pause / Resume**.
- **Flow** (ORC-297), read from `GET /api/flow` on opening, on every ticket change and every 10 s:
  - **Needs you**: what is waiting for a human. Blocked tickets, grouped by cause (agent question, contested ticket, unverified red, infrastructure failure, cap, loop, failed run, pickup refused, event set aside, PR closed without merge, stop, other cause), each with its reason; PRs in Human Review; pending gates (`ready`, for a workflow that still declares it; the spec gate will come with ORC-212). Oldest first, by the ticket's last activity. A PR the agent is still working on, or whose run is waiting for a slot, is not there; a question asked to the agent leaves it there. A blocked ticket whose run is still running appears in both places.
  - **Working**: every run in progress and every verification in progress, with its step (the run's job), its duration and the ticket's tokens; **Stop** button on a ticket's active run. Clicking an identifier opens its run. Queued tickets are listed below.
  - **Done**: finished tickets whose last activity is less than 7 days old, 20 at most, then the other unfinished tickets, collapsed (**Other tracked tickets**).
- **Live session**: the output of the selected run (text, tool calls), received live since the page was opened. A run's full transcript remains available via the API (`/api/runs/<id>/transcript`) and in `<RELAIS_HOME>/transcripts/`.
- **Log**: the daemon's latest messages and the events received.

Live updates go through an **SSE** stream (`GET /api/events`) with a `ping` every 15 s.

Interface development: `npm run dev:web` starts Vite on port 5173 with a proxy from `/api` and `/oauth` to `http://127.0.0.1:4100` (a `relais up` must be running).

**The Flow's tokens** are ORC-235's measurement: the sum of the ticket's finished attempts. A run only reports its usage when it ends: the one in progress is not included yet, which the page states below the table. `≥` indicates finished attempts without a measurement; `—` that none has one, with the cost in dollars if it exists, until ORC-216; `?` that the ticket's measurements could not be read (the error is in the log). If reading the Flow fails, a banner says so and the durations stop. The displayed number adds up input, output, cache read and cache write; the breakdown is shown on hover.

**The cause of a block** is read from its reason (`src/core/block-cause.ts`), from the sentence opening the factory writes. An unknown reason falls into « Other cause », displayed as is. A reason that says no more than its cause is not repeated: « Stopped on request » and « Question asked by the agent » are at once the reasons the engine writes and the labels of their causes, one constant each (`STOPPED`, `AGENT_QUESTION`), and their French forms from before ORC-331 are not repeated either (`onlyRestatesCause`). A ticket blocked before ORC-331 keeps its French reason, which the same table still reads (`src/core/legacy-messages.ts`). A new block reason is added to that table and to its test.

## What the server exposes

| Route | Role | Protection |
|---|---|---|
| `GET /` and static files | Interface | password (except loopback) |
| `GET /api/state` | State: tickets, queue, active runs (without their tokens), cost, capacity | password |
| `GET /api/flow` | Flow: Needs you, Working, Done (without run tokens or queue contents) | password |
| `GET /api/events`, `GET /api/events/recent` | SSE stream, last 100 events | password |
| `GET /api/runs/:id/transcript` | A run's transcript | password |
| `POST /api/control/pause`, `/api/control/resume` | Pause / resume | password + origin check |
| `POST /api/tickets/:projet/:ticket/stop` | Stop a run | password + origin check |
| `GET /oauth/start` | Starts the Linear connection | password |
| `GET /oauth/callback` | Linear OAuth callback | random, single-use `state` parameter |
| `POST /webhooks/linear` | Linear webhooks | HMAC signature + 60 s freshness |
| `POST /webhooks/github` | GitHub webhooks | HMAC signature `X-Hub-Signature-256` + deduplication by event id |
| `/agent/*` | Agent API (`relais-agent`) | current run's token (`Authorization: Bearer`) |

With sandboxes (`FACTORY_CONTAINER_CLI`, see [`configuration.md`](configuration.md#environment-variables)), a **second server** serves only `/agent/*`, with the same routes and the same run token, on `FACTORY_AGENT_PORT` (interface port + 1) and `FACTORY_AGENT_HOST` (`127.0.0.1`): the containers, which have no network, reach it through the daemon's egress proxy (see [below](#sandbox-network)). Any other route returns 404 there. The interface stays at the `host` address.

## Network exposure and password

By default Relais listens on `127.0.0.1`: only the local machine can access it, without a password.

To expose it (server, Docker), set `host: 0.0.0.0` (or a specific address) in `config.yaml`. Relais then **refuses to start** without the `RELAIS_UI_PASSWORD` variable:

> host: 0.0.0.0 expose l'interface et l'API de Relais hors de cette machine. Définissez la variable d'environnement RELAIS_UI_PASSWORD (mot de passe de l'interface), ou remettez host: 127.0.0.1 dans config.yaml.

With the password, everything goes through **HTTP Basic** authentication (any username, password = `RELAIS_UI_PASSWORD`, compared in constant time), except four routes that have their own protection: `POST /webhooks/linear`, `POST /webhooks/github`, `GET /oauth/callback` and `/agent/*`. Check: `curl -i https://<domain>/api/state` must return 401.

The `relais status|pause|resume|stop` commands send `RELAIS_UI_PASSWORD` if the variable is set in the shell.

Basic auth sends the password with every request: when exposed to the Internet, put Relais behind an **HTTPS** proxy (Caddy, nginx, Traefik, Cloudflare tunnel) and set `publicUrl` to the HTTPS URL.

## CSRF protection

Any `POST` request (and any other non-`GET`/`HEAD` method) on `/api/*` that carries an `Origin` header is refused (403 `cross-origin request refused`) if that `Origin` does not match the server's host. A third-party page open in your browser therefore cannot pause the queue or stop a run, even locally without a password. Tools without `Origin` (CLI, `curl`) are not affected.

Behind a proxy, the `Host` header passed to Relais must be that of the public URL, otherwise the interface's buttons are refused.

## Agent tokens

Each run receives a random `RELAIS_RUN_TOKEN`. The `/agent/*` API only accepts it while that run is `running`. This token:

- only reads **the run's ticket** (`/agent/issue/<other ticket>` → 403);
- can search tickets, search the knowledge base and ask a question in the ticket's session;
- appears neither in `/api/state`, nor in `/api/flow`, nor in `/api/events` and `/api/events/recent`.

On the host, `RELAIS_API` points to `http://127.0.0.1:<port>/agent`: agents talk to the daemon locally. In a sandbox, it points to `http://<FACTORY_SANDBOX_AGENT_HOST>:<FACTORY_AGENT_PORT>/agent` (by default `host.docker.internal`): a name the container does not resolve, which the egress proxy recognizes and relays to the server dedicated to the agent API.

## Factory MCP

`POST /agent/mcp` is an MCP server ("Streamable" HTTP, JSON responses only, one message per request; any other method receives `405` with `Allow: POST`, no SSE stream), behind the same run token as the rest of `/agent/*`, also served by the server dedicated to sandboxes. Two tools (ORC-288):

- **`submit_result`**: the agent returns its result there, in the `agentOutputSchema` format (`src/core/agent-output.ts`), whose JSON schema is the tool's `inputSchema`. A valid result is stored for **the token's run** (meta `agent-output:<run>`), the last submission wins; an invalid result is refused (`isError`) with the offending fields, so the agent can fix it during its run.
- **`ask`**: like `POST /agent/ask` (question in Linear, ticket blocked), which stays until ORC-192.

`claude -p` receives it via `--mcp-config '{"mcpServers":{"factory":{"type":"http","url":"${FACTORY_API}/mcp","headers":{"Authorization":"Bearer ${FACTORY_RUN_TOKEN}"}}}}'`: Claude Code replaces the `${…}` with the variables from its environment (verified on 2.1.316). The token is therefore never on the command line, which the host's process list shows; it arrives through the run's environment, as before.

## What the agent loads, and what it does not

A project's repository is written by whoever can push to it: its Claude Code settings do not drive the runs. The `claude -p` options are the ones measured in [ORC-128](decisions/ORC-128.md) (ORC-284).

The agent loads only what the factory imposes:

- **the run settings** (`--settings`, the factory's `run-settings.json`);
- **the pack** (`--plugin-dir`): its skills, its startup hook (factory rules, knowledge base index);
- **the factory MCP**, the only one declared via `--mcp-config` (see [Factory MCP](#factory-mcp));
- **the repository's conventions**: the factory itself reads `CLAUDE.md`, `AGENTS.md` and `.claude/CLAUDE.md` from the worktree (the only file in `.claude/` that the removal below keeps, since Claude Code does not load it) and puts them in the run's prompt, as **data**: in a « Repository conventions (data) » section, between tags, presented as the repository's conventions, which lift no factory rule. Together, they are cut at 8,000 bytes (proposal, to be set with ORC-254's prompt budget), the cut marked; a larger file is never read in full. A file that is a link pointing outside the worktree, or unreadable, is not read. Their `@path` imports are not followed: only the files' text is injected. They are re-read on every attempt: they are in the run's message, not in the system prompt frozen on resume.

And nothing from the repository:

- **`--setting-sources ""`**: no `.claude/settings.json`, no `.claude/settings.local.json` (their hooks, their permissions, their `env`), no skills from `.claude/`, no `CLAUDE.md` loaded by Claude Code; and no user settings from the machine.
- **`--strict-mcp-config`**: neither the repository's `.mcp.json`, nor the account's claude.ai connectors (Drive, Docs…), which would otherwise load with a subscription account.
- **`.claude/` removed from the worktree before each session**, after `setup` (defense in depth, for what ORC-128 did not trap: agents, commands, output styles). The worktree is in *sparse checkout* (non-cone mode, `/*` except `/.claude/*`, `/.claude/CLAUDE.md` kept for the conventions), specific to this worktree (`extensions.worktreeConfig`): the repository's main checkout keeps its `.claude/`. `git status` stays clean, an agent's `git add -A` or `commit -a` does not delete `.claude/` from the PR, and a `git merge` or rebase that modifies it does not rewrite it to disk. Limitation: the agent cannot modify tracked files in `.claude/`; a ticket that asks to change them cannot be done by a run.
- **`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`**: no automatic memory (effect not verified by ORC-128).
- **Telemetry disabled** by `DISABLE_TELEMETRY=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (which one suffices remains to be measured); in a sandbox, the egress proxy refuses it anyway: only the calls Claude Code makes to `api.anthropic.com` get through (see [Sandbox network](#sandbox-network)).

In a sandbox, `CLAUDE_CONFIG_DIR` is `/home/factory/.claude`. For the ticket's session, the implementer's (a job of the `dev` queue with `session: resume` or `pickup: true`: `dev`, `dev-feedback`, `fix-ci`), it is the ticket's session folder, mounted from `<home>/sessions/<project>/<ticket>`: the whole Claude config folder is per ticket and outlives the container, hence the `--resume` from one attempt to the next, including for a `dev` relaunched on a ticket that already has its session (ORC-217). Any other run (review, question, learning) instead mounts an empty folder specific to the run (`<home>/runs/<runId>/claude`), deleted with the sandbox: fresh context, and its session never becomes the ticket's, even if it is the ticket's first run. A job of the `questions` queue with `session: resume` is refused when the workflow is loaded. The credential never enters the sandbox (ORC-337): `claude` gets a placeholder under `CLAUDE_CODE_OAUTH_TOKEN` (`set-by-the-factory-egress-proxy`), logs in by OAuth with it, and the egress proxy puts the token of the `claude.active` account in its place on the way to `api.anthropic.com`. Neither the environment nor `/proc` of a sandbox holds the account's token (isolation no. 7). On the host, without a sandbox, with no active account, it is the daemon's, as before. Each run records its session's role (`sessionRole`: `implementer`, `reviewer` or `answerer`, absent for `learn`/`remember`) along with its `claudeSessionId`.

Isolation test no. 11 (`test/isolation/claude-settings.test.ts`) replays, for each Claude Code version, ORC-128's trapped repository with these options: trapped hooks, MCP, skill, agent, command and `CLAUDE.md`, none of which must load. It requires a real `claude` and a credential ([`tests.md`](tests.md#the-vitest-projects)).

## Sandbox network

Decision and options: [ORC-213](decisions/ORC-213.md). Each container runs with **`--network none`**, whatever the level: no route, no DNS, no UDP. Its only way out is **its run's Unix socket**, opened by the daemon's egress proxy (`src/network/proxy.ts`) and mounted at `/run/factory/egress.sock`. A relay (the container's PID 1) exposes it at `127.0.0.1:3128`, and `HTTP_PROXY`/`HTTPS_PROXY` point to it; a tool that ignores these variables has no network.

The proxy applies the run's level:

| Level | What gets through |
|---|---|
| `none` | Nothing, not even the agent API (`verify`). |
| `claude-api` | The calls Claude Code makes to `api.anthropic.com` (below) and the agent API. No OAuth token renewal (`console.anthropic.com`, `platform.claude.com`): the sandbox holds no refresh token (ORC-337). |
| `limited` (default for runs) | The previous; npm, Yarn and PyPI; GitHub read-only; a list of documentation domains (`src/network/levels.ts`). GET, HEAD and OPTIONS methods only, except for the Claude API's calls. |
| `custom` (repository) | `limited` plus the hosts in `network.allow`. |
| `full` | Everything: reserved for `setup`, refused for the agent. |

- **Every tunnel is decrypted** (`CONNECT`, port 443 only; in `full`, another port is relayed as is over TCP, logged). The proxy presents a certificate from the **factory authority** for the requested host, reads each request, checks the method and path, then continues over TLS to the real host, its certificate verified against Node's store. The container trusts only this authority: its certificate is mounted read-only at `/run/factory/egress-ca.crt`, and `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `PIP_CERT`, `GIT_SSL_CAINFO`, `npm_config_cafile` and Yarn's variables point to it. Its key stays in `<home>/egress-ca/` (`0600`) and is never mounted.
- **Writes refused everywhere**: `git push` (only the factory pushes, ORC-125), gist, package publishing, POST to a documentation site or to a `network.allow` host. Only `git fetch` (POST to `git-upload-pack` on `github.com`) is additionally allowed.
- **The Claude API (ORC-337)**: only the calls Claude Code makes, method and path, the query aside: POST `/v1/messages` and `/v1/messages/count_tokens`, GET `/api/claude_code/settings` and `/api/claude_code/policy_limits` (measured on Claude Code 2.1.316 with the run's environment). Everything else is refused and logged: `/v1/files` first, and the telemetry (`/api/event_logging/*`, `/api/eval/*`), the CLI bootstrap and the MCP registry, which Claude Code runs on without. On every request that gets through, the proxy **removes the client's `authorization` and `x-api-key`** and sets `Authorization: Bearer <token>` with the token of the run's Claude account: an agent that holds another key cannot use it there, and has no token of the factory's to read. Since the factory's token rides on them, the model calls (POST, `/v1/messages` and `count_tokens`) are read whole and refused when their body could make Anthropic's servers reach out on the factory's account, or when the proxy and the API could read it differently: not JSON in UTF-8, compressed, nested deeper than 64 (checked on the raw bytes before any parse; Claude Code's calls nest 10 deep), a number a double cannot hold, an `mcp_servers` or a `container` field, a server tool in `tools` (any `type` but none, `custom`, and the client-run `bash_*`, `text_editor_*`, `computer_*`, `memory_*`: so `web_search_*`, `web_fetch_*`, `code_execution_*`, `mcp_toolset`… are refused), or a content block, in a message, a tool result or the system prompt, that Anthropic would fetch: a `source` other than `base64` or `text` (an image or a document by URL or by file), a `url` on the block or on a citation, a search result. What goes on is the call as checked, serialised again, so a duplicate key cannot make the API read something else. A call is capped at 16 MiB (a run's first calls are ~52 KB; a full 1M-token window of text is about 4 MiB): over it, a 413 and the connection cut. A call holds a place from its first byte until it is written upstream: 2 per run and 8 in all, so a run cannot starve the others (429 beyond, which Claude Code retries); its body must come in within 30 s (408 and cut otherwise). Checking a 4.3 MiB call takes ~40 ms of the event loop (measured). The `anthropic-beta` header keeps only the values Claude Code sends (`CLAUDE_BETAS` in `levels.ts`, measured on haiku, sonnet and opus with the factory's options); any other is dropped, and noted once per run, so a Claude Code upgrade that needs a new one shows in the journal. A dropped beta, a throttled or slow call and a client gone are journal **notes** (`kind: "note"`), no refusals: the security log and the summary posted on the ticket leave them out. The proxy knows the run by its socket, one per run; it gets the token from the daemon when the run is opened (over the control socket under compose), and takes the new one when a restarted daemon opens the run again. The daemon resolves it once for the runner and the proxy: the `claude.active` account, else its own `CLAUDE_CODE_OAUTH_TOKEN`. A run on the host is unchanged: the chosen account replaces its logins, and without one it keeps the daemon's (`ANTHROPIC_API_KEY` included). Under `full` (a setup, which runs no agent), nothing is set.
- **HTTP/1.1 only** in a tunnel: a client that only offers HTTP/2, an upgrade (WebSocket) or anything other than HTTP is refused and logged.
- **Verified host = host reached**: the request goes to the `CONNECT` target, with that host as `Host`, whatever header the container sent.
- **Never a private address** (loopback, private networks, cloud metadata's `169.254.0.0/16`), even in `full`, even through a name that leads there.
- **Log**: every request and every refusal, with the host, method, path (without its query string, which may carry a token), bytes sent and received and the reason for a refusal, in `<home>/network/<run>.jsonl`, purged after 30 days like the transcripts.
- **After a daemon restart**, the still-running container of an attempt in progress is taken back (ORC-220): the run's socket lives in a folder of its own, mounted read-only, and the daemon puts it back at the same path, at the level of the container's label. Ongoing connections are cut; the client reopens them. The `allow` list of a `custom` repository is not kept: the resumed run loses its extra hosts, which only restricts. Any other running container is destroyed.

## Secrets

Where they live and how they stay inside the daemon: [`configuration.md`](configuration.md#what-does-not-leave-the-daemon). In short: `secrets.json` in `0600`, run environment without `RELAIS_*` or `LINEAR_*`, Linear token never passed to agents, `run-settings.json` that forbids runs from reading the sensitive files in `RELAIS_HOME`.

## Known limitations

- **Without a sandbox, same system user.** Without `FACTORY_CONTAINER_CLI`, runs execute on the host under the same user as the daemon (the daemon writes it at startup: « runs execute on the host, without isolation »). Claude Code's refusals are advisory: an agent that runs code (`node -e …`, allowed by the pack) can read `secrets.json` or `relais.db`. An injection in a ticket or a comment could push it to do so. **Do not entrust Relais with tickets written by untrusted people** as long as runs do not execute under a separate user.
- **Sandbox: the egress authority's key is a daemon secret.** Whoever reads it (`<home>/egress-ca/ca.key`) can impersonate any site to this instance's sandboxes, not beyond: nothing else trusts this authority. A run without a sandbox, on the host, can read it like `secrets.json`.
- **Sandbox: a client that pins a certificate fails.** It refuses the factory's certificate: the connection fails, logged (closed by default). Likewise a tool that ignores the authority variables above.
- **Sandbox: redirect to an unlisted host.** A redirect (`git`, `npm`, `fetch`) to a host the level does not include is refused like a direct connection: a renamed GitHub repository, or a package served from another CDN, fails.
- **Sandbox: one level per run, the repository's.** Each agent run takes the `network` from `.factory/config.yml` read at launch (level, `allow` of a `custom` repository), `claude-api` for a repository at `none` (ORC-209 C, see [repository configuration](repository-configuration.md#the-agents-network)). The level of each preset step (review at `claude-api`) waits for ORC-322. `setup` runs in a container of its own, destroyed before the agent's is created (ORC-211), at the `limited` level, not `full`: a `setup` that goes outside the list fails.
- **Sandbox: network log in the database, not yet on the dashboard.** The connection log is one JSONL per run in `<home>/network/`, written to the database at the end of the run along with the agent's refusals ([`pack-and-skills.md`](pack-and-skills.md#pretooluse-hook-and-refusal-log), ORC-296); the dashboard's security log will come with ORC-300. The database is not purged.
- **Sandbox: the agent has its own git repository, and the host never runs git in it (ORC-317).** Each workspace is a separate repository, created by the factory, with its `.git` in the worktree: no hooks, its objects copied, and of the repository's settings only an allow list (ORC-341): the commit identity (`user.name`, `user.email`), the line endings (`core.autocrlf`, `core.eol`), Git LFS's filter (`filter.lfs.*`), and each remote's `url` and `fetch`, the URL without its credentials (`https://x-access-token:…@` and a token as the user removed; over ssh the user stays). An extraheader, `credential.*`, a push URL, `url.*.insteadOf`, `core.sshCommand`, a proxy or a hooks path never reach the sandbox, whatever the repository's config holds. Everything in it belongs to the agent, and the git directory of `repoPath` is never mounted: `git fetch`, `git ls-remote` and the `fetch` that creates a workspace run on the host, on a configuration, hooks and refs the agent could never write. Of what the agent wrote, the host only reads data: `HEAD` and the refs as files (neither link nor FIFO, bounded size), the objects as one more location from the factory's repository. Whatever git needs to do there, such as hiding `.claude/`, is done at its creation, before any agent. Limitations: what the host reads from this repository is still what the agent chose to put there (only `verify` judges a commit); a trapped object pack reaches the host's git in read mode, and `objects/info/alternates` can point to the objects of another repository on the machine, readable provided one knows their hash. Without a sandbox (`FACTORY_ALLOW_HOST_VERIFY=1`), the agent runs on the host and so does git in its folder: none of these guarantees. A repository already exposed to an agent before this version may keep its configuration or hooks: see [`deployment.md`](deployment.md).
- **Sandbox: `trunk-readonly` mounted read-write.** The port always mounts the worktree writable; a `trunk-readonly` job is only held back by `--permission-mode plan`, as on the host. Whatever it might write anyway disappears with its question: each one has its own `_trunk/<runId>/`.
- **Sandbox: rootless verified only in CI and on the server.** In development (Docker Desktop under WSL), the engine is not rootless. The `isolation` CI job (rootless Podman) and the server verify it.
- **Without a sandbox: `verify` refuses to run, unless explicitly requested.** With sandboxes, `verify` never runs the agent's code on the host: the work leaves via `git bundle` from a container without network, the factory clones it without the repository's config, and the commands run in a fresh container on that clone, at network level `none`, with nothing else mounted (ORC-151). A failed engine yields `verify.errored`: the ticket is blocked for an infrastructure reason, with no fallback to the host, and nothing is sent back to the agent. Without `FACTORY_CONTAINER_CLI`, `verify` and the red check respond the same way, except with `FACTORY_ALLOW_HOST_VERIFY=1`: they then run in the worktree, on the host, without any of these guarantees (including reading the disk and the daemon's `/proc/<pid>/environ`). `setup` without a sandbox stays on the host, like the runs themselves (ORC-179).
- **Sandbox: a session started on the host does not resume in the container.** A ticket whose Claude session was opened on the host (before sandboxes were enabled) does not have that session in the folder mounted at `~/.claude`: its next resume run fails once. Block it, or relaunch it from scratch.
- **Sandbox: the Claude token is visible to the agent.** It is the runner's only credential; it is used for `claude -p`, and the network level limits where it can go. `FACTORY_RUN_TOKEN`, the run's other token, only grants access to the agent API, for the run's ticket and for the duration of the run.
- **Sandbox: `sealSecrets` looks for values.** A `setup` secret written into the worktree is removed as is, in base64 (even within `user:token`), in a URL or in JSON. Hashed, encrypted, or in base64 split across lines, it is not recognized. Everything else `setup` wrote outside the worktree disappears with its container. A misused secret can also leak during `setup`, to a host of the `limited` level: through a GET request only, since the proxy refuses other methods.
- **Without a sandbox: secrets passed to runs.** On the host, `ANTHROPIC_API_KEY` (ORC-179) and the daemon's SSH agent are visible to agents; `GH_TOKEN` no longer is (ORC-125), but only the pack's hook prevents a `git push` through that SSH agent. The daemon's variables, Claude tokens and repository secrets included, stay in the daemon process, which a run on the host can read (`/proc`) under the same user. `verify` and `setup` on the host receive only the system, no credentials; repository secrets are only given to a sandboxed `setup`. Give the GitHub account minimal permissions ([`github.md`](github.md#permissions-required-for-the-gh-fallback)).
- **Public smee channel.** Webhook contents transit through smee.io and can be read there by anyone who knows the URL ([`linear.md`](linear.md#3-webhooks-smee-or-public-url)).
- **Merge.** Only GitHub branch protection guarantees that the agent does not merge ([`github.md`](github.md#branch-protection-strongly-recommended)).
- **Transcripts.** `transcripts/` contains everything the agents read and wrote; protect `RELAIS_HOME` accordingly.
