# Dry run of a repository (ORC-408)

Before the factory takes tickets on a repository, it checks that the repository's own state lets a run succeed: its `setup`, then
its build and test commands, on its default branch, in the sandbox, as `verify` would run them for a ticket. This is the dry run.
It records what breaks, classified, and a fingerprint of what it ran with.

A delegated ticket waits for it: while the repository's last dry run is red, its tickets are refused, and the dry run runs again
when what it ran with changes (ORC-409, [below](#the-gate-of-a-delegated-ticket)). `factory dry-run <project>` runs it by hand
([CLI](cli.md#factory-dry-run-project-orc-409)).

## What runs

`Daemon.dryRun(projectId, { sha? })` (in `src/runtime/checks.ts`) runs `runDryRun` (`src/core/dry-run.ts`) and records the
result in the store:

1. **The commit.** The forge's default branch, or the commit `sha` when one is given (for the replay of closed tickets, on
   each ticket's start commit: `factory ghost start` does not call it yet, [ORC-231](ghost-replay.md)). It is fetched from the
   forge with the daemon's credentials into a clone of the factory's, with no config of the repository's. A commit the forge does
   not hold rejects: nothing is recorded.
2. **What it runs.** `.factory/config.yml` read at that commit: its `setup` and `commands`, or the workflow's
   (`workspace.setup`, the `dev` job's `verify`) when it declares none; its `services` and its `env`.
3. **The checkout**, in a sandbox at network `none`.
4. **The `setup`**, sealed as an attempt's is (`runSealedSetup`): in a sandbox of its own at network `limited` (N2: the package
   registries the egress proxy allows), with no secret, no install script, and nothing published in the last 7 days.
5. **The commands**, in a new sandbox at network `none`, with the repository's services and its declared variables. A failing
   test that the runner's report names (vitest, jest, pytest) is run again once, as in `verify`.

What the factory cannot tell anything about rejects, and nothing is recorded: the forge or the container engine not answering,
a `setup` that fails or runs over its cap with a registry or the egress proxy not answering in its output (a connection refused
or timed out, a 502, the proxy's 5xx to a `CONNECT` as curl and git say it, pip's or uv's connection or DNS error, pip's
`ProxyError`), even when it then says a dependency is missing. The relay refusing is read by its address, whatever the tool's
words: a line that says a connection was refused and names `127.0.0.1:3128` (or `localhost`, `[::1]`, curl's `port 3128`,
urllib3's `port=3128`) is a breakdown, from npm, curl, git, Go, wget, apt or Maven alike; a line that only names the relay
(`HTTPS_PROXY=http://127.0.0.1:3128`) is not. A setup that exited on a variable, or on a service refusing (a connection refused
on another port of the loopback, by any client: Node's `connect ECONNREFUSED`, Python's `requests`, `psycopg`, `redis-py` or
`asyncpg`, Go's `dial tcp`; or `could not connect to server`), is recorded red as such, past an installer's retry warning. A setup over its cap is a `failure`: a breakdown in its output rejects it, unless a service refusing is there too.
Reading the repository's variables failing (its entry in `factory.yml` not looked up) rejects too, and so does a factory without
sandboxes (`FACTORY_CONTAINER_CLI` and `FACTORY_RUNNER_IMAGE` are required). `sha`, when given, must be a full commit id: a branch name or a short sha is refused.

## What breaks

A dry run is **green** when nothing breaks, **red** otherwise. Each break names its step (`config`, `setup` or `command`), the
command, an excerpt of its output, and a detail line, classified as:

| Kind | Read from | Example |
|---|---|---|
| `dependency` | a dependency missing or too recent: npm, pnpm, Yarn, uv and pip resolution errors, `Cannot find module` of a package (by its npm name, or a path into `node_modules`), `No module named`; in the `setup` only, an installer's 404, `ETARGET`, `ERESOLVE`, a lockfile out of sync, or a registry the egress proxy refuses (a 403, to a `CONNECT` too) | `No matching version found for left-pad@9.9.9` |
| `service` | a service declared under `services` that no sandbox backend provides (step `config`), or a connection refused on a port of the loopback, whatever the client that says it (but the egress proxy's relay, `3128`) | `connect ECONNREFUSED 127.0.0.1:5432`, `HTTPConnectionPool(host='localhost', port=8000): … Connection refused` |
| `variable` | a variable the code asks for and does not get: one `.factory/config.yml` does not declare under `env`, or one it declares that `factory.yml` gives no value (no entry for the repository there, or none for that name), said apart. Each name of the line is read; a secret declared under `setup_secrets` is never one of them, so a line that names only secrets is no variable's cause. Without the word *variable* in the line, only a name with a `_` counts: `URL is not defined` is a global | `Missing environment variable: STRIPE_KEY` |
| `flaky` | a test that failed, then passed on its rerun. A test on the repository's known flaky list does not count | `src/a.test.ts > races failed, then passed on its rerun` |
| `failure` | anything else: a `.factory/config.yml` refused, a `setup` command over its cap with no breakdown in its output, a test that fails again | its first error line |

The classification reads text: what a tool prints in another form is a `failure`, with its first error line. A build or test
command over its cap is classified by what it printed, as any other. A command that failed on its flaky tests alone has only
`flaky` breaks; one that failed on more has a classified break besides.

The connections of the `setup` go through the egress proxy and its journal, but no run owns them: they are not in a run's
security log.

A flaky test makes the dry run red: the same flake would fail a ticket's `verify`. Put it on the repository's known flaky list
(`factory flaky`) to make it indicative.

## The fingerprint

Each dry run keeps the inputs it ran with:

- `setup`: a SHA-256 of the setup commands it ran;
- `image`: the runner image as configured (`FACTORY_RUNNER_IMAGE`). A tag that moves to another image without changing its name
  is not seen: pin the image by its digest (`…@sha256:…`);
- `lockfiles`: each lockfile at the commit's root, by its git blob id: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`,
  `bun.lock`, `deno.lock`, `uv.lock`, `poetry.lock`, `pylock.toml` and `pylock.<name>.toml`, `Cargo.lock`, `go.sum` and the others
  of `isLockfile` (`src/checks/diff-size.ts`): one list with the files `max_diff` does not count;
- `config`: the blob of `.factory/config.yml`, `null` without one (ORC-409): a dry run red on its `env`, its `services` or its
  `commands` runs again once the file is fixed;
- `hash`: a SHA-256 of them all, which the gate compares to decide whether to run it again.

`dryRunFingerprint` computes it from these inputs alone, without running anything.

## The gate of a delegated ticket

Before a ticket's first run (its `intake`, or the job that picks it up on a chain without one), the launch reads the project's
last dry run on the default branch (ORC-409). It reads, on the factory's repository just fetched, the default branch's head and the
fingerprint a dry run would have now: the `setup` of `.factory/config.yml` or the workflow's, the runner image, the lockfiles and
the config's blob.

- **It holds** when its fingerprint is the same, and, when it is red, when it ran on the same commit: a fix of the code on the
  default branch lifts a red dry run once the branch has moved. A green one holds over a branch that moved with the same inputs.
- **Otherwise it runs now**, and the launch waits for it: a project's first delegation runs its first dry run, so a first ticket
  never waits for a dry run nobody started. Two tickets delegated together wait for the same one; red on another commit than the
  one the second ticket's launch read (a fix pushed while it ran), the second runs a new one.
- **Green**, the ticket goes on. **Red**, it is refused before any run (unless another launch took the ticket while it ran): blocked as the repository's to fix (the Flow's `repo_config`
  cause), with a comment that says what breaks, each break with its step, its command and the line that names its cause, and how
  it runs again. A reply resumes the ticket, which goes through the gate again.
- **It cannot run** (the engine, the forge or a registry not answering): the launch fails, as any launch error, and nothing is
  recorded.

No gate without sandboxes, where no dry run can run (the host checks of `FACTORY_ALLOW_HOST_VERIFY`), nor for a replayed ticket
([ORC-231](ghost-replay.md)). A ticket already under way is never stopped by a red dry run: the gate is at its first run only.

What the fingerprint does not see (a variable's value in `factory.yml`, a registry that refused, a flaky test now on the known
list) needs `factory dry-run <project>` once fixed; the refused tickets then start on a reply.

## Where it is kept

The `dry_runs` table (Postgres, from migration `0016_dry_runs`), one row per dry run, the record whole in `data`.
`Store.lastDryRun(projectId)` reads the last one on the default branch; `Store.lastDryRun(projectId, sha)` reads the last one on
that commit. A dry run on a given commit is never taken for the default branch's.
