# Projects, worktrees and knowledge base

## Projects

A **project** associates a local git repository with a Linear team. They are listed in `projects` in `<FACTORY_HOME>/factory.yml`:

```yaml
projects:
  - id: mon-app                       # internal identifier (directories, API)
    repo_path: /home/moi/code/mon-app # local clone, with an origin remote
    linear_team_key: APP              # key of the tracked Linear team
```

Rules:

- tickets are routed by team key; a delegation on a team without a project is blocked, the rest ignored ([`linear.md`](linear.md#4-using-the-agent-day-to-day)). A team can have several projects: see [One team, several repositories](#one-team-several-repositories);
- every project runs the `factory/default` workflow ([`preset.md`](preset.md)); its own part is its `.factory/config.yml`, read on its default branch ([`repository-configuration.md`](repository-configuration.md)). A `.factory/workflow.yml` is ignored since ORC-388;
- `repo_path` is read for its `origin` alone, to know the repository on GitHub (below), until ORC-471 part 3 writes `github` in `factory.yml`: no git of the factory reads its objects, its branches or its working tree any more (ORC-479). The factory keeps its own bare **mirror** of each repository, `<FACTORY_HOME>/repos/<owner>/<name>`: made in the background at the start, the server not waiting for a first clone (a launch that comes meanwhile waits for it; one the forge could not give is made at the next launch), fetched with the App's token before each launch (in git's environment only, never in the mirror's config nor on disk), one fetch at a time per mirror, with `--prune`: a branch deleted on GitHub leaves the mirror at its next fetch, and a workspace on that branch keeps its commits, as its objects are its own (ORC-486); a default branch renamed on GitHub becomes the mirror's `origin/HEAD` once the old one is deleted there. It holds the forge's branches as `origin/*` and its default branch as `origin/HEAD`, no branch of its own: a branch only your clone has is not seen. The workspaces copy their objects from it, the repository's config and the fingerprints are read on its default branch, and no sandbox mounts it.
- the project's repository on GitHub (`owner/name`) is resolved **once, at the start** (ORC-478): the `repos` entry of `factory.yml` of the same Linear team whose `github` the clone's `origin` names (case aside), else the name that origin gives. The forge (PRs, checks, reviews, labels, merges), the captures, the App's git token, the GitHub roles, the GitHub webhooks and `verify`'s clone (`https://github.com/<owner>/<name>`; a replayed ticket's reads its own clone at the start) know the repository by it, never by the clone's remote again. An `origin` changed while the daemon runs changes nothing until its restart. A project whose `origin` is not a GitHub repository (another host, a local path, none) stops the start, with a message naming the project; `factory doctor` refuses it alike. ORC-471 removes `repo_path` (`github` written in `factory.yml`, part 3).

### Adding a project

```bash
cd <other repository>
factory init       # same Linear application key: answer with the same credentials
```

`init` adds the project (or replaces the one with the same `repo_path`) and proposes its `.factory/config.yml`, which it does not write. Then restart `factory up`: the statuses and labels are created in the new team on the next Linear connection (« Connect Linear » button or `/oauth/start`).

> The queue capacities are global to the instance: `concurrency` of `factory.yml` for the `dev` queue, a fixed 2 for the `questions` queue (ORC-390). The other settings are specific to each project.

### One team, several repositories

Several projects can declare the same `linear_team_key`. The ticket then designates its repository with a **`repo:<id>`** label, where `<id>` is the project's `id` in `factory.yml` (case-insensitive): `repo:api` sends the ticket to the `api` project. Create these labels in the Linear team.

- Team with a single project: nothing changes, the label is useless and ignored.
- The label is only read for a ticket no project holds yet, at its delegation (or at a mention, a command). **Routing is sticky**: a delegated ticket, or one that already has a branch or a PR, stays under its project, whatever its labels say afterwards, and a project added to the team takes no existing ticket. Adding the label of another repository of the team to a ticket in progress changes nothing: the factory replies in a comment that the repository does not change midway. Without a branch or PR, you change it by stopping the work and removing the delegation, then, once the removal is seen by reconciliation (up to 5 minutes: no webhook reports it), delegating again; otherwise, a new ticket is needed. A `repo:` label that names no repository of the team is ignored. A reply or a stop on a ticket no project holds also follows its label, including when its delegation has not been processed yet: without a label, it receives the question; with a label, a reply goes to the copy of the ticket that opened its session.
- Ticket without a `repo:` label naming one of the projects: the delegation is blocked (label « Bloqué ») and the Linear session asks for the label, with the list of choices. The ticket waits under the team's **first** project (order of `projects` in `factory.yml`), even if it was blocked for another reason, which it replaces. A cancellation or a move to done ends the wait. While it waits, a reply, a mention, a command or a stop receives the same question, and nothing else (status, label) starts work: no work starts in a repository chosen by default.
- To unblock: add the `repo:<id>` label, then delegate the ticket again (remove the agent then put it back): the work starts in that repository, including if it is the one where the ticket was waiting, and the « Bloqué » label is removed. Both stores keep a copy of the ticket per project: the one that was waiting stays under the first project until reconciliation ends it. The new delegation is necessary: reconciliation does file the ticket under its repository and removes the waiting ticket from the first project (its block lifted), but a delegation it finds has no signed author, and permissions (ORC-186) start nothing without an author.
- Several valid `repo:` labels: the first project in the list among them wins. A ticket that touches several repositories is split into one sub-ticket per repository.

Only one project holds a ticket, across both stores (key `(project, ticket)`, ORC-316). While another project of the same team holds it, an event routed on a stale read (a reconciliation pass that read Linear before a signed delegation, for example) is refused if it would create a copy of the ticket, or if it would make the copy that was waiting here hold the ticket. The ticket stays intact, the refusal is logged as an error, and the event is set aside as a dead letter, with no retry and without blocking the ticket. The ticket's session says so (a `thought` activity, which does not change the session's state), and the session the event came from replies if it is a different one; `factory run repair <ticket>` shows it. Ignoring it closes it; replaying it refuses it again as long as the other project holds the ticket. The row of a project that is no longer in the configuration (renamed, for example) refuses nothing: its events create a copy under the new id, and the old row remains, unrelated to it.

### Removing a project

Delete its entry from `projects` in `factory.yml` and restart. The remaining directories under `workspaces/<id>/` are deleted like any directory.

## Per-ticket worktrees

Each job declares a workspace type (`workspace` in [`preset.md`](preset.md#jobs)):

| Type | Location | Used by (pack) |
|---|---|---|
| `worktree` | `<FACTORY_HOME>/workspaces/<project>/<ticket>/`, branch `feat/<id>-<slug>`, or `fix/<id>-<slug>` for a `Bug` (the repository's `branches` can change it, ORC-283) | `spec`, `tests`, `dev`, `dev-feedback`, `fix-ci`, `fix-review`, `fix-human`, `answer-relayed`, `rebase` |
| `trunk-readonly` | `<FACTORY_HOME>/workspaces/<project>/_trunk/<runId>/`, detached on `origin/<default branch>` | `ask` and `intake` (`Read`, `Grep` and `Glob` only, ORC-367, ORC-182) |
| `published` | `<FACTORY_HOME>/workspaces/<project>/_trunk/<runId>/`, detached on the commit the factory published | `review`, `review-security` (ORC-183) |

These are not `git worktree`s of the repository: each is a repository of its own, with its `.git` and its copy of the objects, so that nothing the agent writes there is read by the host's git ([security](interface-and-security.md), ORC-317). `git worktree list` therefore does not show them, and disk space counts one copy of the history per ticket and per question.

Lifecycle of a ticket worktree:

1. **Creation** on the first run: the mirror fetched, then a new repository on the ticket's branch (reuses the forge's branch with the same name or the ticket's older `factory/<id>-<slug>` name, otherwise creates it from `origin/<default branch>`). Its commits carry the factory's own git identity (`factory@factory.invalid`), never the operator's. Git LFS files are checked out as their pointers. `.claude/` is masked there from that moment, except `.claude/CLAUDE.md`, including for the `setup`.
2. **Setup**: the repository's `setup` ([`.factory/config.yml`](repository-configuration.md), e.g. `npm ci`) is run once, in a sandbox of its own, destroyed and its secrets sealed before the agent's starts (ORC-211), never on the host (ORC-179). If one fails, the worktree is deleted and the ticket blocked (« Launch error: The worktree setup failed: <command> »); the next run starts from scratch.
3. **Reuse**: the ticket's following runs (feedback, CI, review) pick up the same worktree, without setup.
4. **Cleanup**: when the PR is merged (the preset's `after_merge` step, followed by the cleanup, ORC-197), the directory is deleted, its `.git` with it: a commit the agent had not pushed disappears.

Each question, and each lens of an AI review, has its own `_trunk/<runId>/`, created for it, mounted in its sandbox alone, and deleted when it ends: no worktree is shared on the host (ORC-179).

What is **not** cleaned up automatically (to do by hand if disk space matters): directories of tickets whose PR was closed without merging or that were abandoned, the `_kb/<runId>` directories the `learn` and `remember` runs left before ORC-193, and a `_trunk/<runId>` whose daemon was killed mid-run. They are deleted like any directory, and git keeps no trace of them.

### `setup` and checks

- `setup` of `.factory/config.yml`: prepare a new worktree (dependencies, generated files). Run at creation only, and again by `verify` on its fresh clone.
- `commands` of `.factory/config.yml`: checks run by **the factory** (not by the agent) in its `verify` step after each successful code run, 15 minutes maximum per command. On failure, the factory reruns the step with the error output, then blocks the ticket after 4 checks (the preset's `verify` bound, 3 returns), or as soon as the third identical failure on an unchanged worktree (cause « Loop »).

Details and examples: [`repository-configuration.md`](repository-configuration.md), [`preset.md`](preset.md#bounds).

### Ports

Each run in a ticket's worktree receives a `PORT` variable: the workflow's `workspace.portBase` (4200, fixed by the preset), the same for every run, since each listens in a container of its own (ORC-179). Several tickets run in parallel without conflict on it. Runs on a clone (`ask`, `intake`, the AI review) do not receive one.

## Shared knowledge base

A separate git repository, shared by all projects of the instance, that holds what is worth remembering (conventions, pitfalls, decisions). Agents read it; none writes to it (ORC-193), and the factory itself only commits the start recipes it validated (ORC-386):

```text
factory-knowledge/
├── INDEX.md        # one line per note
├── notes/*.md      # one note per topic
└── notes/preview/  # start recipes of the visual proof, written by the factory (ORC-386)
```

How it is used:

- **reading** (ORC-232): at each launch, the server reads `INDEX.md` and hands its first 8,000 characters to the session in its system prompt, as data; an index past that cap ends on a visible `[… INDEX.md truncated …]` marker and the daemon logs the cut. The agent, the answer agent included, searches the notes with the factory MCP's `kb_search` tool, which the server answers from its clone: the session gets the index and the matching lines, never the repository, which no sandbox mounts any more;
- **updating**: before a launch, the server runs `git fetch origin` (60 s at most) then `git merge --ff-only` on the clone of `refs/remotes/origin/<default branch>` in full, never a tag of that name, once for the launches that come together or within 30 s of the last pull; the clone must therefore stay on its default branch, with no local commits. A clone without a remote, or on another branch, is not pulled: the daemon logs `Knowledge base: …` saying why, and the agents read it as it is;
- **writing**: asleep at the MVP (ORC-193). No job writes to it any more: neither `learn` after a merge nor `remember` (the `retiens` command is gone, a `retiens …` addressed to the agent is a message as any other). The factory's one write is a validated start recipe under `notes/preview/`, committed and pushed by the server (ORC-386, [preset.md](preset.md#jobs)). Humans edit the repository; the `learn` PRs still open are closed or merged by hand. Writing comes back in another form, fed only by signed human signals (ORC-247).

### Setup

`factory init` does not create the repository (ORC-193). For an existing repository, record its clone in `factory.yml`; to create one, make an empty private repository on the forge, then:

```bash
git clone <URL of the repository> factory-knowledge
cd factory-knowledge
mkdir -p notes && touch notes/.gitkeep && printf '# Knowledge base\n\n' > INDEX.md
git add . && git commit -m "init knowledge base" && git push
```

then in `factory.yml`:

```yaml
knowledge:
  repo_path: /chemin/absolu/vers/factory-knowledge
```

Without `knowledge`, everything works: no index in the system prompt, and `kb_search` answers that the factory has no knowledge base.

There is also **per-repository** knowledge, with no configuration: the skills read the repository's `CLAUDE.md` and `docs/agent/` if they exist.
