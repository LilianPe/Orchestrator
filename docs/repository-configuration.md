# Repository configuration: `.factory/config.yml`

A repository can declare its commands, its sensitive paths and its limits to the factory in `.factory/config.yml`, at the root. The file is optional: without it, the `factory/default` baseline applies as is.

**Status (ORC-209).** The schema, `factory validate` and reading by the daemon exist (see [When and where it is read](#when-and-where-it-is-read)). Applied to runs: `setup`, `env`, `setup_secrets` and `network` at launch, `commands`, `setup` and `env` on each `verify`, `sensitive_paths` on each `verify` and publication of a branch an untrusted run worked on, on what it changed since (ORC-338). `budgets.per_ticket_tokens` at each launch (ORC-340) and by `factory validate`'s worst case (ORC-216). `visual_paths` on each `verify` of a job that writes the commit (ORC-176). `services` at launch and on each `verify` (ORC-309, see [Services](#services)). `max_diff` on each `verify` (ORC-333), not yet on the publication (ORC-125). `dependencies.allow` on each `verify` (ORC-371, see [Dependencies](#dependencies)). `branches` at the launch of a run that makes a worktree, and by `factory plan` and `factory doctor` (ORC-283, see [Branch names](#branch-names)). Read and validated, but not yet applied: `feature_flags`.

## When and where it is read

- **At the launch of each agent run**, only once, on the forge's default branch, fetched just before into the factory's repository (`git fetch origin`, then `origin/HEAD`): never in the agent's worktree, nor on its branch. The agent cannot write this ref: its git directory is its own (ORC-317). The run takes its `setup`, its variables and its network level from it, and keeps it: whatever checks it afterwards (the red check, `verify` on the host without a sandbox) reuses this read, even if the default branch has changed in the meantime.
- **The config `fetch` is capped at 2 minutes**, without prompting for credentials: past that delay, git is killed with what it started in its process group (its ssh), on Linux and macOS; on Windows, git alone. The launch is then refused (« Launch error: the forge no longer responds after 120 s »), and it never waits more than a few seconds beyond, even if a process that left that group (an ssh `ControlPersist`, a helper that detaches) keeps git's output open. A `fetch` that ends before the delay gives its own result, never « no longer responds ». Known limit: a Ctrl-C or a daemon stop during this `fetch` does not reach git, which runs in its own process group; it ends on its own, at the latest when the connection drops, filed among infrastructure failures in the Flow, like an unreadable default branch. This `fetch` happens for every run on a worktree, before its preparation, which then does not fetch again: the branch of a new worktree takes its name from the config (ORC-283). It also happens for a knowledge run. For a question or a review, the config is read from what the preparation of its clone just fetched. That `fetch`, and the knowledge base's own when a run prepares it, have the same delay and the same message. The refusal message contains neither the repository's path on the server nor the git command: the details are in the daemon's log. It only suggests `git remote set-head origin --auto` when `origin/HEAD` is missing from the factory's repository.
- **On each `verify`**, on the forge's default branch, fetched at that moment into a separate clone (ORC-151): `commands`, `setup`, `env`, `max_diff` and `dependencies`, and the [Semgrep rules](#semgrep-rules) under `.factory/semgrep/`.
- **An invalid file refuses the launch**: the ticket is blocked with the `factory validate` message (« Repository configuration to fix: .factory/config.yml refused: … »), without a new worktree, without a sandbox or run. No run starts on a half-read config. The Flow files it under « Invalid repository configuration », not among failures. A `.factory` or a `config.yml` that is a symbolic link is refused likewise: git reads nothing through a link. Fix the file on the default branch, then relaunch.
- **The agent cannot change its run's config.** `.factory/**` is a forbidden path: `verify` blocks a commit that touches it (`factory/chemins-interdits`), and the next run reads the file from the default branch again. A config change goes through a human PR, merged on the default branch.

## Example

```yaml
extends: factory/default@1.0
setup: pnpm install --frozen-lockfile && pnpm db:migrate
commands: { lint: pnpm lint, typecheck: pnpm typecheck, test: pnpm test }
env: [NODE_ENV]                              # names; the values are in factory.yml
setup_secrets: [NPM_TOKEN]                   # setup only, sealed before the agent
services: [postgres]
sensitive_paths: ["src/auth/**", "src/billing/**", "db/migrations/**"]
budgets: { per_ticket_tokens: 2000000 }      # to be calibrated (ORC-216)
max_diff: { files: 15, lines: 400 }          # excluding tests; can only tighten
feature_flags: { provider: openfeature }    # optional
visual_paths: ["src/components/**", "app/**"]
network: { level: custom, allow: ["docs.exemple.com"] }    # none | limited (default) | custom; `allow` for custom only
dependencies: { allow: { npm: [zod, "@types/node"], pypi: [requests] } }   # the packages a branch may add; none without a list
branches: { pattern: "{type}/{id}-{slug}", types: { Bug: fix, default: feat } }   # the default
```

## Keys

| Key | Type | Default | Role |
| -- | -- | -- | -- |
| `extends` | text | `factory/default@1.0` | The preset; only `factory/default@1.0` exists in the MVP. |
| `setup` | command | none | Repository preparation (install, migrations), run on each new worktree before the agent; `verify` reruns it on its fresh clone, at `limited` and without secrets, before its commands. Absent: the workflow's `workspace.setup`. |
| `commands` | `name: command` | `{}` | The repository's checks (`lint`, `typecheck`, `test`…), run by `verify` in file order, at network level `none`. Empty: the workflow's `jobs.<job>.verify`, until ORC-177. |
| `env` | list of names | `[]` | Variables the runner receives: `setup`, agent, red check, and `verify`. See [Variables and secrets](#variables-and-secrets). |
| `setup_secrets` | list of names | `[]` | Secrets that only `setup` receives, sealed before the agent starts. |
| `services` | list | `[]` | Services the factory starts next to each attempt: `postgres` only, with sandboxes (see [Services](#services)). Another name, or any on a daemon without sandboxes, refuses the launch. |
| `sensitive_paths` | list of globs | `[]` | Globs from the root (`infra`, `src/auth*`, `**/migrations/**`, `src/**/*.sql`), dotfiles included and case ignored; a pattern that names a directory protects everything under it. What a branch changes in them once an untrusted run worked on it is refused by `verify` and the publication. A trusted branch may change them ([workflow](workflow.md#lifecycle-events-not-configurable)); its PR is then labelled `revue: requise` (ORC-198, [preset](preset.md#the-class-of-the-diff-and-the-review-label-orc-198)). |
| `budgets.per_ticket_tokens` | integer > 0 | none | Token cap for the ticket's code runs (questions do not count): past it, the ticket is blocked before its next code run (ORC-340), kind `budget` (ORC-216). It can only lower the cap of `factory.yml`; `factory validate` refuses the preset when its worst case exceeds the lower of the two. |
| `max_diff` | `{ files, lines }` | `{ 15, 400 }` | Maximum diff size excluding tests; can only be tightened. |
| `feature_flags.provider` | text | none | Feature flag provider. |
| `visual_paths` | list of patterns | `[]` | Paths that require visual proof (ORC-176): a diff that touches one makes `verify` take captures before and after ([workflow.md](workflow.md#jobs)). Matched as `sensitive_paths`, from the root. |
| `network` | `{ level, allow }` | `limited`, `[]` | The agent's network level: `none`, `limited` or `custom`. See [The agent's network](#the-agents-network). |
| `dependencies.allow` | `{ npm, pypi }`, lists of names | none | The packages a branch may add, exact names (PyPI compared after normalisation, `Typing_Extensions` is `typing-extensions`). An ecosystem without a list allows nothing there. See [Dependencies](#dependencies). |
| `branches` | `{ pattern, types }` | `{type}/{id}-{slug}`, `{ Bug: fix, default: feat }` | How the factory names a ticket's branch. See [Branch names](#branch-names). |

## Variables and secrets

A variable only enters the runner if **the repository declares its name** here and **the server gives its value** in `factory.yml` (`repos[].env`, `repos[].secrets`, see [`configuration.md`](configuration.md)). The repository therefore cannot request a daemon variable, and the server puts nothing into a runner that the repository has not declared. A name declared without a value stays absent, and the daemon logs it.

Refused: a name that is not made of uppercase letters, digits and `_`; names reserved for the factory (proxy and authority, `PATH`, `LD_*`, `NODE_OPTIONS`, `ANTHROPIC_*`, `CLAUDE*`, `FACTORY_*`, `LINEAR_*`, `GH_*`, `GITHUB_*`, `GIT_*`, `PIP_*`, `UV_*`, `YARN_*`, `NPM_CONFIG_*`…); under `env`, a secret name (`*_TOKEN`, `*_KEY`, `*_SECRET`, `DATABASE_URL`…), which the agent would see, and a name also present under `setup_secrets`.

## The `setup`

The `setup` runs in its own container, at network level `limited`, with the worktree writable and its `.git` directory **read-only**: a command that writes into `.git` (`git submodule update`, `git lfs pull`, a hook installed by husky) fails. This container is destroyed at the end, along with its `$HOME` (`/tmp/setup-home`) and its `/tmp`: the agent only finds what the `setup` wrote into the worktree.

It runs under these settings, set through the environment:

| Setting | Variables | Effect |
| -- | -- | -- |
| No install scripts | `npm_config_ignore_scripts`, `YARN_ENABLE_SCRIPTS`, and a `~/.yarnrc` for Yarn 1 | npm, pnpm and Yarn run no `postinstall`. An explicit command (`npm run db:migrate`) still runs. A native build at install time therefore does not happen. |
| Binary wheels | `PIP_ONLY_BINARY=:all:`, `UV_NO_BUILD=1` | No source package built at install time. uv still builds the project itself; pip refuses a package without a wheel. |
| Minimum age: 7 days | `npm_config_minimum_release_age`, `npm_config_before`, `UV_EXCLUDE_NEWER` | A version published less than 7 days ago is refused at resolution. A respected lockfile (`npm ci`, `uv sync --frozen`) keeps its versions. `uv sync --locked` fails on a lockfile made without this cap, and a plain `uv sync` rewrites `uv.lock` (it resolves again under the cap and records its date in `[options]`, a change the agent would find in its worktree): use `--frozen` (measured with uv 0.13.7, ORC-311). |

A repository command can override them (`--ignore-scripts=false`): these settings protect against a dependency, not against the repository itself.

Consequence of the separate container: whatever a tool stores in `$HOME` disappears. A Yarn PnP project with its global cache, a Poetry virtualenv under `~/.cache`, Playwright browsers must be installed in the worktree, otherwise the agent does not find them.

After the `setup`, before the agent, `sealSecrets` deletes any worktree file that contains a value from `setup_secrets`: as is, in base64, alone or within a longer value (`user:token`), in a URL or in JSON. A hashed or encrypted secret, or base64 split across lines, is not recognized: do not leave it in the worktree in another form.

The `setup` receives **no secrets** when its branch has commits beyond the default branch (a ticket resumed after its worktree was deleted): it would execute code no human has reviewed. A `setup` that needs a secret then fails, and the ticket is blocked.

## Services

`services: [postgres]` (ORC-309): each attempt gets a Postgres of its own, made for it and destroyed with it. The factory generates `DATABASE_URL` (`postgres://factory:<password>@127.0.0.1:5432/factory`, a random password for each database) and gives it to the `setup` and to the agent, in their containers' environment; it comes neither from the daemon nor from the repository, which cannot declare it under `env`. The database is empty: the `setup` fills it (`pnpm db:migrate`).

- **One database per attempt.** The `setup` and the agent of an attempt share it. A new attempt on a worktree already set up gets a new one, so its `setup` runs again, without `setup_secrets` (the worktree holds an earlier attempt's work, which nobody reviewed); if that fails, the ticket is blocked and the worktree stays.
- **`verify` has its own**, new, filled by its own `setup`, never the agent's: the agent cannot prepare the state its checks find.
- **Its role** owns the database and its `public` schema (migrations, trusted extensions such as `pgcrypto`), and is no superuser: a migration that needs one (an untrusted extension, `ALTER SYSTEM`) fails.
- **No route.** Postgres runs in a network of its own, without route (`--network none`), as its image's user, without capabilities, under the same limits as the attempt's container, its data in memory. The attempt's containers join its loopback, which has no route either: nothing out, and no other attempt reaches it.
- **Its secrets.** With `setup_secrets`, the database is dumped (`pg_dumpall`) once the `setup`'s container is gone, and searched for their values, in the spellings `sealSecrets` knows. A value found there blocks the ticket, naming the secret, never its value, and no agent starts. A secret transformed (hashed, encrypted, in a `bytea`) is not recognized, as on the disk.
- **Gone with the attempt**: with its container, when the attempt ends, when its `setup` fails, and at the daemon's next start for an attempt that did not survive it.
- **Provided, or refused (ORC-282).** A service no sandbox backend of the factory provides (any but `postgres`), or any service on a daemon without sandboxes (`FACTORY_CONTAINER_CLI` unset), refuses the launch before the `setup`: no sandbox, no run, and the ticket is blocked with a message that names the service. `verify` refuses the same way a commit whose `.factory/config.yml` declares one, before any of its code runs. Never a run in an environment poorer than the one declared.
- The red check of a `tests` step gets no database. The visual proof gets none either, so it takes no capture: a required proof is unavailable, naming the services (see the known gaps in [`ports/sandbox-provider.md`](ports/sandbox-provider.md#known-gaps)).

## Branch names

The factory names the branch of each ticket it works on by the team's convention (ORC-283): `fix/<id>-<slug>` for a ticket with the Linear label `Bug`, `feat/<id>-<slug>` otherwise, `<id>` being the ticket's identifier in lowercase (`orc-283`) and `<slug>` its title's (`export-csv-des-audits`, at most 40 characters). A repository sets its own with `branches`:

```yaml
branches:
  pattern: "agent/{type}/{id}"               # {type}, {id} (required), {slug} (optional)
  types: { Security: sec, Bug: fix, default: work }
```

- `pattern` takes three variables: `{type}`, `{id}` and `{slug}`. `{id}` is required, so that two tickets never share a branch, and it stands between separators (`/`, `-`, `_`, `.`) or at an end of the pattern, so that `orc-1` never reads as the start of `orc-12`.
- `types` maps a Linear label (compared without case) to a type. Its labels are tried in the order the file lists them; the first one the ticket carries gives the type. `default` is the type of a ticket that carries none of them, `feat` when left out. Set, `types` replaces the default map whole: `{ Chore: chore }` drops `Bug: fix`.
- Each part left out keeps the default.

`factory validate` and the launch refuse, like any other invalid configuration: a pattern without `{id}`, an unknown variable (`{title}`) or a brace that opens or closes none, an `{id}` glued to a neighbour (`{id}{slug}`, `x{id}`), a name git does not take as a branch (`git check-ref-format`: `..`, a space, `~^:?*[\`, a part that starts with `.` or ends with `.lock`, a leading or trailing `/`…, tried for every type), and a name that collides with the default branch (equal to it, under it as a folder, `main/{id}`, or holding it as one). The launch knows the default branch (`origin/HEAD`); `factory validate` on a file alone checks the rest.

The name is given once per ticket. The first run that makes its worktree records it on the ticket, and the next runs keep it, even if its labels or this file change since: a ticket never gets a second branch, nor a second PR. A ticket whose branch already exists under the name the factory gave before ORC-283, `factory/<id>-<slug>` (its PR open, say), keeps that branch.

The factory recognizes its own branches by the branch recorded on its ticket, and by its GitHub App as the author of its pushes (the GitHub reconciliation and the webhooks, ORC-185, ORC-281), no longer by a prefix. The `not_started` pickup check and the duplicate search look for the ticket's branches by this naming, every type and title, and by the legacy name. Because these branches look like a human's, `factory doctor` asks every CI job that sees a secret to keep the factory's App out or to wait for a human approval ([github.md](github.md#factory-doctor-ci-secrets-and-factory-branches)).

## What a configuration cannot do

A `sensitive_paths` entry that names nothing in the repository is not refused but left out, with a warning from `factory validate` and in the daemon's log: a drive (`C:/infra`), one that climbs out (`../x`), the root itself (`.`, `./`, `/`), a `.` or empty segment (`a/./b`, `{./infra,db}/**`), an absolute path or a climb inside a brace (`{src,/etc}`), or one that does not compile as a glob (too long). A branch that took untrusted content is refused, as a config failure, until it is fixed (ORC-338). `\` is read as `/`, and a leading `/` or `./` as the root (`/infra/**` is `infra/**`).

A configuration **adds** checks or prohibitions, it never **removes** any from the baseline. `factory validate` refuses, with the path of the offending key:

- an unknown key, such as `checks: { disable: [...] }`: nothing can turn off a baseline check, and a silently ignored key would suggest otherwise;
- a negative pattern (`!…`) in `sensitive_paths` or `visual_paths`: it would remove a path;
- a `max_diff` wider than the baseline (15 files, 400 lines);
- `network.level: full`, reserved for `setup`, never for the agent; in `network.allow`, anything that is not a hostname (`*`, `*.com`, `0.0.0.0/0`): a wildcard or a range would amount to `full`; and an `allow` list under a level other than `custom`, which would open nothing;
- a pattern in `dependencies.allow` (`@org/*`): exact names only;
- a preset other than `factory/default@1.0`.

The baseline's forbidden paths (`.github/**`, `CODEOWNERS`, `.env`, `.envrc`, `.env.*` but `.env.example`, `.env.sample` and `.env.template`, `.factory/**`, `.claude/**`, `.git/hooks/**`, `.git/config`, `.gitattributes`, `.gitmodules`, `.npmrc`, `.yarnrc*`, `.yarn/releases/**`, `.yarn/plugins/**`, `.pnpmfile.cjs`, `setup.py`, `package.json#scripts`, `.husky/**`, `.vscode/**`, `Dockerfile*`, `.devcontainer/**`, `claims/**`, outgoing symbolic links) always remain forbidden to the agent, whatever the file declares. `factory/chemins-interdits` blocks them in `verify` and on the publication, at any depth, except `.github/**` and `claims/**`, read at the root (ORC-151, ORC-338).

`custom` is `limited` plus the repository's hosts: it is the `limited` ceiling against which the preset's steps are checked; `none` is the `none` ceiling.

## Dependencies

`verify` runs `factory/dependances` (ORC-165, ORC-371) on the dependencies a branch adds to its manifests: `package.json` (its dependency sections, `overrides`, `resolutions`, `pnpm.overrides`), `pyproject.toml` and the requirements files (`*requirements*.txt`, `constraints*.txt`, `requirements/*.txt`, `.in` too). A package is added when no manifest declared it at the fork point; a version bump, a move between sections or files, or a removal adds nothing. Each added package must exist in its registry (npm, PyPI) and be on `dependencies.allow` of the default branch, read as the rest of this file is, never on the agent's branch. Otherwise the publication is blocked, with the cause. A source outside the registry (git, URL, a path outside the repository), another package index, and a changed file that steers installs without being read (`setup.cfg`, `Pipfile`, `uv.toml`…) block too. A path inside the repository (`workspace:`, `-e .`) is code of the branch: it does not block. Lockfiles are not read.

The manifests are read from the clone's objects, before any code of the branch has run, and the registries are asked by the daemon through the egress proxy, at `limited`, reads only: the sandboxes of `verify` stay without network. A registry that does not answer stops `verify` as a breakdown, without a verdict: a registry down is no fault of the branch.

## Semgrep rules

`verify` runs Semgrep (`factory/semgrep`, ORC-333) on the lines a branch adds, with two sets of rules: the factory's base of security rules (`docker/semgrep/` in the factory, copied into the runner image: code built at run time, shell commands built from a value, TLS verification turned off, unsafe deserialization, in JavaScript, TypeScript and Python), and the repository's own, the `.yml` and `.yaml` files under `.factory/semgrep/` of the default branch, in [Semgrep's rule syntax](https://semgrep.dev/docs/writing-rules/rule-syntax). They are read as `.factory/config.yml` is, never on the agent's branch, and without network: a rule of the Semgrep registry (`p/...`) does not load. Every finding blocks, at any severity. A finding on a line the branch did not write is the base's and does not block. A rule file Semgrep refuses stops `verify` as a breakdown, without a verdict, until the default branch fixes it.

## The agent's network

Each agent run takes the repository's level, read at launch, narrowed by its step's:

| `network.level` | What the agent reaches |
| -- | -- |
| `limited` (default) | The Claude API, GitHub and registries read-only, the docs on the factory's list. |
| `custom` | `limited`, plus the hosts in `network.allow`, read-only. |
| `none` | The Claude API only (`claude-api`): without it, the agent does not run. |

A step can only narrow it (ORC-183): the build, its fixes and intake run at `limited` at most, the AI review at `claude-api`, the Claude API alone, whatever the repository's level. `ask` has no step: the answer agent sets its own level, `claude-api` (ORC-182). After a daemon restart, a resumed run keeps its level but loses the `allow` list: it can only become more restricted.

## Checking

```bash
factory validate            # the current repository
factory validate ../mon-depot
```

Exit code 0 if the file is valid (or absent), 1 otherwise, with one line per violation and the path of the offending element (`sensitive_paths[1]`, `commands.test`). A `.factory/config.yaml` is refused: the factory only reads `config.yml`.
