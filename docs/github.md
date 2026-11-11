# GitHub

Relais talks to GitHub through **git** and a **factory GitHub App**. The daemon uses the App when it is configured; otherwise it falls back to the **`gh`** CLI (migration fallback). **Only the factory writes to GitHub** (ORC-125, [Publishing](#publishing)): agents commit, and have neither a token nor network access to push. The daemon tracks PRs in two ways, which write the same events to the inbox: **GitHub webhooks** (`POST /webhooks/github`, as soon as their secret is configured, see [GitHub webhooks](#github-webhooks)) and **polling** of PRs every 30 s, kept until GitHub reconciliation (ORC-185) and its removal (ORC-181).

## Daemon authentication

### GitHub App (recommended)

The GitHub App is the identity of the **daemon**, not of the agents. It is used to read PRs, checks and review threads without depending on `GH_TOKEN` or the `gh` CLI, and to publish: push the ticket's branch, open its draft PR, merge.

```yaml
# <RELAIS_HOME>/config.yaml
github:
  appId: "123456"
  privateKey: /home/relais/.relais/github-app.pem   # inline PEM or file path
  installationId: "987654"                          # optional
```

Environment variables serve as a fallback, for existing installations and Docker:

| Variable | Role |
|---|---|
| `GH_APP_ID` | App identifier |
| `GH_APP_KEY` | PEM private key, or path to the `.pem` file |
| `GH_APP_INSTALLATION_ID` | installation to use; optional |

A value in `config.yaml` takes precedence over the environment variable. If only one of the two values `appId` / `privateKey` is provided, startup fails with an explicit message rather than silently switching to `gh`.

#### Creating the App

1. GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Enter a name and a URL. **Webhook**: active, URL `<publicUrl>/webhooks/github`, secret = the value of `github.webhookSecret` (or `GH_WEBHOOK_SECRET`); events: *Pull request*, *Pull request review*, *Pull request review comment*, *Check run*, *Check suite*, *Push*, *Workflow run* (the last two are also used for the revert and CI cost measurements, see [GitHub webhooks](#github-webhooks); *Workflow run* requires the *Actions* read permission, already in the manifest). `<publicUrl>` is the server's HTTPS URL, behind its reverse proxy ([`deployment.md`](deployment.md#tls-and-webhooks)); on a workstation, a tunnel (ngrok, `cloudflared tunnel`) in `publicUrl`, for development only (smee relays Linear's webhooks, not GitHub's). Without a public URL, leave it disabled: polling every 30 s tracks PRs on its own.
3. Under **Repository permissions**, apply the manifest [`github-app-manifest.json`](github-app-manifest.json):
   - **Contents**: read/write;
   - **Pull requests**: read/write;
   - **Checks**: read/write (the `factory/*` checks published on the pushed commit, ORC-151; an App created earlier must add it, otherwise these checks are not published, and the log says so);
   - **Commit statuses**: read;
   - **Actions**: read (list environments and their protection rules, for `factory doctor`);
   - **Metadata**: read (mandatory for every App).
   No **administration** permission, no `Actions` write, no `Workflows`.
4. Create the App, note its **App ID**, then **Generate a private key**. Place the `.pem` outside the repository, with mode `0600` (for example `~/.relais/github-app.pem`).
5. **Install** the App on the repositories entrusted to Relais. The installation ID is visible in the URL `https://github.com/settings/installations/<id>`; it is optional, the daemon can look it up repository by repository.
6. Fill in `config.yaml` or the `GH_APP_*` variables, then restart `relais up`. Startup logs the chosen forge, without secrets.

#### Tokens

- The daemon signs an **RS256 JWT** with the private key: `iss = appId`, `iat = now - 60 s`, `exp = now + 9 min`.
- It exchanges this JWT for an **installation token**: `POST /app/installations/{id}/access_tokens` with `{ "repositories": ["<run's repository>"] }`. If `installationId` is not configured, it first calls `GET /repos/{owner}/{repo}/installation`.
- The token lasts **at most 1 hour**. It is cached **per repository** until it expires, with a 60 s safety margin.
- It stays **in the daemon's memory**: never written to disk, never logged, never passed to Claude Code runs, any more than `GH_TOKEN` is. A run therefore cannot act on another repository with this token.
- The private key is never logged. The startup message contains only the App ID and, where applicable, the installation ID.

#### Key rotation

1. GitHub App → **Private keys → Generate a private key**.
2. Drop in the new `.pem` (mode `0600`) and update `github.privateKey` or `GH_APP_KEY`.
3. Restart the daemon; cached installation tokens are discarded and new ones are issued with the new key.
4. Revoke the old key in GitHub. Already-issued installation tokens expire on their own in less than an hour, but a compromised private key can issue new ones: revoke it without delay.

### `gh` CLI (migration fallback)

Without a `github` section, the daemon uses `GhCliForge` and the `gh` CLI, as before:

- **Workstation**: `gh auth login`, and git configured to read `origin` (SSH or HTTPS). Check `gh auth status` and `git fetch` from the repository.
- **Docker**: `GH_TOKEN` variable; at startup, the container runs `gh auth setup-git` so that git reads over HTTPS with this token. Mounted repositories must therefore have an **HTTPS** remote. See [`deployment.md`](deployment.md).

Startup explicitly logs `GitHub forge: gh CLI (migration fallback…)`. This fallback only reads: **without a GitHub App, the factory neither publishes nor merges**, and a verified ticket is blocked with that reason. It will go away with ORC-181.

### Publishing

The factory publishes (ORC-125), through the outbox's `publish` effect, which `decide` only writes for the commit that `verify` has just found green (invariant I1) and which `mayPublish` checks again at execution time. It requires sandboxes and the GitHub App (*Contents* and *Pull requests* write permissions). `GitPublisher` (`src/publish/publish.ts`):

1. reads from the forge the default branch and the head of the ticket's branch; a head already at the commit goes straight to the PR, without pushing: that is the replay of an interrupted publication;
2. bundles the branch, in the agent's own repository (ORC-317), in a fresh sandbox at `none`, its `.git` read-only; no host git runs there, and the git directory of `repoPath` is mounted nowhere. It verifies the bundle, clones it without checkout, without the repository's hooks or config, and compares its head to the verified commit;
3. checks the diff since the base, blocking: `factory/chemins-interdits` (outgoing symbolic links and `package.json#scripts` included), `factory/binaires`, `factory/anti-triche`, `factory/secrets`;
4. pushes **forward only**, with `--force-with-lease` on the head it read: if the branch carries a commit absent from the work (a human push, or rewritten history), nothing is pushed, nothing is forced: the agent rebases its work on a human's push (ORC-159), and `verify` refuses a commit that does not carry it (`factory/commits-humains`);
5. opens the **draft** PR, looked up by branch before creation (a normal PR if the repository's plan has no drafts). It leaves draft when the ticket moves to *Human Review*: GitHub does not merge a draft. At that move the factory also labels it `revue: requise`, `revue: échantillon` or `revue: auto` (ORC-198, [preset](preset.md#the-class-of-the-diff-and-the-review-label-orc-198)), one label of that group at a time, created by GitHub on first use (*Pull requests* write is enough); best effort, like the move out of draft;
6. publishes on the pushed commit the checks `factory/verify` (the commands that ran; `neutral` with no declared command), `factory/tests-gelés` (`neutral` with no freeze) and `factory/anti-triche` (ORC-151), identified by `external_id` = `<check>@<sha>`: a replay, or a second publication of the same commit, updates them, without duplicates. Best effort: a refused check (App without *Checks* write) is logged and does not block the ticket. A red verdict is never pushed, so it has no check. These `factory/*` checks never count as the commit's CI (check reading, polling, webhook), known by the App that created them, not by their name (ORC-353): another App's check named `factory/…` counts as CI; through `gh`, which reads no App, by their `factory/` prefix: on their own, they do not make a head green.

A refusal is an answer: the ticket is blocked with the reason (`publish.refused`), decided once; the retry that publishes takes it where it was meant to go (`owedMove`). A failure is replayed by the outbox, then blocks the ticket. A run with no commit beyond the base ends without a PR.

The PR's text is composed by the factory (ORC-195, `describePr` in `src/publish/describe.ts`), never copied from the agent's messages. Its title: the ticket's id and title, clipped to GitHub's 256 characters. Its body, after a `Ticket: <id>` line, always in the reviewer's order, each section present even when empty (« None stated. »):

1. **Why** (`why`);
2. **What changes** (`summary`);
3. **Assumptions** (`assumptions`);
4. **Risks** (`risks`);
5. **Untested** (`untested`);
6. **Trusted without verification** (`trusted`): libraries, external services and behaviours taken as correct, the approved spec's section, which the agent carries into its result (the spec itself is ORC-212's);
7. **Where to look first** (`review_hints`);
8. **Evidence**: what the factory checked, on which commit (the commands `verify` ran green in a fresh clone), apart from the tests the agent says it added; for a ticket that touches the interface, the captures at each screen width, narrowest first (taken by ORC-176; until then the section says none was taken).

The AI review's findings (ORC-183) will take their place between *Where to look first* and *Evidence*. The fields come from the agent's `submit_result`: in its text, an HTML tag or comment is shown as text, a line-leading `#`, a setext underline (`---`, `===`) and a code fence are escaped, and a list entry stays on its line, so nothing it writes passes for a section of the factory's or hides one. `submit_result` refuses fields whose description would pass the cap of a PR body less 1,500 characters, the room the factory's own facts take (`FACTS_ROOM`). No closing keyword: it would be a claim on the whole ticket. The text goes through the `OutputPolicy` (ORC-214, see [`linear.md`](linear.md#what-the-factory-publishes-orc-214)): a refused text (a blob, a secret, past its cap) blocks the publication with the reason, and nothing goes out. A PR already open (a second publication of the ticket's branch, a fix) keeps its description: the text sent then is a fixed `Ticket: <id>`, so nothing the fix submitted can hold its push back.

On the agent side: `git push` and `gh` writes are refused by the pack and its hook, the proxy refuses `git-receive-pack` at every agent network level, and no token enters a sandbox. On the host, without a sandbox, only the hook holds: ORC-179.

### Permissions required for the `gh` fallback

On each repository entrusted to Relais, the `gh` account must be able to:

| Action | Used by | Command |
|---|---|---|
| Read branches | agents, worktrees | `git fetch`, `git ls-remote` |
| Read PRs | agents | `gh pr view`, `gh pr diff` |
| Read checks and CI logs | daemon, agents | `gh pr checks`, `gh run view --log-failed` |
| Read review threads | daemon | `gh api graphql` (`reviewThreads`) |

With a fine-grained token: *Contents*, *Pull requests*, *Actions* and *Checks* read, *Metadata* read. With a classic token: `repo` scope.

## Human permissions

The [authorization matrix](linear.md#authorizations-who-can-do-what) (ORC-186) reads a user's permission on the repository (`GET /repos/{owner}/{repo}/collaborators/{login}/permission`), through the GitHub App (*Metadata* read permission, already requested) or, as a fallback, through `gh api`. The GitHub login of each Linear user is declared in `config.yaml` (`projects[].authz.githubLogins`, see [configuration](configuration.md#authorization)). A permission once read is kept for 60 s.

## What Relais polls

Every 5 minutes with reconciliation (ORC-185), and every 30 s when GitHub webhooks are refused for lack of a secret (without them, a merge would wait 5 minutes), for each tracked ticket that has a branch and is not `done` (a ticket moved to `done` before polling sees the merge of its known PR keeps being polled, only for the merge or closing of that PR, until it sees them: Linear may move it to *Done* first, and only `pr.merged` stops the code work):

- `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=all`: the branch's PR (open, merged, closed);
- if it is open, `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` and `GET /repos/{owner}/{repo}/commits/{sha}/status`: aggregated CI state (`fail` if a check fails or is cancelled, `pending` if a check is running, `pass` otherwise, `none` with no check).

A **human push** whose webhook got lost is not caught up: polling reads the PR head, but the factory does not remember the head it pushed itself (follow-up of ORC-185, ORC-281). Publishing over such a push is refused: see [Publishing](#publishing).

At the time of a `dev-feedback` or `fix-human` run, **unresolved** review threads are read via GraphQL (`reviewThreads`) and turned into feedback for the agent: every comment of each thread, a reviewer's reply included, as its own item (ORC-347). A comment by a bot account (GitHub types an App, the CI or Dependabot as `Bot`) is dropped; the factory's own reviewer will be let through once ORC-183 exists. The feedback is capped at `REVIEW_FEEDBACK_MAX` characters as the prompt writes it (`review-threads.ts`): past it, the most recently active threads are kept whole, none older than one cut; the newest thread over the cap alone keeps its latest comments, the last one cut short if it is over on its own. A last item tells the agent what was left out and that it is still on the PR (ORC-366). A comment whose date does not parse fails the read. Every page of threads and of an unresolved thread's comments is read; a list GitHub answers without saying where it ends, or longer than 10 pages of 100, fails the read rather than reach the agent cut short. Linear lists follow the same rule: delegated tickets (10 pages of 100), a team's states, labels and members (10 pages of 250), and an issue's labels past Linear's default page.

Events produced (see [`workflow.md`](workflow.md#3-the-on-rules)):

| Observation | Event | Standard pack |
|---|---|---|
| New PR for the branch | `pr.opened` | URL added to the Linear session |
| CI turning red | `pr.checks_failed` (with the list of failing checks) | `fix-ci` if the ticket is in *Human Review* or *AI Review* and not blocked, a round of the review and CI loop (`limits.ci_fix_attempts`, 2 per run, shared with `rebase` and the AI review's `fix-review`, ORC-184); after that the ticket is blocked ([`workflow.md`](workflow.md#limits)) |
| CI turning green | `pr.checks_passed` | lifts the block caused by the red-CI limit; the count of the loop stays, one per run (ORC-184) |
| PR merged | `pr.merged` | *Done*, the `after_merge` step (the requester mentioned with the PR's link, the changelog entry, ORC-197), worktree deleted, no run (ORC-193); after that, no more code runs on the ticket |
| Factory merge refused (ORC-148) | `pr.merge_refused` | push during review: back to *AI Review*, AI review relaunched on the new commits; other refusal (PR not mergeable…): back to *Human Review* with the reason |
| PR closed without merge | `pr.closed` | the ticket's work is cancelled (see [`workflow.md`](workflow.md#configurable-events)) |

A CI state change is reported only once (not on every poll). The PR's **unresolved** review comments are re-read at the time of a `dev-feedback` or `fix-human` run (`feedback` input): resolve a thread on GitHub so it is no longer sent back to the agent. An inline comment that started a round of human feedback (ORC-190) reaches the agent through its thread only.

Without a GitHub webhook, it takes up to 30 s for a merge or CI to be taken into account. A CI verdict is named by the PR head (`pr:<ticket>:<n>:checks:<fail|pass>:<sha>`): polling and the webhook seeing the same verdict on the same commit write it only once to the inbox, and a red verdict seen again on the same commit after a green one (CI rerun) is not reported a second time. With the `gh` CLI, the head is read from `headRefOid`.

## GitHub webhooks

`POST /webhooks/github` receives the App's webhooks (ORC-134), at `<publicUrl>/webhooks/github`. In production GitHub calls the server directly in HTTPS, through the host's reverse proxy or the optional `caddy` service (`--profile tls`), which pass the body unchanged to `factoryd` in plain HTTP: [`deployment.md`](deployment.md#tls-and-webhooks) (ORC-221). On a workstation, a tunnel in `publicUrl` stands in for it.

- **signature**: `X-Hub-Signature-256` must equal `sha256=` followed by the HMAC-SHA256 of the raw body with the secret, compared in constant time; otherwise refused (401) and **nothing is written**. The secret comes from `github.webhookSecret` in `config.yaml`, otherwise from the `GH_WEBHOOK_SECRET` variable. Without a secret (or with a secret made of whitespace), **all** GitHub webhooks are refused, and `relais up` reports it at startup;
- **inbox written before the response** (ORC-147): a 200 means "written"; if the daemon goes down right after, even with `kill -9`, the event is processed at the next startup. If the write fails, the response is 500: GitHub does not resend a failed delivery on its own; redeliver it from the App's *Advanced* tab, or let polling catch it up;
- **deduplication and replay**: each event's id comes from the signed body (PR number, SHA, review or comment id), never from `X-GitHub-Delivery`, which the signature does not cover (it is only used for the log). A redelivery, a replayed body, or the same fact seen by polling carries an id the inbox already has: it is not reprocessed. GitHub does not sign a timestamp: there is no freshness check; deduplication in the database stands in for it;
- **linking to the ticket**: by the PR's (or push's) branch, like polling, and by repository: `repository.full_name` must be the `origin` repository of the ticket's project (read once via `git remote get-url origin`). Only a branch of a tracked ticket, in its project's repository, produces an event; everything else (another repository where the App is installed, another branch, a body of another shape) is accepted (200) and ignored. An older PR of the branch, already closed, is ignored too.

| Webhook | Event in the inbox | Reaction |
|---|---|---|
| `pull_request` closed with `merged: true` | `pr.merged` (preceded by `pr.opened` if the ticket does not know the PR), with the merge commit (`mergeSha`, `merge_commit_sha`), the merged head (`headSha`) and the merge time on GitHub (`mergedAt`, `merged_at`); polling provides them too when the forge reads them | same as for polling |
| `pull_request` closed without merge | `pr.closed`, one per closing | ticket's work cancelled |
| `pull_request` reopened (the ticket's PR) | `pr.opened`, one per reopening | the PR is open again; the ticket stays blocked until a human retry |
| `pull_request` open with `mergeable_state: dirty` | `pr.conflicted` (head and base) | the pack's: the rebase step, on the counter of red CI (ORC-146, [preset](preset.md#rebase-step-orc-146)) |
| `check_run` / `check_suite` completed with failure (`failure`, `timed_out`, `cancelled`, `action_required`, `stale`, `startup_failure`) on the PR head | `pr.checks_failed`, with the list of failing checks the forge reads on that head; nothing if it reads that head as in progress or green (run cancelled then rerun); if it does not respond, the webhook's check alone | the pack's, bounded by `limits.ci_fix_attempts` |
| `check_run` / `check_suite` completed green | `pr.checks_passed`, only when the forge then reads **all** checks of that head as green; if it does not respond, 500 | the pack's |
| `push` on the ticket's branch by an account that is not a bot | `push.human` (untrusted) | the agent's work pauses and `verify` checks the pushed commit from the forge in a fresh clone; a push of the commit verified last is the factory's own (ORC-159, [`workflow.md`](workflow.md)) |
| `pull_request_review` submitted, `pull_request_review_comment` created, by a human | `pr.reviewed` (untrusted), signed by the sender's login (`github:<login>`) | on the ticket's open PR, with words and not an approval, from a writer of the repository: kept for the agent, and in *Human Review* a round of human feedback, `fix-human` after 3 minutes, then `verify`, the AI review and *Human Review* again (ORC-190, [preset](preset.md#human-review-feedback-orc-190)) |
| `push` on the repository's default branch (`repository.default_branch`) where a commit merges a PR of a tracked ticket, or reverts a merged PR of a ticket | `default_branch.pushed` (untrusted), one per ticket concerned, with only its relevant commits (SHA, message, author, `merges` or `reverts`: PR number) and the push time (`repository.pushed_at`) | none: read by the measurements (14-day revert, ORC-278) |
| `workflow_run` completed (`completed`) on a tracked ticket's branch, in the project's repository (not a fork) | `ci.run_completed` (untrusted), one per run and per attempt (`ci:<ticket>:<run id>:<run_attempt>`), with the PR, the head, the conclusion and the duration | none: read by the measurements (CI cost, ORC-278) |

A check on a commit the PR has moved away from is ignored. A forge read lagging behind the webhook (check still read as "in progress") lets nothing through: polling catches up the verdict. Webhooks are processed one at a time, in order of arrival: a slow forge read delays the following responses. Commit statuses (`status`) only go through polling. A conflict only appears on a `pull_request` webhook where GitHub has already computed mergeability: a conflict created by a push to the default branch, with no event on the PR, waits for reconciliation (ORC-185). Since ORC-125 the agents never push: the factory's own pushes come from its App, a bot, and are no `push.human`; a push of the commit `verify` last found green is the factory's own whatever account the forge names (a version whose agents still push themselves gets no reaction to `push.human`, ORC-159). `pr.reviewed`, `default_branch.pushed` and `ci.run_completed` are not accepted keys under `on`: the engine records them without reacting. `pr.conflicted` is one since ORC-146.

**Default branch pushes and CI runs (ORC-278).** A push to the default branch has no ticket branch: each commit is linked by what GitHub writes about it, never by an agent's text read as a claim:

- a commit **merges** a PR of a tracked ticket when GitHub wrote it (committer `web-flow`, the one of the merge button) with its merge subject (`Merge pull request #<n> from …`, or `<title> (#<n>)` for a squash; the last `(#<n>)` is the one GitHub adds) and `<n>` is the PR of a ticket of the project, or when its SHA is the merge commit or the head of a PR whose `pr.merged` is in the journal (rebase merge). The same subject typed by someone else (a cherry-pick, an agent commit) merges nothing;
- a commit **reverts** a merged PR when its message contains `This reverts commit <full sha>` (`git revert`, and the commit of GitHub's *Revert* button) and that SHA is the merge commit or the head of a journaled `pr.merged` of the project (`Store.mergedPrOf`), or `Reverts <owner>/<repo>#<n>` (body of the *Revert* button's PR, kept by a squash) for a PR `<n>` of a ticket of the repository;
- no revert is read in the commit that merges a factory PR (a squash keeps the messages of the agent's commits), nor in an entire push that merges it via a merge commit or a rebase: it brings in the PR's commits, written by the agent; a revert pushed alongside the squash of a factory PR is read;
- a push with no relevant commit produces nothing. The id `default-branch:<ticket>:<after>` deduplicates a redelivery.

The merge push may arrive before the `pr.merged` of the same merge: it is then linked by its subject; a rebase merge arriving first is not seen (the ticket's revert measurement stays empty as long as no push concerns it), and its commits' messages are read like those of a human push: an agent commit that writes `This reverts commit <sha of another factory merge>` would count a revert on the other ticket. Each PR number and each SHA of a push is looked up once; looking up a SHA reads `journal` (Postgres) or `events` (SQLite) without a dedicated index. A CI run's duration is that of its attempt, from `run_started_at` (start of this attempt, not the first) to `updated_at` of the `completed` webhook: the webhook carries both, with no API call. Billed minutes (`GET /actions/runs/{id}/timing`) are not read: GitHub is retiring these usage endpoints, and they would require one call per run; the attempt duration is the workflow's wall-clock time, not the sum of its parallel jobs nor the bill's per-minute rounding. A run with no PR listed by GitHub is counted on the ticket's PR at the time of the webhook if it is open, otherwise without a PR. A run whose head repository is not the project's (a fork, or a deleted fork: `head_repository` null) is ignored.

## Branches

Each ticket works on `relais/<ticket>-<title-slug>` (e.g. `relais/rel-12-export-csv`), created from `origin/<default branch>` (read from `refs/remotes/origin/HEAD`, otherwise `main`). A local or remote branch with the same name is reused. The `not_started` check refuses to take a ticket that already has a `factory/<ticket>-…` branch on the forge; with `intake` on, it is part of intake's duplicate search ([preset](preset.md#duplicates-existing-code-and-scope-orc-207)).

## Branch protection (strongly recommended)

The pack forbids agents from `gh pr merge` and any push ([`pack-and-skills.md`](pack-and-skills.md#permissions)), but these refusals are a **guard against mistakes, not a barrier**: they depend on Claude Code and on how the command is written, and an agent that runs code can bypass them. A push fails for want of means: no token in a sandbox, and on the host a git config that sends every push nowhere, which an agent under the daemon's user can still undo (ORC-349, [`interface-and-security.md`](interface-and-security.md#known-limitations)). It is GitHub that guarantees only humans merge. On the default branch of each repository:

- **Require a pull request before merging** (with at least one approval if your team reviews);
- **Block force pushes** and forbid deletion;
- **Require status checks to pass** with your CI checks;
- do not put Relais's account in the exceptions (*bypass*).

The knowledge repository (`relais-knowledge`) deserves the same protection: a human merges there.

## `factory doctor`: CI secrets and factory branches

`factory doctor [repo] [--json]` (current repository by default) checks, before entrusting a repository, that no CI can expose secrets to a `factory/*` branch. The check lives in `doctor`, not only in the `fix-ci` skill: a factory PR must never trigger a job that reads the repository's secrets without a human having approved it.

The command resolves `owner/name` with `git remote get-url origin`, then reads with the GitHub App:

- `.github/workflows/*.yml` and `*.yaml` (Contents API, default branch);
- `GET /repos/{owner}/{repo}/environments` and their `protection_rules`.

It requires the GitHub App (`github.*` or `GH_APP_*`): no `gh` fallback for this check. Exit code `0` if the repository is accepted, `1` if it is refused or if a read fails.

### Rule

Each workflow is read as YAML. A workflow **with secrets** (a `secrets.X`, `secrets['X']` or the whole `secrets` context in an expression, `${{ … }}` or an `if:`, or `secrets: inherit` on a reusable workflow call) or **with a writable `GITHUB_TOKEN`** is refused if it can run on a factory branch. A shell text that names a secret outside an expression references none; `secrets.GITHUB_TOKEN` is the token, judged by its rights. The token's rights come from `permissions:`, the job's or else the workflow's: `read-all`, `{}` or scopes at `read`/`none` are read only; `write-all` or a scope at `write` can write. Without `permissions:`, the token has the repository's default rights, which the App cannot read (that read needs the *Administration* permission, which the App does not have): doctor counts it as writable, and says to declare `permissions:` (ORC-353). The triggers that reach a factory branch:

- `pull_request` and `pull_request_target`: always considered risky, because a PR from `factory/*` can trigger them; a pull request's `branches` filter applies to the base branch, not the head branch;
- `push` without a filter: all branches;
- `push` whose `branches` filter can reach `factory/*` (`factory/**`, `*/*`, `**`…) or whose `branches-ignore` does not fully exclude it. The filters are tried on branch names the factory's own naming makes (`factory/<id>-<slug>`, `branchName`, ORC-353): a pattern under `factory/` always counts as reaching (it may name a team key no example has), and a negation excludes the factory's branches when it matches every one of them (`!factory/*-*` does);
- `workflow_run` without a filter, or with a filter that reaches `factory/*` (extra protection against the same family of risk).

Conversely, a `push` limited to non-factory branches (`main`, `release/*`) or to tags only does not see secrets on a `factory/*` branch.

Accepted:

1. a dedicated CI **without secrets**, its `GITHUB_TOKEN` read only, on these branches;
2. a workflow with secrets or a writable token where **every job that sees one** is attached to a GitHub environment whose `protection_rules` contain `required_reviewers` with at least one reviewer: human approval blocks the job before it reads the secret;
3. a workflow with secrets that only runs on non-factory branches, or only on tags.

When in doubt, `doctor` refuses: invalid or ambiguous YAML (multi-document, dynamic `on`, mistyped filters), environment not found or without required reviewers, `secrets: inherit` without a protected environment, `permissions:` it cannot read, a `GITHUB_TOKEN` without `permissions:`, GitHub API error, unreadable API response (never read as "no workflow", "no environment", "no reviewer" or "protected"), more than 1000 environments. A 404 on `.github/workflows` means "no CI"; a 404 on the App's installation or on its token is a configuration error: `doctor` refuses.

### Examples

Refusal:

```text
$ factory doctor
GitHub Actions workflows: 1

.github/workflows/ci.yml
  triggers: pull_request
  factory branches: reached
  secrets: yes
  GITHUB_TOKEN: test (repository default)
  environments: none
  protected environment: no
  verdict: refused — secrets and a writable GITHUB_TOKEN exposed on the factory's branches (pull_request can run the CI on a `factory/*` branch) without human approval
  ...
Result: refused — 1 workflow(s) of 1 can expose secrets or a writable GITHUB_TOKEN to the factory's branches.
```

Acceptance with human approval (`ci-protected` has a `required_reviewers` rule):

```yaml
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    environment: ci-protected
    steps:
      - run: npm test
        env:
          TOKEN: ${{ secrets.NPM_TOKEN }}
```

`factory doctor` then displays `secrets: yes`, `protected environment: yes` and `verdict: accepted`.

`--json` produces the same verdict in an object `{ repoPath, accepted, workflows: [{ path, triggers, secrets, githubToken, factoryBranches, environments, protected, verdict, reasons }] }`, without any secret value (`githubToken`: the jobs whose token can write, with their rights).

### Limitations

- Reading targets the **default branch** (Contents API without `ref`): the `pull_request` workflows are indeed the ones GitHub uses for a PR from `factory/*`; a workflow that only exists on a pushed branch is not seen.
- The App cannot list the repository's secrets: `doctor` detects **references** to secrets, not their existence.
- Called reusable workflows are not downloaded: `secrets: inherit` is treated as a secret, and a reusable workflow called without `secrets:` receives no secret.
- This check does not replace branch protection: it only guarantees that CI does not read a secret on a factory branch without approval.
- Required permission: **Actions: read** (present in [`github-app-manifest.json`](github-app-manifest.json)); it is the permission GitHub associates with `GET /repos/{owner}/{repo}/environments`. An App created before ORC-135 must add it, otherwise this read returns 403 and `doctor` refuses the repository.

## CI

Relais does not impose a CI but makes use of it: `pr.checks_failed` triggers `fix-ci` (diagnosis, local reproduction, fix or question), and the `review` skill waits for a green CI. A CI that runs at least lint, types and tests is therefore recommended, in addition to the `verify` commands Relais runs itself after each run ([`workflow.md`](workflow.md#jobs)).

The Relais repository itself has a GitHub Actions CI (`.github/workflows/ci.yml`): on every PR and every push to `main`, Node 24, `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`.
