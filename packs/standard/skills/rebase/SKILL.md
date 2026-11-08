---
name: rebase
description: Rebase the ticket's branch on the default branch after a conflict, or stop on a conflict a human must decide (launched by the factory).
---

# factory:rebase

The factory starts you because the ticket's PR conflicts with its base branch. You resume the ticket's session, in its worktree and on its branch, which the factory has already published. One job: rebase the branch on the base and resolve the ordinary conflicts. Nothing else: no feature, no fix, no refactoring, no feedback.

## 1. Look

1. `git status`: nothing must be in progress. A rebase or a merge left by an earlier attempt: `git rebase --abort` (or `git merge --abort`), then start over.
2. The base: `gh pr view <branch> --json baseRefName --jq .baseRefName`. Then `git fetch origin`.
3. `git merge-tree --write-tree --name-only origin/<base> HEAD`. Exit code 0: no conflict any more (a human resolved it, or the base moved again): rebase all the same, it costs nothing and the factory expects a branch on the base. Exit code 1: the output lists the conflicting files.
4. `git log --oneline origin/<base>..HEAD` (the ticket's commits) and `git log --oneline HEAD..origin/<base>` (what arrived on the base).

## 2. Rebase

`git rebase origin/<base>`. At each stop, for each conflicting file:

- read both sides of every hunk (Read), and what the base's commit meant (`git log --oneline -3 origin/<base> -- <file>`, then `git show <sha>`);
- resolve with Edit, keeping the intent of both sides. Never rewrite the file with a script, never take one side whole (`git checkout --ours` / `--theirs`) unless the other side's change is truly superseded, and say so in your summary;
- `git add <file>`, then `git commit --no-edit`, then `git rebase --continue`.

## 3. Verify

`factory:verification`: the tests of the files the resolution touched and of their consumers, then the repository's type check and lint if they exist. A failure the resolution caused: fix the resolution, in a commit of its own (`<ID>: resolve the conflict with <base>`). A failure the base brought by itself is not yours: leave it, and say so in `risks`. The factory then runs the project's checks on your branch in a fresh clone: nothing goes out until they are green.

## 4. Stop: three cases only

Stop in exactly three cases. First `git rebase --abort`: the branch goes back to what the factory published. Then end with `submit_result`, `status: "blocked"`, `reason: "conflict"`, and `conflict`:

- `logic`: the two sides contradict each other. The base changed a behavior the ticket's code relies on, and no code can keep both.
- `migrations`: two migrations change the same schema (same tables or columns, or the same sequence number): their order is a human's decision.
- `scope`: resolving needs changes beyond the ticket's scope (a feature the base reworked, a public API, another team's module).

`question`: the files, what each side wants, and the options, as one closed question a human can answer in a line. The factory blocks the ticket with its standard comment; the human's reply starts this step again, with the answer.

Any other conflict is ordinary: resolve it.

## Forbidden

Never push, never open or edit a PR: the factory verifies your rebased branch, then publishes it in place of the head it published itself. Never merge: no `git merge`, the branch stays a straight line on the base. No change unrelated to the conflicts. Do not disable or weaken any test or CI step. Do not switch branches.

## End of turn: `submit_result`

**Always** end with the `mcp__factory__submit_result` tool: without a valid result, the step counts as failed. `summary`: rebased on `<base>` at `<short sha>`, each conflict resolved (`file`: how, one line each), and what you verified (commands and result). This step posts nothing in Linear.
