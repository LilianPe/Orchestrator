# First run: a real ticket, locally

This guide takes one real Linear ticket through the whole factory on your own machine (a workstation or a dev container, not the ORC-126 server): delegated → `intake` → `clarify` if needed → spec → `/approve` by a validator → tests → red check → freeze → build → `verify` → PR opened by the GitHub App → AI review → *Human Review*. Every command and every message quoted here is the current code's: the commands are checked against the CLI by `src/docs-first-run.test.ts`, and the outputs were taken from a run of `factory init`, `factory validate`, `factory doctor` and `factory up` on a scratch repository (no real token, no container engine).

The executable is `factory` (`npm link`, [`installation.md`](installation.md)), the product name in Linear and in the logs is `Orchestrator`, and the instance directory is `FACTORY_HOME`, `~/.factory` by default.

## 0. What you must create first

Nothing below can be skipped for a real run: without a container engine nothing runs, without the GitHub App nothing is published, without a validator no spec is approved. Create each item, then put its value where the last column says.

| # | What | How | Where the value goes |
|---|---|---|---|
| 1 | **The pilot repository**, cloned locally, with `origin` on GitHub and `origin/HEAD` set | ORC-137 chose two pilots: `Intersektion/intersektion-platform` (the product repository, the first 20 real tickets) and `LilianPe/Orchestrator` (dogfooding: run the factory from a pinned commit, never from the branch it changes). For a first run, the one whose tests you know. `git clone` sets `origin/HEAD`; on an older clone, `git remote set-head origin --auto`. | `config.yaml`, `projects[].repoPath` (written by `factory init`) |
| 2 | **`.factory/config.yml` with `commands.test`**, merged on the default branch | `factory init` proposes it (step 2); commit it through a normal PR. Without `commands.test` every ticket blocks at the tests step. | the repository, default branch |
| 3 | **Branch protection** on the default branch: a ruleset with *Require a pull request before merging* that the App cannot bypass | GitHub → repository → Settings → Rules → Rulesets ([`github.md`](github.md#branch-protection-required-by-factory-doctor)). `factory doctor` refuses without it. | GitHub |
| 4 | **A test GitHub App** with the permissions of [`github-app-manifest.json`](github-app-manifest.json) (Contents, Pull requests, Checks write; Commit statuses, Actions, Metadata read), **its private key**, and **installed on the pilot repository** | `factory init` prints the steps, with the permissions (step 2); details in [`github.md`, "Creating the App"](github.md#creating-the-app). Locally, leave its webhook disabled: the factory reads the PRs at its reconciliation, every 5 minutes. Keep the `.pem` outside the repository, mode `0600`. | `factory.yml`, written by `factory init`: `github: { app_id: env:GH_APP_ID, private_key: env:GH_APP_KEY }`, with `GH_APP_ID` (the App ID) and `GH_APP_KEY` (the `.pem` path) in the daemon's environment. |
| 5 | **A Linear OAuth application** (not a personal API key), created by a Linear workspace admin, with webhooks on | `factory init` prints the exact callback URL, webhook URL and categories (step 2); details in [`linear.md`](linear.md#1-create-the-oauth-application). | Client ID, client secret and webhook signing secret typed into `factory init` → `secrets.json`. The OAuth tokens come later, from « Connect Linear ». |
| 6 | **A public URL for Linear's webhooks** | Locally, nothing to create: run **`factory init --dev`**, which creates a smee.io channel when `config.yaml` has neither `publicUrl` nor a relay (ORC-411: without `--dev`, `init` creates none and asks nothing of Linear, which has nowhere to send the webhooks). Or a tunnel (`cloudflared tunnel --url http://localhost:4100`) in `publicUrl` before `factory init`, needed anyway if Linear refuses the `http://localhost` callback ([`linear.md`](linear.md#3-webhooks-production-and-development)). | `config.yaml`: `relay` (smee, written by `factory init --dev`) or `publicUrl` |
| 7 | **A Claude Code token** | `claude setup-token` on a machine logged in to the subscription account. | `factory.yml`: `claude.accounts[].token: env:CLAUDE_CODE_OAUTH_TOKEN` (any variable name), and that variable in the daemon's environment. In a sandbox the egress proxy sets it on the model calls; the agent only holds a placeholder. |
| 8 | **Rootless Podman on Linux, cgroup v2**, with the systemd cgroup manager and the `cpu`, `memory` and `pids` controllers delegated to your user | `sudo loginctl enable-linger <user>`; check with `podman info --format json` (`host.cgroupVersion: v2`, `host.cgroupManager: systemd`, `host.security.rootless: true`). On Windows, inside WSL2 only: the sandboxes need a Linux daemon. `factory doctor` checks all of it (step 3). | `FACTORY_CONTAINER_CLI=podman` in the daemon's environment |
| 9 | **The runner image**, built from this repository | `podman build -f docker/runner.Dockerfile -t localhost/factory-runner docker` | `FACTORY_RUNNER_IMAGE=localhost/factory-runner` |
| 10 | **Postgres** (optional locally) | Outside production the daemon uses SQLite (`FACTORY_HOME/factory.db`) when no URL is set. To run on Postgres as the server will, a database of its own (never the test suites' one). | `FACTORY_DATABASE_URL=postgres://user:password@host:5432/database` |
| 11 | **Who validates the spec**: at least two Linear users | Every ticket waits for `/approve` from a designated validator, and never from the person who delegated it. With a lone validator, someone else must delegate; with two validators, either can delegate and the other approves. Linear user ids (UUIDs): `query { users { nodes { id name } } }` in Linear's GraphQL explorer. | `config.yaml`: `projects[].authz.validators` |
| 12 | **Who may delegate**: each delegator's GitHub login, with write access to the pilot repository | The trigger needs Linear team membership **and** GitHub write access, read through the App on the login you map ([`linear.md`](linear.md#authorizations-who-can-do-what)). Without a mapping, the delegation is refused. | `config.yaml`: `projects[].authz.githubLogins` (Linear id → GitHub login) |

Also on the machine: Node 24.22.1+, git and `claude` (no `gh`: the factory reads and publishes on GitHub by its App alone, ORC-181) ([`installation.md`](installation.md#prerequisites)). The visual proof needs `FACTORY_BROWSER_IMAGE` too (`docker/browser.Dockerfile`); without it, a ticket that changes a screen gets its proof marked unavailable and still goes on.

## 1. Install

```bash
git clone <factory repository url> && cd <factory clone>
npm ci && npm run build && npm link
factory          # prints the help, exit code 1: normal
```

## 2. `factory init --dev`, in the pilot repository

```bash
cd <pilot repository>
factory init --dev
```

`--dev` is what a local run needs: with no `publicUrl` in `config.yaml`, it creates the smee.io channel that relays Linear's webhooks to your machine (item 6). Without it, `init` creates no channel, says `No public URL for Linear's webhooks: …` and skips the Linear application; with a `publicUrl`, `--dev` changes nothing. A channel already in `config.yaml` is kept either way.

It asks the Linear team key, then prints what to create in Linear, with your instance's URLs:

```text
1. In Linear: Settings → API → OAuth applications → New application.
   - Name: Orchestrator (the name you will mention with @)
   - Callback URL: http://localhost:4100/oauth/callback
   - Check "Webhooks", URL:
     https://smee.io/…
   - Categories: Agent session events, Issues, Comments
2. Create the application, then paste the client ID, the client secret and the webhook signing secret below.
```

Create the application, paste the three values (an empty webhook secret is asked again). Then it proposes the repository's file, and writes nothing in the repository:

```text
Proposed .factory/config.yml, to commit on the default branch (init writes nothing in the repository):
setup: npm ci
commands:
  lint: npm run lint
  test: npm test
```

With the proposal comes the maturity report (ORC-410), one card per point, stored in the instance's database for a person to approve on the dashboard's **Maturity** page once `factory up` runs:

```text
Maturity report, one card per point to approve on the dashboard: http://localhost:4100/#maturity
  [to approve] Stack: Node (npm)
  [to approve] Commands:
    setup: npm ci
    lint: npm run lint
    test: npm test
  [to approve] main green or red: not checked yet: the dry run (ORC-408) runs setup, build and tests on main
  …
```

The **main** card says the project's last dry run when the database holds one; on a first setup it has none yet, and the card says « not checked yet », which cannot be approved, until `factory dry-run` (step 4) sets it green or red (ORC-437).

Commit that file on the default branch through a PR, merged: the daemon and `factory doctor` read it there (`origin/HEAD`, as the clone last fetched it), never in a working copy. Then `git pull` on the default branch in the clone: `factory validate` reads the working copy's file. If `init` warns that there is no `commands.test`, add one before going on.

On a first setup (no Linear values yet, no `factory.yml`), it then prints the GitHub App's steps (item 4) and writes `FACTORY_HOME/factory.yml`:

```text
GitHub App of Orchestrator (it opens and updates the PRs):
1. On GitHub: https://github.com/settings/apps/new (for an organization: its Settings → Developer settings → GitHub Apps).
   - Name and homepage URL: your choice
   - Webhook: uncheck "Active" (no public URL): the factory reads the PRs every 5 minutes, at its reconciliation
   - Repository permissions: Contents: read and write, Pull requests: read and write, Checks: read and write, Commit statuses: read, Actions: read, Metadata: read; nothing else
2. Create the App, note its App ID, then "Generate a private key":
   keep the .pem outside the repository, mode 0600 (e.g. /home/<user>/.factory/github-app.pem).
3. Install the App on the repository ("Install App").

Wrote /home/<user>/.factory/factory.yml: its secrets are references; export them in the shell of `factory up` and `factory doctor`, which refuse to start without them:
  export GH_APP_ID=<App ID>
  export GH_APP_KEY=<path of the .pem>
  export CLAUDE_CODE_OAUTH_TOKEN=<token of claude setup-token>
```

It ends with `Configuration written.` and its next steps. It wrote `FACTORY_HOME/config.yaml` (the project, the relay, `dev: true`), `FACTORY_HOME/secrets.json` (mode `0600`) and `FACTORY_HOME/factory.yml`.

Run again, `factory init` erases nothing (ORC-83): an empty answer keeps the team key and the stored Linear values (and « Connect Linear »'s tokens, as long as the client ID is the same), the project's roles stay, an existing `factory.yml` is kept as it is (`… factory.yml kept as it is.`), and an instance that already runs without one gets none. A new client ID asks for its secrets: nothing of the old application is kept.

Now add by hand, in `config.yaml`, the roles of items 11 and 12:

```yaml
projects:
  - id: pilot
    repoPath: /home/<user>/code/pilot
    linearTeamKey: PIL
    authz:
      validators: [<linear id of validator 1>, <linear id of validator 2>]
      githubLogins:
        <linear id of the delegator>: <their github login>
```

`FACTORY_HOME/factory.yml` is read by `factory up`, `factory doctor` and `factory plan` with the daemon's environment, and by `factory validate` for its budgets, `max_diff` and tools. The one `init` wrote:

```yaml
# Written by factory init: every secret is a reference, read from the daemon's environment.
github:
  app_id: env:GH_APP_ID
  private_key: env:GH_APP_KEY
claude:
  runtime: claude-code
  accounts:
    - name: main
      token: env:CLAUDE_CODE_OAUTH_TOKEN
  active: main
  default_model: claude-sonnet-5-5
budgets:
  per_step_tokens: off
  per_ticket_tokens: 5000000
```

With a `publicUrl`, the App's steps give its webhook URL, optional: if you enable it, add `webhook_secret: env:GH_WEBHOOK_SECRET` under `github` and export it (`init` does not write it: an unset variable stops the daemon). `concurrency` is left to its default; `concurrency: 1` keeps a first run to one ticket at a time. The ticket cap is a first one, to calibrate (ORC-216).

`claude.runtime` and `claude.default_model` are required once `claude` is there. The budgets: `factory validate` refuses a step cap left unset, and the daemon warns without a ticket cap; `per_step_tokens: off` with a ticket cap is the simplest accepted choice for a first run ([`configuration.md`](configuration.md#factoryyml-orc-209)).

Then export the daemon's environment in the shell that will run `factory up` and `factory doctor`:

```bash
export GH_APP_ID=<App ID>
export GH_APP_KEY=$HOME/.factory/github-app.pem
export CLAUDE_CODE_OAUTH_TOKEN=<token of claude setup-token>
export FACTORY_CONTAINER_CLI=podman
export FACTORY_RUNNER_IMAGE=localhost/factory-runner
# outside a desktop login session (a dev container, ssh), rootless Podman needs the systemd user session's:
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus
# optional: export FACTORY_DATABASE_URL=postgres://…
```

## 3. Check before running

### `factory validate`

```bash
factory validate
```

Expected: `.factory/config.yml valid: it only adds checks or prohibitions to the baseline.`, `Disabled in factory.yml: budgets.per_step_tokens.`, the tools of each agent step, and, with the budgets above, `No worst case of factory/default in tokens: budgets.per_step_tokens is disabled.`, exit code `0`.

If it breaks:

- `Budgets of factory/default refused:` then one `not set` line per step: `factory.yml` has no `budgets`, or not in the daemon's `FACTORY_HOME`.
- `worst case … exceeds budgets.per_ticket_tokens`: per-step caps whose worst case passes the ticket cap; raise the ticket cap, or lower the step caps.
- `factory.yml refused:`: its `budgets`, `max_diff` or `tools`, the only sections `validate` reads. The rest of the file (`claude`, `github`, the `env:` references) is checked by `factory doctor` and `factory up`.

### `factory doctor`

```bash
factory doctor
factory doctor --json     # the same as a machine report
```

What it says first, never part of its verdict:

```text
Visual proof on this instance: unavailable — FACTORY_BROWSER_IMAGE is not set (see docker/browser.Dockerfile)
Server secrets:
  github.private_key (env:GH_APP_KEY): in clear — warning: in clear in the daemon's environment: a sealed source (systemd-creds) keeps it off the disk
  claude.accounts[0].token (env:CLAUDE_CODE_OAUTH_TOKEN): in clear — warning: in clear in the daemon's environment: a sealed source (systemd-creds) keeps it off the disk
  secrets.json: in clear — warning: in clear on disk: set secrets_key in factory.yml to encrypt it
```

These warnings are expected on a workstation. Two other warnings must not be there for a first run:

- `Warning: pilot: no spec validator (authz.validators in config.yaml): …`, or `one spec validator`: item 11. With none, every ticket stops at the spec gate; with one, the tickets they delegate.
- `` Warning: .factory/config.yml has no `commands.test`: … ``: item 2, or the file is not yet on `origin/HEAD` (`git fetch`).

Then the verdicts. Expected:

```text
Host: accepted — rootless podman on cgroup v2, limits through cpu, memory, pids
Default branch main: accepted — …
```

then each GitHub Actions workflow with its verdict (or `No GitHub Actions workflow found.`), and `Result: accepted — …`, exit code `0`. What each refusal means:

| Output | Cause | Fix |
|---|---|---|
| `invalid factory.yml:` then `github.app_id: the environment variable GH_APP_ID is not set` (or `claude.accounts[0].token: …`) | a variable `factory.yml` references is not in this shell (`factory plan` says the same) | run it in the daemon's environment (step 2) |
| `invalid factory.yml:` then `claude.default_model: required` or `` claude.runtime: only `claude-code` exists `` | the `claude` section | as in step 2 |
| `` GitHub App not configured: `factory doctor` needs github.appId and github.privateKey (or GH_APP_ID and GH_APP_KEY) … `` | no `github` in `factory.yml` nor in `config.yaml`, and no `GH_APP_*` | item 4 |
| `Cannot read the repository's branch naming: unreadable default branch (origin/main): origin/HEAD is not set …` | clone without `origin/HEAD` | `git remote set-head origin --auto` |
| `Host: refused — no container engine (FACTORY_CONTAINER_CLI is not set): nothing limits the sandbox` | item 8 | export `FACTORY_CONTAINER_CLI=podman` |
| `Host: refused — cannot read the cgroups of the engine (podman info): spawn podman ENOENT` | Podman not installed, or not on the `PATH` | install it |
| `Host: refused — no cgroup v2: …` | the host is on cgroups v1 or the hybrid layout | boot on the unified cgroup v2 hierarchy |
| `Host: refused — rootless podman on the cgroupfs cgroup manager ignores the limits: …` or `podman cannot limit through the … controller(s), not delegated to its user …` | no systemd user session, controllers not delegated | `sudo loginctl enable-linger <user>`, then `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` as in step 2 ([`tests.md`](tests.md)) |
| `Default branch: refused — Cannot read the protection of the default branch: GitHub API GET /repos/<owner>/<repo>/installation: 404 Integration not found` | the App is not installed on this repository (or a wrong App ID) | item 4: install it |
| `Default branch main: refused — …` | no ruleset requiring a pull request, or the App in its bypass list | item 3 |
| `verdict: refused` under a workflow | a CI job sees a secret or a writable `GITHUB_TOKEN` on the factory's branches (`feat/*`, `fix/*`) | protect that job with an environment with required reviewers, or declare `permissions:` read only ([`github.md`](github.md#rule)) |

### The dry run

The dry run (ORC-408, ORC-409) runs the repository's `setup`, then its build and test commands, on the default branch in the sandbox, as `verify` runs them for a ticket, and records what breaks. It needs the daemon and its sandboxes: run it in step 4, once `factory up` is running.

## 4. Start the daemon: `factory up`

```bash
factory up
```

The lines to read in its log (taken from a start on a scratch repository):

```text
[factoryd] store: SQLite (/home/<user>/.factory/factory.db)        # or: store: Postgres (Drizzle migrations applied)
[factoryd] Disabled in factory.yml: budgets.per_step_tokens.
[factoryd] GitHub forge: GitHub App <id> (installation tokens limited to the run's repository, installation resolved per repository)
[factoryd] Linear not connected: open http://localhost:4100/oauth/start
[factoryd] GitHub webhooks refused: neither github.webhookSecret nor GH_WEBHOOK_SECRET; only the reconciliation every 5 min follows GitHub.
Orchestrator is running: http://localhost:4100  (Ctrl+C to stop)
```

The GitHub webhooks line is expected locally: a merge or a CI verdict then reaches the ticket within 5 minutes. What must not be there:

| Output | Cause |
|---|---|
| `FACTORY_CONTAINER_CLI is not set: the agents would run on this machine, … ` and exit `1` | item 8: never set `FACTORY_ALLOW_HOST_RUNS=1` for a real ticket |
| `Warning: no GitHub App (github.app_id and github.private_key in factory.yml, or GH_APP_ID and GH_APP_KEY): the factory reads no PR, publishes nothing and merges nothing.` | item 4: the App is not read, no PR will open |
| `Warning: no Claude token (claude.active in factory.yml, or CLAUDE_CODE_OAUTH_TOKEN): sandboxed runs will not be able to authenticate.` | item 7 not in the daemon's environment |
| `Warning: <project>: no spec validator …` | item 11 |
| `error: sandboxes not listed, … spawn podman ENOENT` | Podman is not on the daemon's `PATH` |

Then open `http://localhost:4100`, click **Connect Linear** and authorize the application: « Linear is connected. You can close this tab. ». The factory creates the missing statuses of the team (Todo, In Progress, Human Review, AI Review, Done) and the `Bloqué` label.

In another terminal, with the same `FACTORY_HOME`: `factory status` (`Linear: connected · queue: active …`) and `factory plan`, which lists the tickets delegated to the agent and whether each would be picked up, without starting anything (`` Linear not connected: run `factory up`, then connect Linear. `` before the connection).

Then the dry run of the pilot, with the project's `id` in `config.yaml` (`pilot` in step 2), in that same terminal:

```bash
factory dry-run <project>
```

It says `Dry run of <project> under way: …`, waits as long as the setup and the tests take, then prints `Dry run of <project> on <commit>: green (<its commands>).` and exits `0`; red, it lists what breaks, each break with its step, its command and its cause, and exits `1`. Red, fix main first: the project's tickets are refused while its dry run is red, and a red main would make the red check and `verify` meaningless. `No dry run recorded (409): …` means no dry run could run: no sandboxes (`FACTORY_CONTAINER_CLI`, `FACTORY_RUNNER_IMAGE`), the container engine, the forge or a registry not answering. Without it, the first delegation runs the project's first dry run itself and waits for it before `intake` ([`dry-run.md`](dry-run.md#the-gate-of-a-delegated-ticket)); running it here shows a red main before a ticket is refused for it.

## 5. Delegate the ticket

Pick a small ticket of the pilot repository with explicit acceptance criteria, a description of at least 30 characters, and no branch of the factory's for it yet (`feat/<id>-…`, `fix/<id>-…`, `factory/<id>-…`). In Linear, set its **delegate** to `Orchestrator` (the application's name), as a user mapped in `githubLogins`.

What you should see, step by step ([`preset.md`](preset.md#sequence)):

| Step | In Linear / GitHub | If it breaks |
|---|---|---|
| Delegation | within 10 s, the comment « Got it. » and the session's plan | Nothing at all: a webhook that does not arrive (the workstation's smee channel, `publicUrl`, the clock: Linear's signature is refused past 60 s of offset) or a refused signature; the log says `relay: webhook rejected with 401 (…)`. A refusal by the matrix (no `githubLogins` entry, no write access) is replied in the session and logged `authz: refused …`. |
| `intake` | the session's live feed (« Reading the code »…); the ticket stays in Todo | An incomplete ticket goes to `clarify`. |
| `clarify` (if needed) | up to 3 questions in the session, one at a time | Answer in the **session**, not in a ticket comment. Unanswered after 72 h, the ticket is blocked. |
| Spec | the spec in a comment of the ticket, « **Spec, version N** »; past 5 000 characters, in a Linear document linked to the ticket (« <ID>: spec, version N »), the comment giving its summary and the link. Then the session says « Spec published (risk: …). N acceptance criteria → tests. Version N, waiting for review. » and where to read it. The ticket stays in Todo, unless `factory.yml` gives the step a status: `statuses: { spec_draft: Spec }`, then restart the daemon and click **Connect Linear** again to create it ([`configuration.md`](configuration.md)) | A spec that fails `spec_check` twice blocks the ticket. |
| `/approve` | a **validator who did not delegate** reads the spec in that comment or document, then replies `/approve` in the factory's **session** on the ticket, not under the comment (`/changes <comment>` asks for a new version, `/reject` stops) | A refusal is answered in the session: the delegator approved, or the validator is not in `authz.validators`. A plain comment, or a reply under the spec's comment, is not read as a command. |
| `tests` → red check → freeze | the tests are committed on the ticket's branch; the factory runs them with `commands.test`: they must fail for the right reason. For the first 20 tickets the red check only measures (it never blocks, the trace says what it would have blocked); the freeze always applies | `infra`: the check could not run (no `commands.test`, the sandbox); the ticket is blocked. |
| `build` | the ticket moves to **In Progress** | |
| `verify` | the commands of `.factory/config.yml` in a fresh clone, plus the factory's checks (frozen tests, forbidden paths, secrets, diff size) | 3 failures in a row block the ticket, with the blocking comment « 🔴 Blocked at step … ». |
| PR | a **draft** PR opened by the App on `feat/<id>-<slug>` (or `fix/…`), with the factory's description and the `factory/verify`, `factory/tests-gelés`, `factory/anti-triche` checks | « the factory neither publishes nor merges »: the App or the sandboxes are missing; a ticket verified and not published is blocked with that reason. |
| AI review | the ticket moves to **AI Review**; the review's findings on the PR; a fix round if it finds something (at most 2) | |
| *Human Review* | the PR leaves draft, labelled `revue: …`; the recap in the session | Your turn: review on GitHub or reply in the session (a fix after 3 minutes), then move the ticket to *Done* to merge, with GitHub merge rights. |

A blocked ticket waits for a human: reply on the ticket (comment or session) and the blocked step starts again ([`linear.md`](linear.md#the-blocking-comment-orc-196)). To stop: `factory stop <ID>`, the stop of the Linear session, `/stop`, or the dashboard.

## Troubleshooting

- **`factory status` says `Orchestrator did not answer through …/cli/factory.sock (connect EINVAL …)`**, and the daemon logged `CLI socket: … cannot be listened on (listen EINVAL …)`: the socket's path is longer than Linux allows (108 bytes). `status`, `pause`, `resume` and `stop` then fail; use a shorter `FACTORY_HOME` and restart the daemon.
- More: [`operations.md`](operations.md#troubleshooting).
