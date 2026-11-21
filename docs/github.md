# GitHub

The factory talks to GitHub through **git** and a **factory GitHub App**, the only way the daemon reads or writes GitHub: the `gh` CLI and its token are gone (ORC-181). **Only the factory writes to GitHub** (ORC-125, [Publishing](#publishing)): agents commit, and have neither a token nor network access to push. The daemon tracks PRs in two ways, which write the same events to the inbox: **GitHub webhooks** (`POST /webhooks/github`, as soon as their secret is configured, see [GitHub webhooks](#github-webhooks)) and the **GitHub reconciliation**, every 5 minutes (ORC-185, [What the reconciliation reads](#what-the-reconciliation-reads)), which catches up what the webhooks lost. The 30-second poll is gone (ORC-181): without webhooks, a merge or a CI verdict is seen within 5 minutes.

## Daemon authentication

### GitHub App (recommended)

The GitHub App is the identity of the **daemon**, not of the agents. It is used to read PRs, checks and review threads, and to publish: push the ticket's branch, open its draft PR, merge.

```yaml
# <FACTORY_HOME>/config.yaml
github:
  appId: "123456"
  privateKey: /home/factory/.factory/github-app.pem # inline PEM or file path
  installationId: "987654"                          # optional
```

Environment variables serve as a fallback, for existing installations and Docker:

| Variable | Role |
|---|---|
| `GH_APP_ID` | App identifier |
| `GH_APP_KEY` | PEM private key, or path to the `.pem` file |
| `GH_APP_INSTALLATION_ID` | installation to use; optional |

A value in `config.yaml` takes precedence over the environment variable. If only one of the two values `appId` / `privateKey` is provided, startup fails with an explicit message rather than silently starting without the App.

#### Creating the App

1. GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Enter a name and a URL. **Webhook**: active, URL `<publicUrl>/webhooks/github`, secret = the value of `github.webhookSecret` (or `GH_WEBHOOK_SECRET`); events: *Pull request*, *Pull request review*, *Pull request review comment*, *Check run*, *Check suite*, *Push*, *Workflow run* (the last two are also used for the revert and CI cost measurements, see [GitHub webhooks](#github-webhooks); *Workflow run* requires the *Actions* read permission, already in the manifest). `<publicUrl>` is the server's HTTPS URL, behind its reverse proxy ([`deployment.md`](deployment.md#tls-and-webhooks)); on a workstation, a tunnel (ngrok, `cloudflared tunnel`) in `publicUrl`, for development only (smee relays Linear's webhooks, not GitHub's). Without a public URL, leave it disabled: the reconciliation reads the PRs every 5 minutes (ORC-181).
3. Under **Repository permissions**, apply the manifest [`github-app-manifest.json`](github-app-manifest.json):
   - **Contents**: read/write (the ticket's branch, and the captures' `factory/artifacts` branch, ORC-407);
   - **Pull requests**: read/write;
   - **Checks**: read/write (the `factory/*` checks published on the pushed commit, ORC-151; an App created earlier must add it, otherwise these checks are not published, and the log says so);
   - **Commit statuses**: read;
   - **Actions**: read (list environments and their protection rules, for `factory doctor`; read the log of a failed Actions job, for the fix of a red CI, ORC-459);
   - **Metadata**: read (mandatory for every App).
   No **administration** permission, no `Actions` write, no `Workflows`. `factory doctor` refuses an installation that holds *Administration*, *Workflows* or *Actions* at write, and warns about any other permission above the manifest (ORC-439, ORC-441, ORC-443, [below](#factory-doctor-host-branch-protection-ci-secrets-and-factory-branches)).
   For the dashboard's GitHub sign-in (ORC-399), under **Identifying and authorizing users**: *Callback URL* `<publicUrl>/auth/github/callback`, *Expire user authorization tokens* left on, *Request user authorization (OAuth) during installation* off. If `dashboard` in `factory.yml` names an `org` or a `team`, add the **Organization permission** *Members*: read, and install the App on that org: GitHub answers a membership to the App's user token only then. A list of `logins` needs neither.
4. Create the App, note its **App ID** and its **Client ID**, **Generate a client secret** (for the dashboard's sign-in, `GH_APP_CLIENT_SECRET`), then **Generate a private key**. Place the `.pem` outside the repository, with mode `0600` (for example `~/.factory/github-app.pem`).
5. **Install** the App on the repositories entrusted to the factory. The installation ID is visible in the URL `https://github.com/settings/installations/<id>`; it is optional, the daemon can look it up repository by repository.
6. Fill in `config.yaml` or the `GH_APP_*` variables (`factory init` prints these steps and writes `factory.yml` with `github: { app_id: env:GH_APP_ID, private_key: env:GH_APP_KEY }`, ORC-411), then restart `factory up`. Startup logs the chosen forge, without secrets.

#### Tokens

- The daemon signs an **RS256 JWT** with the private key: `iss = appId`, `iat = now - 60 s`, `exp = now + 9 min`.
- It exchanges this JWT for an **installation token**: `POST /app/installations/{id}/access_tokens` with `{ "repositories": ["<run's repository>"] }`. If `installationId` is not configured, it first calls `GET /repos/{owner}/{repo}/installation`.
- The token lasts **at most 1 hour**. It is cached **per repository** until it expires, with a 60 s safety margin.
- It stays **in the daemon's memory**: never written to disk, never logged, never passed to Claude Code runs. A run therefore cannot act on another repository with this token.
- The private key is never logged. The startup message contains only the App ID and, where applicable, the installation ID.

#### Key rotation

1. GitHub App → **Private keys → Generate a private key**.
2. Drop in the new `.pem` (mode `0600`) and update `github.privateKey` or `GH_APP_KEY`.
3. Restart the daemon; cached installation tokens are discarded and new ones are issued with the new key.
4. Revoke the old key in GitHub. Already-issued installation tokens expire on their own in less than an hour, but a compromised private key can issue new ones: revoke it without delay.

### Without a GitHub App

There is no fallback any more (ORC-181: the `gh` CLI and its token are gone). Without a `github` section nor `GH_APP_*`, the daemon still starts, logs `Warning: no GitHub App (…): the factory reads no PR, publishes nothing and merges nothing.`, and every read of the forge fails with that reason (`NoForge`): no PR, check or permission is read as absent. `/health` names the publication as impossible, and a verified ticket is blocked with that reason. `factory baseline`, `factory doctor` and `factory ghost start` refuse without the App.

### The daemon's own git

The daemon's git reads the forge with the App's installation token too (ORC-442), as the factory's push does ([Publishing](#publishing)): the `git fetch` of the clones before a launch and of the default branch read before it (`.factory/config.yml`, which `doctor` then reads without a fetch), the clones of `verify` and of the dry run, the knowledge base's pull and its note's push, `factory ghost`'s clones and diffs. `factory plan`'s `git ls-remote` (whether a ticket's branch exists) is a command line's, and still uses the machine's credentials. A private repository is read without any git credential on the machine: that is how the Docker image reads it, which configures none since ORC-181 ([`deployment.md`](deployment.md#current-limits)).

- **Which repositories**: those whose `origin` is an `https://github.com/` URL, the token being the one of that repository (limited to it), so the App must be installed on the knowledge base's repository as well to read a private one. An `origin` over SSH (`git@github.com:…`), on another host or a path, and a repository the App has no token for (not installed there, logged `GitHub App: no installation token to read …`), are read with the git credentials of the machine that runs the daemon, as before: an SSH key or agent, or a git credential helper.
- **When GitHub does not answer**: the token is asked within the read's deadline. A 5xx, a rate limit or the network fails the read as a transient error, retried; it is never read without the token. A refusal (a 4xx: the App not installed there) falls back to the machine's credentials for 10 minutes, said once in the log.
- **The knowledge base's note** (ORC-386) is pushed as the App, with its *Contents* (write), when the App is installed on the knowledge base's repository: a protection of its default branch must let the App push there, or the note is undone in the clone, as for any refused push.
- **Without the App** (a run on a workstation, `factory init` before the App): nothing changes, the user's own git credentials read `origin`. Check with `git fetch` from the repository.
- **Where the token goes**: in git's environment alone, as an `http.https://github.com/.extraheader` passed through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`. Never in a URL, a command line (visible to every process of the host, and quoted in git's errors), a log line, nor a repository's `.git/config`: the clone's `origin` stays the URL it was. A test with a fake private git server holds it (`src/adapters/forge/fetch-auth.test.ts`).

### Publishing

The factory publishes (ORC-125), through the outbox's `publish` effect, which `decide` only writes for the commit that `verify` has just found green (invariant I1) and which `mayPublish` checks again at execution time. It requires sandboxes and the GitHub App (*Contents* and *Pull requests* write permissions). `GitPublisher` (`src/publish/publish.ts`):

1. reads from the forge the default branch and the head of the ticket's branch; a head already at the commit goes straight to the PR, without pushing: that is the replay of an interrupted publication;
2. bundles the branch, in the agent's own repository (ORC-317), in a fresh sandbox at `none`, its `.git` read-only; no host git runs there, and the git directory of `repoPath` is mounted nowhere. It verifies the bundle, clones it without checkout, without the repository's hooks or config, and compares its head to the verified commit;
3. checks the diff since the base, blocking: `factory/chemins-interdits` (outgoing symbolic links and `package.json#scripts` included), `factory/binaires`, `factory/anti-triche`, `factory/secrets`;
4. pushes **forward only**, with `--force-with-lease` on the head it read: if the branch carries a commit absent from the work (a human push, or rewritten history), nothing is pushed, nothing is forced: the agent rebases its work on a human's push (ORC-159), and `verify` refuses a commit that does not carry it (`factory/commits-humains`);
5. opens the **draft** PR, looked up by branch before creation (a normal PR if the repository's plan has no drafts). It leaves draft when the ticket moves to *Human Review*: GitHub does not merge a draft. At that move the factory also labels it `revue: requise`, `revue: échantillon` or `revue: auto` (ORC-198, [preset](preset.md#the-class-of-the-diff-and-the-review-label-orc-198)), one label of that group at a time, created by GitHub on first use (*Pull requests* write is enough); best effort, like the move out of draft;
6. publishes on the pushed commit the checks `factory/verify` (the commands that ran; `neutral` with no declared command), `factory/tests-gelés` (`neutral` with no freeze) and `factory/anti-triche` (ORC-151), identified by `external_id` = `<check>@<sha>`: a replay, or a second publication of the same commit, updates them, without duplicates. Best effort: a refused check (App without *Checks* write) is logged and does not block the ticket. A red verdict is never pushed, so it has no check. These `factory/*` checks never count as the commit's CI (check reading, reconciliation, webhook), known by the App that created them, not by their name (ORC-353): another App's check named `factory/…` counts as CI; through `gh`, which reads no App, by their `factory/` prefix: on their own, they do not make a head green.

A refusal is an answer: the ticket is blocked with the reason (`publish.refused`), decided once; the retry that publishes takes it where it was meant to go (`owedMove`). A failure is replayed by the outbox, then blocks the ticket. A run with no commit beyond the base ends without a PR.

The PR's text is composed by the factory (ORC-195, `describePr` in `src/publish/describe.ts`), never copied from the agent's messages. Its title: the ticket's id and title, clipped to GitHub's 256 characters. Its body, after a `Ticket: <id>` line, always in the reviewer's order, each section present even when empty (« None stated. »):

1. **Why** (`why`);
2. **What changes** (`summary`);
3. **Assumptions** (`assumptions`);
4. **Risks** (`risks`);
5. **Untested** (`untested`);
6. **Trusted without verification** (`trusted`): libraries, external services and behaviours taken as correct, the approved spec's section, which the agent carries into its result (the spec itself is ORC-212's);
7. **Where to look first** (`review_hints`);
8. **Evidence**: what the factory checked, on which commit (the commands `verify` ran green in a fresh clone), apart from the tests the agent says it added; the visual proof's captures at each screen width, narrowest first, before and after (taken by ORC-176, hosted by ORC-407: see [The captures in the PR](#the-captures-in-the-pr-orc-407)); taken and not shown, the reason; required and not taken, that none was.

The AI review's findings (ORC-183) will take their place between *Where to look first* and *Evidence*. The fields come from the agent's `submit_result`: in its text, an HTML tag or comment is shown as text, a line-leading `#`, a setext underline (`---`, `===`) and a code fence are escaped, and a list entry stays on its line, so nothing it writes passes for a section of the factory's or hides one. `submit_result` refuses fields whose description would pass the cap of a PR body less 1,500 characters, the room the factory's own facts take (`FACTS_ROOM`). No closing keyword: it would be a claim on the whole ticket. The text goes through the `OutputPolicy` (ORC-214, see [`linear.md`](linear.md#what-the-factory-publishes-orc-214)): a refused text (a blob, a secret, past its cap) blocks the publication with the reason, and nothing goes out. A PR already open (a second publication of the ticket's branch, a fix) keeps its description: the text sent then is a fixed `Ticket: <id>`, so nothing the fix submitted can hold its push back.

### The captures in the PR (ORC-407)

GitHub shows an image in a PR only from an address its image proxy can fetch: the dashboard, behind its sign-in (ORC-399), is not one. So the captures `verify` took and kept (ORC-176, ORC-404) are committed on an **orphan branch `factory/artifacts`** of the ticket's repository, and the PR cites each one as `https://github.com/<owner>/<repo>/blob/<commit>/<ticket>/<side>-<width>-<sha256[:16]>.png?raw=true`. GitHub shows it to whoever can read the repository, and to no one else: no public storage, no extra secret.

- **Who writes**: the factory's GitHub App, with its *Contents* write permission, through the Git Data API (`hostArtifacts`, `src/adapters/forge/github-app.ts`): blobs, one tree on the branch's tip, one commit, then the ref. The only ref it names is `refs/heads/factory/artifacts`: no other branch is ever written by this path. The first commit is an orphan root with a `README.md`; every one after is a **fast-forward** (`force: false`). Another writer's commit in between is read again, 3 times at most. A replay that finds its files writes nothing.
- **Protection**: GitHub applies the repository's branch protection and rulesets to the App's ref update, and the factory asks no bypass. A refusal (a rule, a permission, an empty repository) is an answer: the PR opens all the same and says the captures were taken and why they are not shown. A rate limit, a 5xx or the network makes the publication retry. To let the captures through a ruleset that covers every branch, exclude `factory/artifacts` from it, or make the App a bypass actor for that branch only.
- **When**: at the publication that opens the PR. A fix on a PR already open keeps its description, so its new captures are not added.
- **Cleanup**: daily, and at the daemon's start, each repository's tip loses the folders of the tickets whose last PR event is its merge or its closing, 30 days ago or more (`pruneCaptures`), in one fast-forward commit. A ticket the factory does not know, or whose PR is open, keeps its folder. The branch's history is not rewritten: an old commit still holds those images, for those who can read the repository, and the links of PRs younger than 30 days, pinned to their commit, stay valid.
- Never merge `factory/artifacts`, and never base a branch on it.

On the agent side: `git push` and `gh` writes are refused by the pack and its hook, the proxy refuses `git-receive-pack` at every agent network level, and no token enters a sandbox. On the host, without a sandbox, only the hook holds: ORC-179.

### Read access for the daemon's git

On each repository entrusted to the factory, the daemon's git must read its branches (`git fetch`). With an `https://github.com/` origin, the App's token does it (*Contents*, [above](#the-daemons-own-git)); with an SSH origin, the machine's credentials must: with a deploy key, read-only is enough. The PRs, checks and review threads are read by the App.

## Human permissions

The [authorization matrix](linear.md#authorizations-who-can-do-what) (ORC-186) reads a user's permission on the repository (`GET /repos/{owner}/{repo}/collaborators/{login}/permission`), through the GitHub App (*Metadata* read permission, already requested); without the App, the read fails and the delegation is refused. The GitHub login of each Linear user is declared in `config.yaml` (`projects[].authz.githubLogins`, see [configuration](configuration.md#authorization)). A permission once read is kept for 60 s.

## What the reconciliation reads

Every 5 minutes, with Linear's reconciliation (ORC-185, `GithubReconciler`), whether GitHub webhooks are configured or not (the 30-second poll is gone, ORC-181), for each tracked ticket that has a branch and is not `done` (a ticket moved to `done` before the reconciliation sees the merge of its known PR keeps being read, only for the merge or closing of that PR, until it sees them: Linear may move it to *Done* first, and only `pr.merged` stops the code work):

- `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=all`: the branch's PR (open, merged, closed);
- if it is open, `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` and `GET /repos/{owner}/{repo}/commits/{sha}/status`: aggregated CI state (`fail` if a check fails or is cancelled, `pending` if a check is running, `pass` otherwise, `none` with no check).

A **human push** whose webhook got lost is caught up (ORC-281): the reconciliation reads the head of the open PR and compares it with the heads the factory knows. The factory's own heads are the last commit it pushed and the head that push went over (its `publish.done`, the last in the ticket's journal that pushed something, an `empty` one having pushed nothing, ORC-402; `before`, read on the forge by the publisher, ORC-438, kept under the effect's key `effect:<key>:before` for a replay that finds its commit pushed, and read through a later publication of the same commit that pushed nothing: just after a push, the forge may still read the PR on it, whoever pushed it), and the commit `verify` found green last, which a publication may have pushed before its `publish.done` is read (the ticket is read again after the PR, for that); a human push already received is the ticket's `humanHead` until a publication carries it. Any other head is a `push.human` (untrusted), with the webhook's unknown author, `inconnu` (the PR names no pusher) and as `before` the head last known, under the webhook's id, `push:<ticket>:<sha>`: whichever of the webhook and the reconciliation comes second, the inbox drops it, and the push has its effects once (pause, `verify` on the pushed commit, ORC-159). A ticket the factory has not published on yet (no `publish.done`) has no head to compare with: the head read then is not caught up. A `publish.done` with no `before` (journaled before ORC-438, a push that made the branch, or a publication whose publisher failed after its push and before it returned) falls back on the earlier rule: the last two commits the factory pushed (a commit published twice in a row counted once) and, before the second, the head read with no publication, kept in the `lost-push:` meta. A taken-over ticket's head waits for the take-over's end: its bundle is pushed before its `push.human`, which names the human (ORC-234). A head is judged at each pass that reads it, against the ticket's journal then, so a branch put back on an earlier head is judged again, even when no pass read the PR in between: on the last push or the head it went over, or on a human push already received, it is not caught up; on an older commit, the factory's included, it is, as the webhook reports it, unless that commit was already caught as a human push once: the inbox holds its id and drops it, as it would drop the webhook's. A failed judgement holds back no CI verdict: it is tried again at the next pass. The PR does not say who pushed either: where the webhook leaves out a bot's push (a CI job's autofix, Dependabot), the reconciliation takes it for a human's, and the agent pauses while `verify` checks it. Without GitHub webhooks, this is how a human push is seen at all, within 5 minutes. Publishing over such a push is refused: see [Publishing](#publishing).

At the time of a `dev-feedback` or `fix-human` run, **unresolved** review threads are read via GraphQL (`reviewThreads`) and turned into feedback for the agent: every comment of each thread, a reviewer's reply included, as its own item (ORC-347). A comment by a bot account (GitHub types an App, the CI or Dependabot as `Bot`) is dropped; the factory's own reviewer will be let through once ORC-183 exists. The feedback is capped at `REVIEW_FEEDBACK_MAX` characters as the prompt writes it (`review-threads.ts`): past it, the most recently active threads are kept whole, none older than one cut; the newest thread over the cap alone keeps its latest comments, the last one cut short if it is over on its own. A last item tells the agent what was left out and that it is still on the PR (ORC-366). A comment whose date does not parse fails the read. Every page of threads and of an unresolved thread's comments is read; a list GitHub answers without saying where it ends, or longer than 10 pages of 100, fails the read rather than reach the agent cut short. Linear lists follow the same rule: delegated tickets (10 pages of 100), a team's states, labels and members (10 pages of 250), and an issue's labels past Linear's default page.

Events produced (see [`preset.md`](preset.md#reactions)):

| Observation | Event | Standard pack |
|---|---|---|
| New PR for the branch | `pr.opened` | URL added to the Linear session |
| CI turning red | `pr.checks_failed` (with the list of failing checks and the head they ran on, ORC-466) | ignored, with a trace, on another PR than the ticket's open one or on a head a push has left behind (ORC-466); then `fix-ci` if the ticket is in *Human Review* or *AI Review* and not blocked, a round of the review and CI loop (`limits.ci_fix_attempts`, 2 per run, shared with `rebase` and the AI review's `fix-review`, ORC-184); after that the ticket is blocked ([`preset.md`](preset.md#limits)) |
| CI turning green | `pr.checks_passed` | lifts the block caused by the red-CI limit; the count of the loop stays, one per run (ORC-184) |
| PR merged | `pr.merged` | *Done*, the `after_merge` step (the requester mentioned with the PR's link, the changelog entry, ORC-197), worktree deleted, no run (ORC-193); after that, no more code runs on the ticket |
| Factory merge refused (ORC-148) | `pr.merge_refused` | push during review: back to *AI Review*, AI review relaunched on the new commits; other refusal (PR not mergeable…): back to *Human Review* with the reason |
| PR closed without merge | `pr.closed` | the ticket's work is cancelled (see [`preset.md`](preset.md#events-a-human-or-the-pr-sends)) |

A CI state change is reported only once (not at every pass). The PR's **unresolved** review comments are re-read at the time of a `dev-feedback` or `fix-human` run (`feedback` input): resolve a thread on GitHub so it is no longer sent back to the agent. An inline comment that started a round of human feedback (ORC-190) reaches the agent through its thread only.

Without a GitHub webhook, it takes up to 5 minutes for a merge or CI to be taken into account. A CI verdict is named by the PR head (`pr:<ticket>:<n>:checks:<fail|pass>:<sha>`): the reconciliation and the webhook seeing the same verdict on the same commit write it only once to the inbox, and a red verdict seen again on the same commit after a green one (CI rerun) is not reported a second time.

## GitHub webhooks

`POST /webhooks/github` receives the App's webhooks (ORC-134), at `<publicUrl>/webhooks/github`. In production GitHub calls the server directly in HTTPS, through the host's reverse proxy or the optional `caddy` service (`--profile tls`), which pass the body unchanged to `factoryd` in plain HTTP: [`deployment.md`](deployment.md#tls-and-webhooks) (ORC-221). On a workstation, a tunnel in `publicUrl` stands in for it.

- **signature**: `X-Hub-Signature-256` must equal `sha256=` followed by the HMAC-SHA256 of the raw body with the secret, compared in constant time; otherwise refused (401) and **nothing is written**. The secret comes from `github.webhookSecret` in `config.yaml`, otherwise from the `GH_WEBHOOK_SECRET` variable. Without a secret (or with a secret made of whitespace), **all** GitHub webhooks are refused, and `factory up` reports it at startup;
- **inbox written before the response** (ORC-147): a 200 means "written"; if the daemon goes down right after, even with `kill -9`, the event is processed at the next startup. If the write fails, the response is 500: GitHub does not resend a failed delivery on its own; redeliver it from the App's *Advanced* tab, or let the reconciliation catch it up;
- **deduplication and replay**: each event's id comes from the signed body (PR number, SHA, review or comment id), never from `X-GitHub-Delivery`, which the signature does not cover (it is only used for the log). A redelivery, a replayed body, or the same fact seen by the reconciliation carries an id the inbox already has: it is not reprocessed. GitHub does not sign a timestamp: there is no freshness check; deduplication in the database stands in for it;
- **linking to the ticket**: by the PR's (or push's) branch, like the reconciliation, and by repository: `repository.full_name` must be the `origin` repository of the ticket's project (read once via `git remote get-url origin`). Only a branch of a tracked ticket, in its project's repository, produces an event; everything else (another repository where the App is installed, another branch, a body of another shape) is accepted (200) and ignored. An older PR of the branch, already closed, is ignored too.

| Webhook | Event in the inbox | Reaction |
|---|---|---|
| `pull_request` closed with `merged: true` | `pr.merged` (preceded by `pr.opened` if the ticket does not know the PR), with the merge commit (`mergeSha`, `merge_commit_sha`), the merged head (`headSha`) and the merge time on GitHub (`mergedAt`, `merged_at`); the reconciliation provides them too when the forge reads them | same as for the reconciliation |
| `pull_request` closed without merge | `pr.closed`, one per closing | ticket's work cancelled |
| `pull_request` reopened (the ticket's PR) | `pr.opened`, one per reopening | the PR is open again; the ticket stays blocked until a human retry |
| `pull_request` open with `mergeable_state: dirty` | `pr.conflicted` (head and base) | the pack's: the rebase step, on the counter of red CI (ORC-146, [preset](preset.md#rebase-step-orc-146)) |
| `check_run` / `check_suite` completed with failure (`failure`, `timed_out`, `cancelled`, `action_required`, `stale`, `startup_failure`) on the PR head | `pr.checks_failed`, with the list of failing checks the forge reads on that head; nothing if it reads that head as in progress or green (run cancelled then rerun); if it does not respond, the webhook's check alone | the pack's, bounded by `limits.ci_fix_attempts` |
| `check_run` / `check_suite` completed green | `pr.checks_passed`, only when the forge then reads **all** checks of that head as green; if it does not respond, 500 | the pack's |
| `push` on the ticket's branch by an account that is not a bot | `push.human` (untrusted) | the agent's work pauses and `verify` checks the pushed commit from the forge in a fresh clone; a push of the commit verified last is the factory's own (ORC-159, [`preset.md`](preset.md#the-workflow-the-engine-runs-orc-389)) |
| `pull_request_review` submitted, `pull_request_review_comment` created, by a human | `pr.reviewed` (untrusted), signed by the sender's login (`github:<login>`) | on the ticket's open PR, with words and not an approval, from a writer of the repository: kept for the agent, and in *Human Review* a round of human feedback, `fix-human` after 3 minutes, then `verify`, the AI review and *Human Review* again (ORC-190, [preset](preset.md#human-review-feedback-orc-190)) |
| `push` on the repository's default branch (`repository.default_branch`) where a commit merges a PR of a tracked ticket, or reverts a merged PR of a ticket | `default_branch.pushed` (untrusted), one per ticket concerned, with only its relevant commits (SHA, message, author, `merges` or `reverts`: PR number) and the push time (`repository.pushed_at`) | none: read by the measurements (14-day revert, ORC-278) |
| `workflow_run` completed (`completed`) on a tracked ticket's branch, in the project's repository (not a fork) | `ci.run_completed` (untrusted), one per run and per attempt (`ci:<ticket>:<run id>:<run_attempt>`), with the PR, the head, the conclusion and the duration | none: read by the measurements (CI cost, ORC-278) |

A check on a commit the PR has moved away from is ignored. A forge read lagging behind the webhook (check still read as "in progress") lets nothing through: the reconciliation catches up the verdict. Webhooks are processed one at a time, in order of arrival: a slow forge read delays the following responses. Commit statuses (`status`) only go through the reconciliation. A conflict only appears on a `pull_request` webhook where GitHub has already computed mergeability: a conflict created by a push to the default branch, with no event on the PR, waits for reconciliation (ORC-185). Since ORC-125 the agents never push: the factory's own pushes come from its App, a bot, and are no `push.human`; a push of the commit `verify` last found green is the factory's own whatever account the forge names (a version whose agents still push themselves gets no reaction to `push.human`, ORC-159). `pr.reviewed`, `default_branch.pushed` and `ci.run_completed` are not accepted keys under `on`: the engine records them without reacting. `pr.conflicted` is one since ORC-146.

**Default branch pushes and CI runs (ORC-278).** A push to the default branch has no ticket branch: each commit is linked by what GitHub writes about it, never by an agent's text read as a claim:

- a commit **merges** a PR of a tracked ticket when GitHub wrote it (committer `web-flow`, the one of the merge button) with its merge subject (`Merge pull request #<n> from …`, or `<title> (#<n>)` for a squash; the last `(#<n>)` is the one GitHub adds) and `<n>` is the PR of a ticket of the project, or when its SHA is the merge commit or the head of a PR whose `pr.merged` is in the journal (rebase merge). The same subject typed by someone else (a cherry-pick, an agent commit) merges nothing;
- a commit **reverts** a merged PR when its message contains `This reverts commit <full sha>` (`git revert`, and the commit of GitHub's *Revert* button) and that SHA is the merge commit or the head of a journaled `pr.merged` of the project (`Store.mergedPrOf`), or `Reverts <owner>/<repo>#<n>` (body of the *Revert* button's PR, kept by a squash) for a PR `<n>` of a ticket of the repository;
- no revert is read in the commit that merges a factory PR (a squash keeps the messages of the agent's commits), nor in an entire push that merges it via a merge commit or a rebase: it brings in the PR's commits, written by the agent; a revert pushed alongside the squash of a factory PR is read;
- a push with no relevant commit produces nothing. The id `default-branch:<ticket>:<after>` deduplicates a redelivery.

The merge push may arrive before the `pr.merged` of the same merge: it is then linked by its subject; a rebase merge arriving first is not seen (the ticket's revert measurement stays empty as long as no push concerns it), and its commits' messages are read like those of a human push: an agent commit that writes `This reverts commit <sha of another factory merge>` would count a revert on the other ticket. Each PR number and each SHA of a push is looked up once; looking up a SHA reads `journal` without a dedicated index. A CI run's duration is that of its attempt, from `run_started_at` (start of this attempt, not the first) to `updated_at` of the `completed` webhook: the webhook carries both, with no API call. Billed minutes (`GET /actions/runs/{id}/timing`) are not read: GitHub is retiring these usage endpoints, and they would require one call per run; the attempt duration is the workflow's wall-clock time, not the sum of its parallel jobs nor the bill's per-minute rounding. A run with no PR listed by GitHub is counted on the ticket's PR at the time of the webhook if it is open, otherwise without a PR. A run whose head repository is not the project's (a fork, or a deleted fork: `head_repository` null) is ignored.

## Branches

Each ticket works on a branch named by `branches` of the repository's `.factory/config.yml` (ORC-283, [`repository-configuration.md`](repository-configuration.md#branch-names)), by default `feat/<ticket>-<title-slug>`, or `fix/<ticket>-<title-slug>` for a ticket labelled *Bug* (e.g. `feat/orc-12-export-csv`), created from `origin/<default branch>` (read from `refs/remotes/origin/HEAD`, otherwise `main`). The branch recorded on the ticket stays its branch, so a label or a naming changed since opens no second PR, and a ticket that already has a legacy `factory/<ticket>-…` branch keeps it. A branch with the same name on the forge is reused, otherwise a local one. The `not_started` check refuses to take a ticket that already has one of its branches (any type of the naming, or the legacy `factory/`) on the forge; with `intake` on, it is part of intake's duplicate search ([preset](preset.md#duplicates-existing-code-and-scope-orc-207)).

## Branch protection (required by `factory doctor`)

The pack forbids agents from `gh pr merge` and any push ([`pack-and-skills.md`](pack-and-skills.md#permissions)), but these refusals are a **guard against mistakes, not a barrier**: they depend on Claude Code and on how the command is written, and an agent that runs code can bypass them. A push fails for want of means: no token in the sandbox, and GitHub writes refused by the egress proxy; no run executes on the host (ORC-179, [`interface-and-security.md`](interface-and-security.md#known-limitations)). It is GitHub that guarantees only humans merge. On the default branch of each repository:

- **Require a pull request before merging** (with at least one approval if your team reviews);
- **Block force pushes** and forbid deletion;
- **Require status checks to pass** with your CI checks;
- do not put the factory's GitHub App in the exceptions (*bypass*).

The knowledge repository (`knowledge.repoPath`) deserves the same protection: a human merges there.

`factory doctor` refuses a repository whose default branch has neither (ORC-208). It reads, with the App's read permissions only (*Metadata*): `GET /repos/{owner}/{repo}` for the default branch, `GET /repos/{owner}/{repo}/branches/{branch}` for the classic protection's flag, `protection.enabled` (not the branch's `protected`, which GitHub also sets for an active ruleset, whatever its rules), `GET /repos/{owner}/{repo}/rules/branches/{branch}` for the rules the repository's **active** rulesets apply to it (a ruleset in *Evaluate* mode applies none), and `GET /repos/{owner}/{repo}/rulesets/{id}` of each ruleset with a pull request rule, whose `current_user_can_bypass` says whether the App is in its bypass list (for the App's installation token, checked on the real GitHub against a direct push: isolation test no. 12, ORC-427). Accepted:

- a ruleset with the **Require a pull request before merging** rule (`pull_request`) that the App cannot bypass (`current_user_can_bypass: never`): `doctor` can read it, it is the recommended form. A ruleset the App bypasses (`always`, `pull_requests_only`, `exempt`) does not count; with no other, `doctor` refuses and names it;
- a classic branch protection: its rules need the *Administration* permission, which the App does not have, so `doctor` credits its flag alone and says so; check by hand that it requires a pull request.

Refused: no protection and no ruleset, rulesets without the `pull_request` rule (blocking force pushes or deletion alone still lets a direct push land), or only rulesets the App bypasses. An unreadable answer refuses too. Not checked: the number of approvals the rule requires (0 is accepted, see the bullet list above), nor what a classic protection holds.

**Bypass actors: not read, checked by hand (ORC-428).** `current_user_can_bypass` only says whether the **App** bypasses a ruleset. A ruleset also lists other bypass actors (`bypass_actors`: a repository role such as *Repository admin*, a team, a user, a *Deploy key*, another App), and GitHub returns them only to an account with write access to the ruleset, that is the *Administration* (write) permission; a classic protection's bypass settings need *Administration* too. The App does not have it and must not ([permissions](#github-app-recommended)): it would let the daemon edit the very protection `doctor` checks. So `doctor` cannot tell whether a git credential of the daemon's user bypasses the rule: its SSH keys or agent, an HTTPS credential helper (`~/.git-credentials`), a `gh` token. No agent holds them: runs execute in containers only (ORC-179). But if one bypasses (an admin account's key or token with *Repository admin* or *Organization admin* in the bypass list, a deploy key listed as *Deploy key*, or an admin on a classic protection without *Do not allow bypassing the above settings*), any process of that user on the machine pushes to the default branch without a pull request. That the App was installed without *Administration* is checked apart, on the installation's own permissions ([`factory doctor`](#factory-doctor-host-branch-protection-ci-secrets-and-factory-branches), ORC-439). With every accepted protection, `doctor` prints a warning naming the check under the default branch's verdict, and its result line points to it (`warnings` of `branchProtection` in `--json`, not the top-level `warnings`). Check by hand, in *Settings → Rules → Rulesets* of the repository **and** of the organization, that no bypass actor of a ruleset requiring a pull request is held by those credentials' accounts, and on a classic protection that *Do not allow bypassing the above settings* is checked; better, leave the daemon's user no credential that can push to a protected branch.

## `factory doctor`: host, branch protection, CI secrets and factory branches

`factory doctor [repo] [--json]` (current repository by default), run where the daemon runs, in the `factoryd` container under compose (`docker compose exec factoryd node dist/src/cli/factory.js doctor /srv/factory/repos/mon-app`, [`deployment.md`](deployment.md)), checks before entrusting a repository that the host can limit the sandbox, that the default branch is protected ([above](#branch-protection-required-by-factory-doctor)), that the App's installation holds neither *Administration*, nor *Workflows*, nor *Actions* above read, warning about any other permission above the manifest, and that no CI can expose secrets to the factory's branches. Each check has its verdict; one refusal refuses.

**The App's installation (ORC-439, ORC-441, ORC-443).** With *Administration*, read or write, the daemon could edit or delete the rulesets that keep it from merging alone: the repository's (`administration`) or the organization's (`organization_administration`). `doctor` reads `GET /repos/{owner}/{repo}/installation` with the App's JWT (an installation token cannot call it) and refuses the repository when its `permissions` hold either, at any level: what GitHub granted to that installation, not what the manifest asks. The refusal says how to remove it: in the App's settings, *Permissions & events* → *Repository permissions* (or *Organization permissions*) → *Administration*: *No access*, then check the installation (*Settings → Applications → Installed GitHub Apps → Configure*). A call that fails (network, authentication) does not refuse: the verdict is `unchecked`, with a warning under it giving the error and the manual check, and the result line points to it. An answer GitHub gives without permissions it can read refuses (ORC-273).

With *Workflows* (`workflows`), at any level, the daemon could push a workflow that exposes the repository's secrets after `doctor` read the workflows: `doctor` refuses it the same way, and says to set *Repository permissions* → *Workflows* to *No access* (ORC-441). *Actions* above read (`actions: write`) would let it re-run, cancel or dispatch workflows and delete runs and their logs. A dispatch on a factory branch runs that branch's code with the workflow's secrets, and `workflow_dispatch` is not among the triggers `doctor` counts as reaching a factory branch (the list below). `doctor` refuses it too, and says to set *Repository permissions* → *Actions* to *Read-only*, the manifest's level (ORC-443).

**Permissions above the manifest (ORC-443).** `doctor` compares the installation's `permissions` to the manifest's (`docs/github-app-manifest.json`, `GITHUB_APP_PERMISSIONS` in `src/cli/init.ts`). Every other permission the manifest leaves out (`secrets`, `environments`, `repository_hooks`…), or one held above the manifest's level (`statuses: write`), does not refuse: `doctor` prints one warning under the installation's verdict naming each with the level held and the one to set it to: the manifest's, or *No access* when the manifest does not list it (`warnings` of `installation` in `--json`); the result line points to it. Not warned about: a permission below the manifest's level, and the *Organization permission* *Members* at read, which the dashboard's sign-in needs when `dashboard` names an `org` or a `team` (above). *Administration*, *Workflows* and *Actions* above read are refused, never only warned about.

**The host (ORC-208).** The attempt containers are limited in processes, memory and CPUs through cgroups ([`tests.md`](tests.md), isolation 9). `doctor` asks the engine the sandboxes run on, `FACTORY_CONTAINER_CLI`, not the cgroups of its own process (in the `factoryd` container, a cgroup namespace of its own, and a uid that is not the engine's): `docker info --format '{{json .}}'` (`CgroupVersion`, `CgroupDriver`, the `CpuCfsQuota`, `MemoryLimit` and `PidsLimit` flags, `name=rootless` in `SecurityOptions`, and `ServerErrors`) or `podman info --format json` (`host.cgroupVersion`, `host.cgroupControllers`, `host.cgroupManager`, `host.security.rootless`). A rootless engine reports what systemd delegates to its user. `doctor` refuses without `FACTORY_CONTAINER_CLI`, on an engine without cgroup v2 (cgroups v1 or the hybrid layout), one that cannot limit through the controller of a limit set, `cpu` for `FACTORY_SANDBOX_CPUS`, `memory` for `FACTORY_SANDBOX_MEMORY`, `pids` for `FACTORY_SANDBOX_PIDS` (rootless: not delegated, `sudo loginctl enable-linger <user>`; a limit at `none` no longer requires its controller, ORC-451, and a malformed or too small one, under `6m` for `FACTORY_SANDBOX_MEMORY` (ORC-452), leaves all three required), and a rootless engine on a cgroup manager other than `systemd` (Docker's `CgroupDriver` `none` without a user session; Podman on `cgroupfs`, also behind the Docker-compatible socket compose's `docker` CLI talks to), which ignores the limits whatever its flags. Only the controllers follow `FACTORY_SANDBOX_*`: cgroup v2 and the `systemd` manager of a rootless engine stay required with every limit at `none`. An engine it cannot reach, or whose answer it cannot read, refuses with its error. These fields are checked against real engines, the `docker` CLI on a rootless Podman's socket included ([`tests.md`](tests.md), `doctor-host.test.ts`, ORC-427); should `doctor` refuse a Podman host through that socket for a controller `podman info` lists, set `FACTORY_CONTAINER_CLI=podman`.

**CI secrets.** The check lives in `doctor`, not only in the `fix-ci` skill: a factory PR must never trigger a job that reads the repository's secrets without a human having approved it.

Since ORC-283 the factory's branches follow the team's convention, `feat/<id>-<slug>` or `fix/<id>-<slug>` by default, or the repository's own `branches.pattern` ([repository configuration](repository-configuration.md#branch-names)). They no longer live in a space of their own: a branch filter can no longer tell them from a human's. So `doctor` accepts a job that sees a secret or a writable `GITHUB_TOKEN` on these branches only if a human approves each of its runs: the job runs under an environment with required reviewers. A condition on the actor (`if: github.actor != '<app-slug>[bot]'`) is not credited: a human can start a run on the agent's code (a push on top of its commits, re-opening or labelling its PR), and that run's actor is the human. A ticket whose PR was already open on `factory/<id>-<slug>` keeps that branch, so `doctor` still counts `factory/*` among the factory's branches.

The command resolves `owner/name` with `git remote get-url origin`, then reads with the GitHub App:

- `.github/workflows/*.yml` and `*.yaml` (Contents API, default branch);
- `GET /repos/{owner}/{repo}/environments` and their `protection_rules`.

It reads the repository's branch naming in `.factory/config.yml` on the default branch, as the local clone last fetched it (`origin/HEAD`, no `fetch`); an invalid file makes `doctor` refuse.

It requires the GitHub App (`github.*` or `GH_APP_*`). Exit code `0` if the repository is accepted, `1` if it is refused or if a read fails.

### Rule

Each workflow is read as YAML. A workflow **with secrets** (a `secrets.X`, `secrets['X']` or the whole `secrets` context in an expression, `${{ … }}` or an `if:`, or `secrets: inherit` on a reusable workflow call) or **with a writable `GITHUB_TOKEN`** is refused if it can run on a factory branch, unless every job that sees one is protected (see *Accepted* below). A shell text that names a secret outside an expression references none; `secrets.GITHUB_TOKEN` is the token, judged by its rights. The token's rights come from `permissions:`, the job's or else the workflow's: `read-all`, `{}` or scopes at `read`/`none` are read only; `write-all` or a scope at `write` can write. Without `permissions:`, the token has the repository's default rights, which the App cannot read (that read needs the *Administration* permission, which the App does not have): doctor counts it as writable, and says to declare `permissions:` (ORC-353). The triggers that reach a factory branch:

- `pull_request` and `pull_request_target`: always considered risky, because a PR from a factory branch can trigger them; a pull request's `branches` filter applies to the base branch, not the head branch;
- `push` without a filter: all branches;
- `push` whose `branches` filter can reach a factory branch (`feat/**`, `*/*`, `**`…) or whose `branches-ignore` does not fully exclude them. The filters are tried on branch names the factory makes (`branchName`, ORC-353, ORC-283): by the repository's naming, for every type it can give, and the legacy `factory/<id>-<slug>`. A pattern under the fixed beginning of one of them (`feat/`, `fix/`, `factory/` by default) always counts as reaching (it may name a team key no example has), and a negation excludes the factory's branches when it matches every one of them (`!feat/*-*`, `!fix/*-*` and `!factory/*-*` together do);
- `workflow_run` without a filter, or with a filter that reaches a factory branch (extra protection against the same family of risk).

Conversely, a `push` limited to branches the factory never names (`main`, `release/*`) or to tags only does not see secrets on a factory branch. With the default naming, a workflow that runs on `feat/**` or `fix/**` for the team's own branches reaches the factory's too.

Accepted:

1. a dedicated CI **without secrets**, its `GITHUB_TOKEN` read only, on these branches;
2. a workflow with secrets or a writable token where **every job that sees one** is attached to a GitHub environment whose `protection_rules` contain `required_reviewers` with at least one reviewer: human approval blocks the job before it reads the secret, whoever started the run;
3. a workflow with secrets that only runs on branches the factory never names (the default branch, `release/*`), or only on tags.

Nothing else protects a job (ORC-283). A job-level or step-level `if:` on `github.actor`, `github.triggering_actor` or the PR's author is not credited, nor is a `needs:` on a protected job: each job that sees a secret runs under its own protected environment. The job keeps its condition if the team wants it; `doctor` reads past it.

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
  verdict: refused — secrets and a writable GITHUB_TOKEN exposed on the factory's branches (pull_request can run the CI on the factory's branches) without human approval job(s) without an environment: test …
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

`factory doctor` then displays `secrets: yes`, `protected environment: yes` and `verdict: accepted`. The CI without secrets can still run on the factory's branches beside it, in another job or workflow, without approval.

`--json` produces the same verdict in an object `{ repoPath, accepted, host: { engine?, cgroupV2?, controllers?, rootless?, verdict, reasons }, branchProtection: { branch, classic, rules, pullRequestRulesets: [{ id, bypass }], verdict, reasons, warnings? }, installation: { permissions?, verdict (accepted, refused or unchecked), reasons, warnings? }, workflows: [{ path, triggers, secrets, githubToken, factoryBranches, environments, protected, verdict, reasons }] }`, without any secret value (`githubToken`: the jobs whose token can write, with their rights; `host`: what the engine reported, its fields absent when it could not be asked or read).

### Limitations

- Reading targets the **default branch** (Contents API without `ref`): the `pull_request` workflows are indeed the ones GitHub uses for a PR from a factory branch; a workflow that only exists on a pushed branch is not seen.
- The App cannot list the repository's secrets: `doctor` detects **references** to secrets, not their existence.
- Called reusable workflows are not downloaded: `secrets: inherit` is treated as a secret, and a reusable workflow called without `secrets:` receives no secret.
- This check does not replace branch protection: it only guarantees that CI does not read a secret on a factory branch without approval.
- Required permission: **Actions: read** (present in [`github-app-manifest.json`](github-app-manifest.json)); it is the permission GitHub associates with `GET /repos/{owner}/{repo}/environments`. An App created before ORC-135 must add it, otherwise this read returns 403 and `doctor` refuses the repository.

## CI

The factory does not impose a CI but makes use of it: `pr.checks_failed` triggers `fix-ci` (diagnosis, local reproduction, fix or question), bounded by `limits.ciFixAttempts` (ORC-184), and the factory's merge refuses a head whose checks are not green (ORC-148). A CI that runs at least lint, types and tests is therefore recommended, in addition to the `verify` commands the factory runs itself after each run ([`preset.md`](preset.md#jobs)).

The factory's repository itself has a GitHub Actions CI (`.github/workflows/ci.yml`): on every PR and every push to `main`, Node 24, `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:replay`, and the property, integration, chaos and isolation suites in jobs of their own ([`tests.md`](tests.md)).
