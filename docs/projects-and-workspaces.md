# Projects, worktrees and knowledge base

## Projects

A Relais **project** associates a local git repository with a Linear team. They are listed in `projects` in `<RELAIS_HOME>/config.yaml`:

```yaml
projects:
  - id: mon-app                       # internal identifier (directories, API)
    repoPath: /home/moi/code/mon-app  # local clone, with an origin remote
    linearTeamKey: APP                # key of the tracked Linear team
```

Rules:

- tickets are routed by team key; a delegation on a team without a project is blocked, the rest ignored ([`linear.md`](linear.md#4-using-the-agent-day-to-day)). A team can have several projects: see [One team, several repositories](#one-team-several-repositories);
- each project's behavior comes from its `.relais/workflow.yml` ([`workflow.md`](workflow.md)), read from the `repoPath` working copy at startup;
- `repoPath` must be a clone with `origin`: Relais runs `git fetch origin` there and copies its objects for each workspace. You can keep working in it. The agents' commits only reach it through the forge.

### Adding a project

```bash
cd <other repository>
relais init        # same Linear application key: answer with the same credentials
```

`init` adds the project (or replaces the one with the same `repoPath`) and creates its `.relais/workflow.yml`. Then restart `relais up`: the statuses and labels are created in the new team on the next Linear connection (« Connect Linear » button or `/oauth/start`).

> The queue capacities (`parallel_sessions`, `question_sessions`) are global and read from the workflow of the **first** project in the list. The other settings are specific to each project.

### One team, several repositories

Several projects can declare the same `linearTeamKey`. The ticket then designates its repository with a **`repo:<id>`** label, where `<id>` is the project's `id` in `config.yaml` (case-insensitive): `repo:api` sends the ticket to the `api` project. Create these labels in the Linear team.

- Team with a single project: nothing changes, the label is useless and ignored.
- The label is only read for a ticket no project holds yet, at its delegation (or at a mention, a command). **Routing is sticky**: a delegated ticket, or one that already has a branch or a PR, stays under its project, whatever its labels say afterwards, and a project added to the team takes no existing ticket. Adding the label of another repository of the team to a ticket in progress changes nothing: Relais replies in a comment that the repository does not change midway. Without a branch or PR, you change it by stopping the work and removing the delegation, then, once the removal is seen by reconciliation (up to 5 minutes: no webhook reports it), delegating again; otherwise, a new ticket is needed. A `repo:` label that names no repository of the team is ignored. A reply or a stop on a ticket no project holds also follows its label, including when its delegation has not been processed yet: without a label, it receives the question; with a label, a reply goes to the copy of the ticket that opened its session.
- Ticket without a `repo:` label naming one of the projects: the delegation is blocked (label « Bloqué ») and the Linear session asks for the label, with the list of choices. The ticket waits under the team's **first** project (order of `config.yaml`), even if it was blocked for another reason, which it replaces. A cancellation or a move to done ends the wait. While it waits, a reply, a mention, a command or a stop receives the same question, and nothing else (status, label) starts work: no work starts in a repository chosen by default.
- To unblock: add the `repo:<id>` label, then delegate the ticket again (remove the agent then put it back): the work starts in that repository, including if it is the one where the ticket was waiting, and the « Bloqué » label is removed. Both stores keep a copy of the ticket per project: the one that was waiting stays under the first project until reconciliation ends it. The new delegation is necessary: reconciliation does file the ticket under its repository and removes the waiting ticket from the first project (its block lifted), but a delegation it finds has no signed author, and permissions (ORC-186) start nothing without an author.
- Several valid `repo:` labels: the first project in the list among them wins. A ticket that touches several repositories is split into one sub-ticket per repository.

Only one project holds a ticket, across both stores (key `(project, ticket)`, ORC-316). While another project of the same team holds it, an event routed on a stale read (a reconciliation pass that read Linear before a signed delegation, for example) is refused if it would create a copy of the ticket, or if it would make the copy that was waiting here hold the ticket. The ticket stays intact, the refusal is logged as an error, and the event is set aside as a dead letter, with no retry and without blocking the ticket. The ticket's session says so (a `thought` activity, which does not change the session's state), and the session the event came from replies if it is a different one; `factory run repair <ticket>` shows it. Ignoring it closes it; replaying it refuses it again as long as the other project holds the ticket. The row of a project that is no longer in the configuration (renamed, for example) refuses nothing: its events create a copy under the new id, and the old row remains, unrelated to it.

`relais plan` lists each ticket once, under its project, and marks « repository to specify » those that name none.

### Removing a project

Delete its entry from `config.yaml` and restart. The remaining directories under `workspaces/<id>/` are deleted like any directory.

## Per-ticket worktrees

Each job declares a workspace type (`workspace` in [`workflow.md`](workflow.md#jobs)):

| Type | Location | Used by (pack) |
|---|---|---|
| `worktree` | `<RELAIS_HOME>/workspaces/<project>/<ticket>/`, branch `relais/<ticket>-<title>` | `dev`, `dev-feedback`, `fix-ci`, `review` |
| `trunk-readonly` | `<RELAIS_HOME>/workspaces/<project>/_trunk/<runId>/`, detached on `origin/<default branch>` | `ask` and `intake` (`Read`, `Grep` and `Glob` only, ORC-367, ORC-182) |

These are not `git worktree`s of the repository: each is a repository of its own, with its `.git` and its copy of the objects, so that nothing the agent writes there is read by the host's git ([security](interface-and-security.md), ORC-317). `git worktree list` therefore does not show them, and disk space counts one copy of the history per ticket and per question.

Lifecycle of a ticket worktree:

1. **Creation** on the first run: `git fetch origin`, then a new repository on the ticket's branch (reuses a remote branch, failing that a local one, with the same name, otherwise creates it from `origin/<default branch>`). `.claude/` is masked there from that moment, except `.claude/CLAUDE.md`, including for the `setup`.
2. **Setup**: the `workspace.setup` commands (e.g. `npm ci`) are run once, in order, via `bash -c`, in the attempt's container when `FACTORY_CONTAINER_CLI` is set, on the host otherwise. If one fails, the worktree is deleted and the ticket blocked (« Launch error: The worktree setup failed: <command> »); the next run starts from scratch.
3. **Reuse**: the ticket's following runs (feedback, CI, review) pick up the same worktree, without setup.
4. **Cleanup**: when the PR is merged (rule `pr.merged` → `do: after_merge`, which ends with the cleanup, ORC-197), the directory is deleted, its `.git` with it: a commit the agent had not pushed disappears.

Each question has its own `_trunk/<runId>/`, created for it and deleted when it ends.

What is **not** cleaned up automatically (to do by hand if disk space matters): directories of tickets whose PR was closed without merging or that were abandoned, the `_kb/<runId>` directories the `learn` and `remember` runs left before ORC-193, and a `_trunk/<runId>` whose daemon was killed mid-run. They are deleted like any directory, and git keeps no trace of them.

### `workspace.setup` and checks

- `setup`: prepare a new worktree (dependencies, generated files). Run at creation only.
- `jobs.<job>.verify`: checks run by **Relais** (not by the agent) after each successful run, 15 minutes maximum per command. On failure, Relais reruns the job with the error output, then blocks the ticket after `limits.verify_attempts` passes (4 by default, the preset's bound), or as soon as the third identical failure on an unchanged worktree (cause « Loop »).

Details and examples: [`workflow.md`](workflow.md#workspace).

### Ports

Each run in the `dev` queue receives a `PORT` variable unique among concurrent runs: `workspace.ports.base` (4200 by default) + slot number (0 to `parallel_sessions - 1`). If your tests or your dev server read `PORT`, several tickets can run in parallel without conflict. Runs in the `questions` queue do not receive one.

## Shared knowledge base

A separate git repository, shared by all projects of the instance, that holds what is worth remembering (conventions, pitfalls, decisions). Agents read it; none writes to it (ORC-193):

```text
relais-knowledge/
├── INDEX.md        # one line per note
└── notes/*.md      # one note per topic
```

How it is used:

- **reading** (ORC-232): at each launch, the server reads `INDEX.md` and hands its first 8,000 characters to the session in its system prompt, as data; an index past that cap ends on a visible `[… INDEX.md truncated …]` marker and the daemon logs the cut. The agent, the answer agent included, searches the notes with the factory MCP's `kb_search` tool, which the server answers from its clone: the session gets the index and the matching lines, never the repository, which no sandbox mounts any more;
- **updating**: before a launch, the server runs `git fetch origin` (60 s at most) then `git merge --ff-only` on the clone of `refs/remotes/origin/<default branch>` in full, never a tag of that name, once for the launches that come together or within 30 s of the last pull; the clone must therefore stay on its default branch, with no local commits. A clone without a remote, or on another branch, is not pulled: the daemon logs `Knowledge base: …` saying why, and the agents read it as it is;
- **writing**: asleep at the MVP (ORC-193). No job writes to it any more: neither `learn` after a merge nor `remember` (the `retiens` command is gone, a `@relais retiens …` is a message as any other). Humans edit the repository; the `learn` PRs still open are closed or merged by hand. Writing comes back in another form, fed only by signed human signals (ORC-247).

### Setup

`relais init` no longer creates the repository (ORC-193). For an existing repository, record its clone in `config.yaml`; to create one:

```bash
gh repo create relais-knowledge --private --add-readme --clone
cd relais-knowledge
mkdir -p notes && touch notes/.gitkeep && printf '# Base de connaissance Relais\n\n' > INDEX.md
git add . && git commit -m "init knowledge base" && git push
```

then in `config.yaml`:

```yaml
knowledge:
  repoPath: /chemin/absolu/vers/relais-knowledge
```

Without `knowledge`, everything works: no index in the system prompt, and `kb_search` answers that the factory has no knowledge base.

There is also **per-repository** knowledge, with no configuration: the skills read the repository's `CLAUDE.md` and `docs/agent/` if they exist.
