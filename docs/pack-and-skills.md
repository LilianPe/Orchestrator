# Pack and skills

Relais's core contains no business instructions: it orchestrates. What the agent does comes from a **pack**, a Claude Code plugin shipped in `packs/standard/`:

```text
packs/standard/
├── .claude-plugin/plugin.json   # "relais" plugin → skills relais:<name>
├── workflow.yml                 # default behavior (events, jobs, limits)
├── settings.json                # run permissions
├── hooks/hooks.json             # SessionStart and PreToolUse hooks
├── hooks/session-start.mjs      # always-on rules, method, knowledge base index
├── hooks/pre-tool-use.mjs       # refuses forbidden commands and full reads of large files, refusal log
├── NOTICE.md                    # origin of the method (superpowers, MIT)
└── skills/<name>/SKILL.md       # job skills (one per run type) and method skills
```

Each run starts Claude Code with `--plugin-dir packs/standard` (skills become `/relais:<name>`), `--settings <RELAIS_HOME>/run-settings.json` `--setting-sources ""` and `--strict-mcp-config` (ORC-284, options measured by ORC-128). No Claude Code setting comes from anywhere but the factory: neither the user's (`~/.claude/settings.json`), nor the repository's (`.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, skills, agents and commands in `.claude/`). The worktree's `.claude/` is removed before each session ([`interface-and-security.md`](interface-and-security.md)).

Behavior (which skill, when, with which model) is configured in `.relais/workflow.yml`: see [`workflow.md`](workflow.md).

## The pack's skills

Two families:

- **job skills** are the ones `workflow.yml` launches (`skill: "relais:<name>"`): they say what to do from the start to the end of a run and the format of the `submit_result` summary;
- **method skills** say *how* to do a step (test, debug, verify, review, handle feedback). Job skills load them at the right moment, and the startup hook reminds every run to use them.

### Job skills

All of them end on `submit_result`, whose summary, in English, is what the factory posts in the Linear session, composed and checked by its `OutputPolicy` (ORC-214): nothing the agent writes as a message is posted. When the agent asks a question (`factory-agent ask`), the ticket is blocked and that summary is **not** posted: the question must stand on its own.

| Skill | Job(s) | Workspace | Role | Method loaded |
|---|---|---|---|---|
| `factory:intake` | `intake` (off until a repository runs it, ORC-206) | ticket's worktree, fresh session | Reads the ticket, the architecture docs and decisions, the linked tickets and the code; writes nothing; returns size, risk, completeness (with at most 3 questions) and whether it touches a screen in the `intake` field of `submit_result`. | none |
| `relais:dev` | `dev` | ticket's worktree | Reads the ticket, checks it against the code, asks a question if a decision is missing, makes a mini-plan if the ticket has several steps, develops test-first, verifies (targeted tests, types, lint), does a light self-review, leaves the trunk alone (a conflict is the `rebase` step's, ORC-146), commits and hands back: the factory verifies, publishes and opens the draft PR (ORC-125). Message: what changed, how to test, verified, points of attention. | `tdd`, `debugging`, `verification`, `code-review` (quick or standard), `receiving-review` |
| `relais:feedback` | `dev-feedback` | worktree, resumed session | Handles feedback (Linear thread, unresolved GitHub review comments, failed verifications): checks each item in the code, fixes with a test, refuses with a reason, one commit per cause; merges whatever a human pushed to the branch, never the base (a conflict is the `rebase` step's, ORC-146). Message: one line per feedback item. | `receiving-review`, `tdd`, `debugging`, `verification` |
| `relais:fix-ci` | `fix-ci` | worktree, resumed session | Reads the exact failure (`gh pr checks`, `gh run view --log-failed`), reproduces it locally, checks whether the base fails too, classifies the cause (regression, flaky, infra). Regression: minimal fix + test. Flaky or infra: a question instead of blindly "fixing". Two failed fixes on the same check: question. Forbidden to disable, skip or weaken a test or a CI step. | `debugging`, `tdd`, `verification` |
| `factory:review` | `review`, `review-security` (ORC-183) | fresh clone of the published commit, fresh session, `Read`, `Grep`, `Glob` only, network `claude-api` | One lens of the AI review, named in the prompt: correctness and spec, or security and tests; over-engineering flagged in both. The diff is in the prompt; it changes nothing, runs nothing, and hands back its `findings` (`file`, `line`, `severity`: `blocking`, `minor` or `out_of_scope`, `explanation`, `suggestion`, `fact`) through `submit_result`, which the factory publishes on the PR ([preset.md](preset.md#review-step-orc-183)). | `code-review` |
| `factory:rebase` | `rebase` (ORC-146) | worktree, resumed session | Started by the engine on a conflict of the PR with its base: `git rebase origin/<base>`, each hunk resolved keeping the intent of both sides, then the touched tests, types and lint. Stops (`git rebase --abort`, then `submit_result` with `reason: conflict`) in three cases only: `logic` (the two sides contradict each other), `migrations` (two migrations on the same schema), `scope` (a resolution beyond the ticket). Posts nothing: the factory verifies the rebased branch, then publishes it over its own head. | `verification` |
| `relais:ask` | `ask` | `_trunk`, read-only (plan mode) | Answers a question from the knowledge base, `docs/agent/`, `CLAUDE.md`, the code and the tickets, asserting only what it has read, with its sources. | `verification` |
| `relais:learn` | `learn`, `remember` | knowledge repository worktree | Writes 0 to 3 verified notes (`notes/<slug>.md` + a line in `INDEX.md`), extends an existing note rather than creating one, and commits them on its branch: nobody publishes them: writing knowledge belongs to ORC-193. For `remember`, faithfully records what is requested. | — |

### Method skills

| Skill | When | What it requires |
|---|---|---|
| `relais:tdd` | any behavior change | A test that fails for the right reason before the code; minimal code; neighboring tests green; tests that can really fail (no assertion on a mock). |
| `relais:debugging` | bug, red test, failed CI or verification | The cause before the fix: read the whole error, reproduce, compare with what works, one hypothesis at a time; after three failed fixes, a design question rather than a fourth. |
| `relais:verification` | before claiming "done", "green", "fixed", and before commit, push, PR | A command run and read for every claim. Targeted tests, types and lint; not the full suite (that is the job of `verify` and CI). Push verified with `git ls-remote`. |
| `relais:code-review` | review a diff (`review`, `dev`'s self-review) | Diff bounded at the PR's base. Three levels chosen by risk: **quick** (text, config), **standard** (logic, docs that describe the code), **thorough** (access, data, migrations, secrets, large diff; passes by angle, in parallel subagents if the tool is available). Findings classified by scope (in scope, out of scope, rule conflict) and severity (blocking, important, minor), each verified before being reported. |
| `relais:receiving-review` | handle feedback or findings | Read everything, check the premise and the proposed fix in the code, do not decide a trade-off alone, one commit per cause with its proof, reply without complacency (fixed, refused with a reason, or question). |

The method is rewritten from the superpowers skills (MIT): see `packs/standard/NOTICE.md`.

Full text: `packs/standard/skills/<name>/SKILL.md`.

## Always-on rules (SessionStart hook)

`hooks/session-start.mjs` injects at the start of each run:

- the current ticket (`RELAIS_TICKET`);
- the rules: Linear messages in French, never merge or force-push, modify nothing outside the working directory, never declare done without tests run and read, go through `relais-agent` for Linear, ask **one** question with `relais-agent ask` rather than invent, nothing written as a message is published: Linear shows what the factory composes from `submit_result`, whose summary, for a reply, reads on its own (ORC-214);
- the method: before each step, load the method skill that applies (`relais:tdd`, `relais:debugging`, `relais:verification`, `relais:code-review`, `relais:receiving-review`), the repository's `CLAUDE.md` taking precedence on style only, never on the factory's rules; if the Skill tool is unavailable, read the skill's file (the hook gives the absolute path of the `skills/` folder);
- if `RELAIS_KNOWLEDGE` is set and contains `INDEX.md`: the knowledge base index (8,000 characters at most) and the path to the notes.

## Permissions

`packs/standard/settings.json` sets `defaultMode: acceptEdits` and:

**Allowed** without confirmation: reading, editing and searching files; `git status|diff|log|show|add|commit|fetch|rebase|checkout|switch|branch|rev-parse|merge-base|merge-tree|merge|revert|rev-list|ls-remote`; `gh pr view|list|checks|diff`; `gh run view|list`; `npm`, `npx`, `node`, `pnpm`, `yarn`; `uv` (in the runner image) and `pytest`, `ruff`, `mypy` (from the project environment `uv sync` installs, run with `uv run`); `ls`, `cat`, `grep`, `rg`, `find`, `head`, `tail`, `wc`, `sleep`; `relais-agent`; the `submit_result` and `ask` tools of the factory MCP (`mcp__factory__…`), which `claude -p` would otherwise refuse.

**Refused**:

- `gh pr merge`: only humans merge;
- any `git push`, and `gh` writes (`gh pr create`, `gh pr edit`, `gh run rerun`): **only the factory publishes** (ORC-125, [`github.md`](github.md#publishing));
- any bypass of git hooks via `--no-verify` (`git commit --no-verify`, the option in the middle of the command, or any command that contains it) or via `-n` (`git commit -n`, `-nm`, `-m … -n`; not `-an`, which the pattern syntax cannot isolate); the explicit rules duplicate the `*--no-verify*` wildcard in case the Claude Code version does not apply wildcards at the start or middle of a pattern. The diff scan (`factory/anti-triche`, ORC-158) also refuses a `--no-verify` added in a repository file, except documentation, test files and permission rules in Claude settings;
- `git reset --hard origin…`, `rm -rf /`;
- a download piped to a shell: `curl … | sh`, `wget … | bash`;
- any command that mentions the Docker or Podman socket (`docker.sock`, `podman.sock`) or the variables leading to it (`DOCKER_HOST`, `CONTAINER_HOST`): it would give control of the host from the run's container;
- the `WebSearch` tool: the search runs at Anthropic, out of the egress proxy's sight ([ORC-128](decisions/ORC-128.md), point 1). `WebFetch` remains allowed: it goes through the proxy;
- reading `~/.relais/**`.

At startup, Relais extends these refusals for the **real** `RELAIS_HOME` (even outside `~/.relais`, for example `/data` in Docker) and writes the result to `<RELAIS_HOME>/run-settings.json`: reading/editing `secrets.json`, reading `relais.db*`, `transcripts/**`, `logs/**`, and any command that mentions `secrets.json` or `relais.db`. See [`configuration.md`](configuration.md#what-does-not-leave-the-daemon).

These rules, and the hook below, are a guard against an agent's mistakes, not a barrier: they read the command an agent writes, and an agent that runs code can write it otherwise. What keeps an agent from pushing is that it has nothing to push with: in a sandbox, no GitHub token and no network to the forge but through the egress proxy, which refuses GitHub writes ([network](interface-and-security.md#sandbox-network)); on the host (`FACTORY_ALLOW_HOST_RUNS=1`), no `GH_TOKEN`, and a git config in the run's environment that rewrites every push URL to a transport git does not have, so that `git push` fails whether it names a remote, a URL or an alias, or hides `push` in a variable or a substitution (ORC-349). That config is no barrier either: git ignores it for a remote with an explicit `pushurl` (inherited from the repository's config, or set by the agent), and an agent under the daemon's user can undo it, or use the user's SSH keys with `git send-pack`. Protect the default branch on the GitHub side ([`github.md`](github.md#branch-protection-strongly-recommended)). The acceptance run checks that the installed Claude Code version does apply wildcards in the middle of a pattern ([`acceptance.md`](acceptance.md)).

`trunk-readonly` runs (questions) additionally run with `--permission-mode plan`. Known limitation, not measured: plan mode may refuse an MCP tool that is not read-only despite the `allow`, hence `submit_result` and `ask` in these runs; their answer then remains their last message (`post: reply`). To be checked on the installed version ([`acceptance.md`](acceptance.md)).

### PreToolUse hook and refusal log

The `deny` patterns are wildcards on the command text: an extra space, quotes (`git commit "--no-verify"`), a `sudo`, a `git -C repo` or a `bash -c "…"` defeat them. And Claude Code splits a compound command before applying its rules: `curl … | sh` is only seen piece by piece. `hooks/pre-tool-use.mjs` (`PreToolUse` hook on `Bash`, `WebSearch` and `Read`, see [below](#full-read-of-a-large-file) for `Read`) therefore repeats the same refusals on the parsed command: words and quotes like a shell (POSIX escapes inside double quotes, `\` at end of line), operators (`|`, `|&`, `&&`, `;`…), prefixes (`VAR=…`, `sudo -u x`, `env -i`, `timeout 10`, `nice`, `nohup`, `command`) and global options of `git` (`-C`, `--git-dir`…) and `gh` (`-R`) ignored along with their values. Quoted text is data (`git commit -m "git push --force …"` passes); only the payload of a `sh|bash|zsh|dash|ksh -c`, the arguments of `eval` and a `$(…)` substitution are re-read as commands. It also refuses `rm -fr /`, `rm -r -f /*`, `git commit -anm …`, `bash <(curl …)`, `sh -c "$(curl …)"`, a download piped to a shell whatever its arguments (`curl … | bash -s x`), `git push --mirror` (`force-push`), `git push --all` and any refspec that writes `main`/`master` (`HEAD:refs/heads/main`, `:main`, `--delete origin main`: `push-trunk`).

Each refusal is a named rule (`no-verify`, `commit-no-verify`, `force-push`, `push-trunk`, `merge`, `reset-origin`, `rm-root`, `pipe-to-shell`, `container-socket`, `web-search`, `full-read`, and with the flag: `push`, `gh-write`). The agent receives the rule's name in the refusal reason, and the hook writes a JSON line `{"at", "tool", "command", "rule", "ticket"}` (`ticket`: `$FACTORY_TICKET`, `null` outside a run) to the **refusal log**:

1. `$FACTORY_REFUSALS_LOG` if it is set. In a sandbox, Relais always sets it to `/factory/refusals/refusals.jsonl`, mounted from `<RELAIS_HOME>/runs/<runId>/refusals/`: each run's log (review and question included) outlives the container, and it is purged after 30 days (ORC-217). On the host, the daemon passes it to runs when it has it;
2. otherwise `$CLAUDE_CONFIG_DIR/factory-refusals.jsonl` (the run's Claude configuration directory);
3. otherwise `~/.claude/factory-refusals.jsonl`.

Folders are created; a log that cannot be written prevents neither the refusal nor the session.

**In the database and in the ticket (ORC-296).** In a sandbox, when a run's container is destroyed, Relais reads its refusal log and the egress proxy's log, and writes them to the database (tables `security_logs`, `refusals`, `egress_requests`), linked to the run and the ticket, once per run. The refusal log is written from the sandbox: it is untrusted data. A malformed line, from an unknown tool, rule or ticket, or beyond 1 MiB of log, is ignored and counted (the count is in the database and in the daemon's log), never blocking; a log that is not a regular file (link, folder, FIFO) is not read. The command, or the path for a refused `Read` (ORC-279), is kept in the database, truncated to 2,000 characters. If the run had at least one refusal (from the hook or the proxy), Relais posts in the run's Linear session a thought « Refusals during this run »: the number of refusals per rule and the hosts refused by the proxy, **never the commands or the paths** (they may contain a secret); a host that is not a plain domain name is counted without being named. On the host, without a sandbox, the log is not specific to the run: nothing is read.

`src/pack-guard.test.ts` feeds the hook, on its standard input, a real `PreToolUse` call for each `Bash(…)` in the `deny` of `settings.json` and checks the refusal and the log line: a pattern added to `deny` without a rule in the hook makes the test fail.

#### Full read of a large file

For build tokens (ORC-279), the same hook refuses a `Read` with neither `offset` nor `limit` of a file of more than 350 lines (`read_guard.max_lines` in [`factory.yml`](configuration.md#factoryyml-orc-209), passed to runs via `FACTORY_READ_MAX_LINES`). The agent receives the instruction: search with `grep`, then read the relevant range. The refusal is the `full-read` rule in the refusal log, with the path in `command`. It applies to every step. `allow_large` alone is not a targeted read. An `offset` or a `limit`, whatever its value, is one: the hook reduces a cost, it does not defend against the agent.

This rule **lets through when in doubt**, unlike the command refusals: it costs tokens, it protects nothing. A missing or unreadable file, a folder, a FIFO, a malformed list or a hook error let `Read` respond on its own. An invalid threshold counts as 350. Also left to `Read` are the files it does not split by lines: images, PDFs, notebooks, and any file with a null byte in its first 64 KiB.

The files read in full are those in `FACTORY_FULL_READ_PATHS`, a JSON list of absolute paths as the run sees them, written by the factory at each launch from the orchestrator's `fullReadPaths` dependency (paths relative to the repository, like the keys of `frozenTests.files`). A list of more than 64 KiB, or impossible to obtain, is not passed, with a warning in the daemon's log: the run starts, and these files are read by ranges. The daemon puts the ticket's frozen tests in it (ORC-131), frozen harness files included. The ticket's spec will be added with ORC-212.

Why `git rebase` and `git merge` are allowed: since ORC-146 only the `rebase` step integrates the base, with `git rebase origin/<base>`; no other skill merges or rebases it, and an agent that sees a conflict leaves it to that step. The agent still never pushes: the factory publishes the rebased branch with `--force-with-lease` on the head it published itself, and only that one. `git merge` stays for the commits a human pushed to the branch (`feedback`). The AI review merges nothing: it reads a clone of the published commit (ORC-183). `git merge-tree` is used for the conflict check without touching the tree, `git ls-remote` to verify that a push did reach the remote.

## Customizing

From the simplest to the deepest:

1. **Tune the behavior** without touching the pack: the repository's `.relais/workflow.yml` (models, limits, verifications, rules, jobs). See [`workflow.md`](workflow.md#6-recipes).
2. **Give the repository context**: the factory reads `CLAUDE.md`, `AGENTS.md` and `.claude/CLAUDE.md` and puts them in each run's prompt as data (8,000 bytes at most, `@path` imports not followed, ORC-284); `docs/agent/*.md` is read by the `dev`, `review` and `ask` skills. That is the place for your commit, test and naming conventions: they take precedence over the skills' style, never over the factory's rules. The repository's Claude Code settings (`.claude/settings.json`) do not apply to runs.
3. **Add a skill** for a new job: since ORC-284, a project skill (`.claude/skills/<name>/SKILL.md` in the repository) **is no longer loaded** by runs; add the skill to the pack (point 4). The old way, a project skill referenced by `skill: "<name>"` in a job of `.relais/workflow.yml`, no longer works. Full example: [`workflow.md`](workflow.md#adding-a-custom-job-with-its-own-skill).
4. **Modify the pack** itself: edit `packs/standard/` (skills, hook, permissions) in your copy of Relais. This applies to all projects of the instance; restart `relais up` to regenerate `run-settings.json`. To change the method for the whole team (review level thresholds, verification commands, TDD rules), edit the relevant method skill: every job skill that loads it follows. To add a method skill: a `skills/<name>/SKILL.md` folder, cited as `relais:<name>` from a job skill or the hook.

Relais always loads `packs/standard`: `extends` in `workflow.yml` has no effect and there is not yet a mechanism to choose another pack. For a team "pack", maintain a copy of Relais with your own `packs/standard/`.

### Writing a skill

- Frontmatter `name` (folder name) and `description`; `src/pack.test.ts` checks that every pack skill has this frontmatter, that every skill referenced by the pack's `workflow.yml` exists, and that every `relais:<name>` cited in a skill or in the hook exists.
- Rely on the method skills rather than repeating their rules: "apply `relais:receiving-review`" stays correct when the method evolves.
- The run's prompt starts with `/<skill>` followed by the « Ticket » block (identifier, title, URL, branch, PR, description), the « Linear context » block when the webhook provides one and, depending on `input`, « Feedback to address », « CI failures », « Message » or « Failed checks ».
- State explicitly what to do **at the end**: commit/push, and the format of the last message (posted in Linear).
- Use `relais-agent ask` for any missing decision, then end the turn.
- Test it by hand in a repository: `claude -p "/<skill> …" --plugin-dir packs/standard --settings ~/.relais/run-settings.json`.
