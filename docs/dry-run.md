# Dry run of a repository (ORC-408)

Before the factory takes tickets on a repository, it checks that the repository's own state lets a run succeed: its `setup`, then
its build and test commands, on its default branch, in the sandbox, as `verify` would run them for a ticket. This is the dry run.
It records what breaks, classified, and a fingerprint of what it ran with.

This page covers the run and its record (part 2 of ORC-208). Refusing tickets while the last dry run is red, and running it
again when its fingerprint changes, come with part 3 (ORC-409): until then nothing triggers a dry run by itself.

## What runs

`Orchestrator.dryRun(projectId, { sha? })` (in `src/core/orchestrator.ts`) runs `runDryRun` (`src/core/dry-run.ts`) and records the
result in the store:

1. **The commit.** The forge's default branch, or the commit `sha` when one is given (the replay of closed tickets runs it on
   each ticket's start commit, [ORC-231](ghost-replay.md)). It is fetched from the forge with the daemon's credentials into a
   clone of the factory's, with no config of the repository's. A commit the forge does not hold rejects: nothing is recorded.
2. **What it runs.** `.factory/config.yml` read at that commit: its `setup` and `commands`, or the workflow's
   (`workspace.setup`, the `dev` job's `verify`) when it declares none; its `services` and its `env`.
3. **The checkout**, in a sandbox at network `none`.
4. **The `setup`**, sealed as an attempt's is (`runSealedSetup`): in a sandbox of its own at network `limited` (N2: the package
   registries the egress proxy allows), with no secret, no install script, and nothing published in the last 7 days.
5. **The commands**, in a new sandbox at network `none`, with the repository's services and its declared variables. A failing
   test that the runner's report names (vitest, jest, pytest) is run again once, as in `verify`.

What the factory cannot tell anything about rejects, and nothing is recorded: the forge or the container engine not answering,
no sandboxes (`FACTORY_CONTAINER_CLI` and `FACTORY_RUNNER_IMAGE` are required).

## What breaks

A dry run is **green** when nothing breaks, **red** otherwise. Each break names its step (`config`, `setup` or `command`), the
command, an excerpt of its output, and a detail line, classified as:

| Kind | Read from | Example |
|---|---|---|
| `dependency` | a dependency missing or too recent: npm, pnpm, Yarn, uv and pip resolution errors, `Cannot find module`, `No module named`, a lockfile out of sync; in the `setup`, a registry that does not answer or that the egress proxy refuses | `No matching version found for left-pad@9.9.9` |
| `service` | a service declared under `services` that no sandbox backend provides, or a connection refused on the loopback | `connect ECONNREFUSED 127.0.0.1:5432` |
| `variable` | a variable the code asks for that `.factory/config.yml` does not declare under `env` | `Missing environment variable: STRIPE_KEY` |
| `flaky` | a test that failed, then passed on its rerun. A test on the repository's known flaky list does not count | `src/a.test.ts > races failed, then passed on its rerun` |
| `failure` | anything else: a `.factory/config.yml` refused, a command that times out, a test that fails again | its first error line |

The classification reads text: what a tool prints in another form is a `failure`, with its first error line. A command that
failed on its flaky tests alone has only `flaky` breaks; one that failed on more has a classified break besides.

A flaky test makes the dry run red: the same flake would fail a ticket's `verify`. Put it on the repository's known flaky list
(`factory flaky`) to make it indicative.

## The fingerprint

Each dry run keeps the inputs it ran with:

- `setup`: a SHA-256 of the setup commands it ran;
- `image`: the runner image as configured (`FACTORY_RUNNER_IMAGE`). A tag that moves to another image without changing its name
  is not seen: pin the image by its digest (`…@sha256:…`);
- `lockfiles`: each lockfile at the commit's root (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `uv.lock`, `poetry.lock`,
  `Cargo.lock`, `go.sum` and the others in `LOCKFILES`), by its git blob id;
- `hash`: a SHA-256 of the three, which part 3 compares to decide whether to run it again.

`dryRunFingerprint` computes it from these inputs alone, without running anything.

## Where it is kept

The `dry_runs` table (SQLite, and Postgres from migration `0016_dry_runs`), one row per dry run, the record whole in `data`.
`Store.lastDryRun(projectId)` reads the last one on the default branch; `Store.lastDryRun(projectId, sha)` reads the last one on
that commit. A dry run on a given commit is never taken for the default branch's.
