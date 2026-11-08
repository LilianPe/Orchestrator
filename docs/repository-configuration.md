# Repository configuration: `.factory/config.yml`

A repository can declare its commands, its sensitive paths and its limits to the factory in `.factory/config.yml`, at the root. The file is optional: without it, the `factory/default` baseline applies as is.

**Status (ORC-209).** The schema, `factory validate` and reading by the daemon exist (see [When and where it is read](#when-and-where-it-is-read)). Applied to runs: `setup`, `env`, `setup_secrets` and `network` at launch, `commands`, `setup` and `env` on each `verify`, `sensitive_paths` on each `verify` and publication of a branch an untrusted run worked on, on what it changed since (ORC-338). `budgets.per_ticket_tokens` at each launch (ORC-340) and by `factory validate`'s worst case (ORC-216). Read and validated, but not yet applied: `services` (ORC-282, ORC-309), `max_diff` (ORC-145, ORC-125), `visual_paths` and `feature_flags`.

## When and where it is read

- **At the launch of each agent run**, only once, on the forge's default branch, fetched just before into the factory's repository (`git fetch origin`, then `origin/HEAD`): never in the agent's worktree, nor on its branch. The agent cannot write this ref: its git directory is its own (ORC-317). The run takes its `setup`, its variables and its network level from it, and keeps it: whatever checks it afterwards (the red check, `verify` on the host without a sandbox) reuses this read, even if the default branch has changed in the meantime.
- **The config `fetch` is capped at 2 minutes**, without prompting for credentials: past that delay, git is killed with what it started in its process group (its ssh), on Linux and macOS; on Windows, git alone. The launch is then refused (« Launch error: the forge no longer responds after 120 s »), and it never waits more than a few seconds beyond, even if a process that left that group (an ssh `ControlPersist`, a helper that detaches) keeps git's output open. A `fetch` that ends before the delay gives its own result, never « no longer responds ». Known limit: a Ctrl-C or a daemon stop during this `fetch` does not reach git, which runs in its own process group; it ends on its own, at the latest when the connection drops, filed among infrastructure failures in the Flow, like an unreadable default branch. This `fetch` only happens for a worktree that already exists, and for a knowledge run. For a new worktree or a question, the config is read from what the worktree preparation just fetched. That `fetch`, and the knowledge base's own when a run prepares it, have the same delay and the same message. The refusal message contains neither the repository's path on the server nor the git command: the details are in the daemon's log. It only suggests `git remote set-head origin --auto` when `origin/HEAD` is missing from the factory's repository.
- **On each `verify`**, on the forge's default branch, fetched at that moment into a separate clone (ORC-151): `commands`, `setup` and `env`.
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
```

## Keys

| Key | Type | Default | Role |
| -- | -- | -- | -- |
| `extends` | text | `factory/default@1.0` | The preset; only `factory/default@1.0` exists in the MVP. |
| `setup` | command | none | Repository preparation (install, migrations), run on each new worktree before the agent; `verify` reruns it on its fresh clone, at `limited` and without secrets, before its commands. Absent: the workflow's `workspace.setup`. |
| `commands` | `name: command` | `{}` | The repository's checks (`lint`, `typecheck`, `test`…), run by `verify` in file order, at network level `none`. Empty: the workflow's `jobs.<job>.verify`, until ORC-177. |
| `env` | list of names | `[]` | Variables the runner receives: `setup`, agent, red check, and `verify`. See [Variables and secrets](#variables-and-secrets). |
| `setup_secrets` | list of names | `[]` | Secrets that only `setup` receives, sealed before the agent starts. |
| `services` | list | `[]` | Services to start next to the runner (`postgres`…). |
| `sensitive_paths` | list of globs | `[]` | Globs from the root (`infra`, `src/auth*`, `**/migrations/**`, `src/**/*.sql`), dotfiles included and case ignored; a pattern that names a directory protects everything under it. What a branch changes in them once an untrusted run worked on it is refused by `verify` and the publication. A trusted branch may change them ([workflow](workflow.md#lifecycle-events-not-configurable)). |
| `budgets.per_ticket_tokens` | integer > 0 | none | Token cap for the ticket's code runs (questions do not count): past it, the ticket is blocked before its next code run (ORC-340), kind `budget` (ORC-216). It can only lower the cap of `factory.yml`; `factory validate` refuses the preset when its worst case exceeds the lower of the two. |
| `max_diff` | `{ files, lines }` | `{ 15, 400 }` | Maximum diff size excluding tests; can only be tightened. |
| `feature_flags.provider` | text | none | Feature flag provider. |
| `visual_paths` | list of patterns | `[]` | Paths that require visual proof (ORC-176). |
| `network` | `{ level, allow }` | `limited`, `[]` | The agent's network level: `none`, `limited` or `custom`. See [The agent's network](#the-agents-network). |

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

## What a configuration cannot do

A `sensitive_paths` entry that names nothing in the repository is not refused but left out, with a warning from `factory validate` and in the daemon's log: a drive (`C:/infra`), one that climbs out (`../x`), the root itself (`.`, `./`, `/`), a `.` or empty segment (`a/./b`, `{./infra,db}/**`), an absolute path or a climb inside a brace (`{src,/etc}`), or one that does not compile as a glob (too long). A branch that took untrusted content is refused, as a config failure, until it is fixed (ORC-338). `\` is read as `/`, and a leading `/` or `./` as the root (`/infra/**` is `infra/**`).

A configuration **adds** checks or prohibitions, it never **removes** any from the baseline. `factory validate` refuses, with the path of the offending key:

- an unknown key, such as `checks: { disable: [...] }`: nothing can turn off a baseline check, and a silently ignored key would suggest otherwise;
- a negative pattern (`!…`) in `sensitive_paths` or `visual_paths`: it would remove a path;
- a `max_diff` wider than the baseline (15 files, 400 lines);
- `network.level: full`, reserved for `setup`, never for the agent; in `network.allow`, anything that is not a hostname (`*`, `*.com`, `0.0.0.0/0`): a wildcard or a range would amount to `full`; and an `allow` list under a level other than `custom`, which would open nothing;
- a preset other than `factory/default@1.0`.

The baseline's forbidden paths (`.github/**`, `CODEOWNERS`, `.env`, `.envrc`, `.env.*` but `.env.example`, `.env.sample` and `.env.template`, `.factory/**`, `.claude/**`, `.git/hooks/**`, `.git/config`, `.gitattributes`, `.gitmodules`, `.npmrc`, `.yarnrc*`, `.yarn/releases/**`, `.yarn/plugins/**`, `.pnpmfile.cjs`, `setup.py`, `package.json#scripts`, `.husky/**`, `.vscode/**`, `Dockerfile*`, `.devcontainer/**`, `claims/**`, outgoing symbolic links) always remain forbidden to the agent, whatever the file declares. `factory/chemins-interdits` blocks them in `verify` and on the publication, at any depth, except `.github/**` and `claims/**`, read at the root (ORC-151, ORC-338).

`custom` is `limited` plus the repository's hosts: it is the `limited` ceiling against which the preset's steps are checked; `none` is the `none` ceiling.

## The agent's network

Each agent run takes its preset step's level ([`preset.md`](preset.md#models-effort-turns-network)), narrowed by the repository's, read at launch (ORC-322). The repository's level is the ceiling:

| `network.level` | What the agent reaches |
| -- | -- |
| `limited` (default) | The Claude API, GitHub and registries read-only, the docs on the factory's list. |
| `custom` | `limited`, plus the hosts in `network.allow`, read-only. |
| `none` | The Claude API only (`claude-api`): without it, the agent does not run. |

The review runs at `claude-api`, whatever the repository's level: it reaches neither GitHub nor the registries, and the `allow` hosts of a `custom` repository are not its own. It installs no package either: a review fix that needs a new dependency fails, and goes into its last message as a point to decide. The other jobs with a step run at the repository's level: `dev` (step `build`), `tests` (step `tests`), `dev-feedback` and `fix-ci` (step `fix`) (their step's `limited`, narrowed by it); the preset's other agent steps have no job yet. A job out of the preset (`ask`, `learn`) keeps the repository's level. After a daemon restart, a resumed run keeps its level and its `allow` list, both read back from its container's labels.

### The review's PR, brought by the factory (ORC-322)

The review needs the PR's state and its latest commits, but has no network. The factory does that work for it:

1. **Before the run**, the factory reads the PR on the forge (number, state, base, mergeable, URL), on its own repository just fetched. It bundles the PR's head and base, less what the agent's `origin/<branch>` and `origin/<base>` already hold (`git bundle`), into the run's `pr/` folder, mounted read-only in the sandbox at `/run/factory/pr`. The agent's git imports that file into `origin/<branch>` and `origin/<base>`, in the sandbox: the host never runs git in the agent's repository (ORC-317). The factory then fast-forwards the branch to the PR head when only the forge has new commits. The prompt carries all of this in a `## Pull request` section.
2. **During the run**, `factory-agent pr` does the same on demand: a fetch of the factory's repository, a new bundle, the agent's refs updated, the PR's state printed. A human who pushed during the review shows up there, in `origin/<branch>` only: the factory moves the branch at the launch alone. The skill fast-forwards onto those commits and reviews them in a round of their own, or, with no round left or branches that have diverged, leaves them out and says so.

Whatever the factory cannot read (a forge that does not answer, a bundle that fails) is noted in the prompt as "could not read" or "not read by the factory", and the reason goes to the daemon's log, never to the agent, since it names host paths. The review then starts anyway and asks again with `factory-agent pr`.

Before ORC-322, the review ran `gh pr view` and `git fetch origin` itself. Since ORC-317 the agent's repository has no credential, so `git fetch origin` only worked at `limited`, on an HTTPS origin readable without a token (a public repository).

## Checking

```bash
factory validate            # the current repository
factory validate ../mon-depot
```

Exit code 0 if the file is valid (or absent), 1 otherwise, with one line per violation and the path of the offending element (`sensitive_paths[1]`, `commands.test`). A `.factory/config.yaml` is refused: the factory only reads `config.yml`.
