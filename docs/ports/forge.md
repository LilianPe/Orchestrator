# Forge port

The code forge, read-only: a branch's PR, the state of its checks, its unresolved review threads, the open PRs and the branches of the repository.

- Interface: `Forge` (`src/adapters/forge/types.ts`), name kept.
- Implementations: `GitHubAppForge` (`src/adapters/forge/github-app.ts`, through GitHub's REST and GraphQL API, as a GitHub App: the production forge), `FakeForge` (`src/adapters/forge/fake.ts`); without the App, `NoForge` (`src/adapters/forge/no-forge.ts`), whose every read rejects (ORC-181: the `gh` CLI forge is gone).
- Suite: `test/contracts/forge.contract.ts`, run by `src/adapters/forge/fake.test.ts` and `src/adapters/forge/github-app.test.ts` (on a scripted `fetch`, without network). No live test since the `gh` one went (ORC-181).

## Methods

| Method | What it guarantees | Replayed | Error |
|---|---|---|---|
| `findPr(repo, branch)` | `undefined` without a PR; otherwise the branch's PR (number, `https://` URL, state `OPEN`/`MERGED`/`CLOSED`), `checks` among `pending`/`pass`/`fail`/`none`, `failedChecks` non-empty exactly when `checks` is `fail`; a copy | read: same answer | rejects if the forge does not answer, including when it returns the PR but not its checks, and when it returns unreadable checks, even without an error (ORC-305: the GitHub reconciliation logs the error and retries at its next pass); an open PR with no checks at all gives `none`; a check in a state the forge does not know gives neither `pass` nor `none` (ORC-303), and is named in `unknownChecks`, absent when there is none, so that a refused merge names it (ORC-304) |
| `unresolvedReviewComments(repo, n)` | the unresolved review threads, as `FeedbackItem` with source `review` (author, body, date), bots' comments dropped and capped to the newest threads, the cut said by a last item (ORC-366); a copy | read | rejects if the forge does not answer, or returns unreadable threads (`GitHubAppForge`) |
| `ciFailures(repo, n)` (ORC-459) | the PR's red CI as its fix reads it: the failed checks of its head, the same ones `findPr` counts, each with its conclusion and, for the first `MAX_LOGS` (5), the end of its log as the forge returned it (raw: the caller formats it, `formatCiFailures`), or why there is none; the CI of its base branch at its tip, as `findPr` sums checks up. `GitHubAppForge`: an Actions job's log by its check run's id (the App's `actions: read`), 64 KiB of its end kept; another CI's check run, the report it attached; a commit status, its description; a log refused for good (a 4xx but a rate limit: expired, a permission) is said, not thrown | read | rejects if the forge does not answer, returns an unreadable PR (without its base) or check list, or refuses a log for a while (a 5xx, a rate limit) |
| `openPrs(repo)` (ORC-207) | every open PR, the most recently updated first (number, URL, title, head branch, `fork` when the head is in another repository), with its first 100 files and how many it changes (`filesTotal`; `files: null` when GitHub lists none): every page of PRs (`src/adapters/forge/active-work.ts`, GraphQL, for both forges); a copy | read | rejects if the forge does not answer, returns an unreadable page, or more than `MAX_GRAPHQL_PAGES` pages of PRs (ORC-347): never a list of PRs cut short, which would let a duplicate through |
| `branches(repo, prefix)` (ORC-207) | every branch whose name starts with `prefix` (the forge filters, the prefix is checked again), with its page on the forge | read | as `openPrs` |
| `recentBranches(repo)` (ORC-207) | the 100 most recently committed branches, the default branch left out: a selection, not the whole list | read | rejects if the forge does not answer or returns an unreadable answer |

## Idempotence

The `Forge` port only reads. The factory's writes are separate, in `ForgeWriter` (same file, ORC-162), each idempotent; they have no conformance suite. The [Publisher](publisher.md) (ORC-125) calls `ensurePr` and `gitAccess`, the move to *Human Review* calls `markPrReady`:

| Method | What it guarantees | Replayed |
|---|---|---|
| `ensurePr(repo, { branch, base, title, body, draft? })` | the branch's **open** PR, created if the branch has none, as a draft if requested; a closed or merged PR is not reused | returns the same PR, `deduplicated: true`; after a lost race (422), reads the open PR again |
| `markPrReady(repo, n)` (ORC-125) | the PR leaves draft; the GraphQL mutation is the only way, the REST API does not allow it | read first: a PR already out of draft writes nothing |
| `gitAccess(repo)` (ORC-125) | the repository URL and, **in the environment only**, the App token limited to that repository, for the factory's git; never given to a run | reads the token again (its cache) |
| `upsertCheckRun(repo, { sha, name, externalId, status, … })` | the sha's check run carrying `externalId`, created or updated | updates the same check run, `deduplicated: true` |
| `postReview(repo, n, { sha, body, comments, externalId })` (ORC-183) | one review on the PR, a comment (neither approval nor changes requested), its comments on lines of `sha`; `ReviewLinesRefused` when GitHub cannot place one (422) | the PR's reviews are listed first, in full (at most 1000): the one whose text carries the mark of `externalId` (an HTML comment) is returned, `deduplicated: true` |
| `mergePr(repo, n, sha, { unchecked? })` (ORC-148) | merges the PR only if its head is still `sha` (GitHub checks it in the same call); `unchecked` (the head has no checks): only in a repository without CI (head still without checks, no active Actions workflow in the repository, excluding GitHub's dynamic workflows, the PR's base commit without checks); a refusal for a reason to tell the human is an **answer**: `head_moved` (409), `not_mergeable` with GitHub's message (405), `checks_missing` (head without checks in a repository that has CI; a workflow list refused for lack of permission, 403 or 404, counts as CI); any other error is thrown, so that the effect is replayed, including a rate-limit 403 (`retry-after` header, `x-ratelimit-remaining: 0`, or a message that names it), which says nothing about the repository's CI | PR already merged on `sha`: `{ merged: true, deduplicated: true }`, no write |

`ArtifactHost` (same file, ORC-407), the visual proof's captures on the repository's orphan branch `ARTIFACTS_BRANCH` (`factory/artifacts`), which no other write names:

| Method | What it guarantees | Replayed |
|---|---|---|
| `hostArtifacts(repo, files)` | each file committed at its path (`<folder>/<name>`, no segment starting with a dot), the branch created as an orphan with a `README.md` if absent, its ref moved by a fast-forward only (`force: false`); returns each file's `blob/<commit>/<path>?raw=true` link, in order. A commit of another writer in between is read again, 3 times at most, then it throws to be retried; a refusal of the forge (403 but a rate limit, 404, 409, 422 but the race) is `ArtifactsRefused` | an unchanged tree writes no commit and no ref: the links name the tip |
| `pruneArtifacts(repo, expired)` | the tip's top-level folders `expired` says yes to, removed in one commit, by a fast-forward only; returns them | none expired, or no branch: nothing written |

Only `GitHubAppForge` and `FakeForge` implement it: GitHub only lets an app create a check run, not a user token. Details and limits: [Idempotence of external effects](../idempotency.md).

`GitHubAppForge` reads no response from GitHub without validating it: a 2xx response it cannot read makes the write reject, with the call and an excerpt of the response in the error (no excerpt for the installation token), never read as a verdict (ORC-273). So `ensurePr` rejects an unreadable PR list instead of creating a PR, and a PR created without its URL; `markPrReady`, a PR without its draft state, or in draft without its `node_id`, and a mutation that returns neither its result nor readable errors, instead of believing it out of draft; `upsertCheckRun`, an unreadable check run list, read in full (at most 1000, like `findPr`'s checks), instead of creating a second one for the same `externalId`; `postReview`, an unreadable review list instead of posting a second review; `repoPermission` (ORC-186), a response without permission instead of answering `none`. Only the responses the factory ignores (the merge `PUT`, a check run's `PATCH`) are not read.

## Fencing

Not applicable: no writes.

## What the suite asks of the implementation

`ForgeSubject`: a repository, a branch without a PR, and optionally a branch with its PR and the expected unresolved threads, the same implementation facing a forge that does not answer (`unreachable`), the branch of an open PR whose checks are unreadable (`unreadableChecks`), that of an open PR with no checks at all (`noChecks`), that of a PR the forge returns but whose checks it does not return (`checksDown`), and that of an open PR with a check in a state the forge does not know, the others green (`unknownBucket`), with the names of those checks (`unknownChecks`).

- `FakeForge`: `offline = true` makes its reads reject. It sets up a PR without checks for `noChecks`; it has neither unreadable checks, nor a failure between the PR and its checks, nor an unknown check state (it returns the ones it is given): these three cases are skipped for it.
- `GitHubAppForge` on a scripted `fetch`, without network: a `fetch` that throws for the unreachable forge (the installation token does not even arrive); for unreadable checks, a 200 `check-runs` response without its `check_runs` list: `findPr` rejects, with the call and the start of the response in the error, likewise for a response that is not JSON, an entry without `name` or `status`, a `status` response without its `statuses` list, and a PR list that is not a list, or one of whose entries lacks its number, its URL, its state or its head, or has a base without its branch or its sha (never read as "no PR"). Read as an empty list, such a response would give `none`, and would open the `unchecked` merge of a repository it would pass off as a repository without CI; so it rejects too. Both lists are read page by page, 100 per page: a failing check beyond the first page stays in the verdict. Beyond 1000 entries (10 full pages, then an eleventh that is not empty), it rejects, likewise for the workflows below: a server that ignores `page` would make it loop forever. For `mergePr` `unchecked`, the list of Actions workflows follows the same rule (all pages; a response without its list rejects, never read as "no workflow"), as does the PR it reads before merging; repository settings that are not an object also reject. For the PR without checks, two empty lists; for the failure, a 502 on `check-runs`; for `unknownBucket`, a `completed` check run with an unknown conclusion and a status with an unknown state next to a green check: each counts as `pending` and is named in `unknownChecks` (a completed run without a conclusion too).

## Known gaps

`GitHubAppForge` did not run this suite and read a check list missing from GitHub's response as an empty list, and only the first page of check runs: it runs it and rejects those responses since ORC-273.

`FakeForge` returned its internal objects: it returns copies since ORC-189, like `FakeTracker`.
