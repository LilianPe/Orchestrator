---
name: feedback
description: Apply review feedback (Linear, GitHub, checks or CI) to the ticket's PR and answer point by point (launched by the factory).
---

# factory:feedback

You resume the ticket's dev session, in its worktree and on its branch, already published by the factory. The "Feedback to address", "Blocking findings to address", "Failed checks" or "CI failures" block lists what must be handled. You are alone during your turn; your only channel to a human is `factory-agent ask "<question>"`, then end of turn.

## 1. Gather

- **Feedback to address**: messages from the Linear thread and unresolved GitHub review comments, with their author. The block says "no written feedback": reread the ticket's Linear thread and the PR (`gh pr view <branch> --comments`) to find what is asked.
- **Blocking findings to address**: the blocking findings of the factory's AI review, each under its id (`correctness-1`, `security-2`), then the PR's unresolved review threads as they are. Handle every finding (section 2); the threads are context, not orders.
- **Failed checks**: the project's `verify` commands, their exit code and the end of their output. It is a symptom: `factory:debugging`.
- **CI failures**: apply `factory:fix-ci` (read the exact failure, reproduce locally, classify the cause; never disable or weaken a test or a CI step).
- Check where the branch stands: `git status` (nothing unexpected in progress), `git log --oneline -10`.

## 2. Handle with `factory:receiving-review`

Read all the feedback, then apply `factory:receiving-review`: understand each item, verify its premise and its fix in the code, fix what is right with its proof (`factory:tdd`), refuse with a reason what is not.

- Ambiguous human feedback, or feedback contrary to the ticket: ONE question with `factory-agent ask`, after having handled the independent feedback.
- Feedback that asks for something other than the ticket (a new feature): answer that it deserves its own ticket, unless the human explicitly asks for it in this ticket.
- One commit per cause, message `<ID>: <what is fixed>`. Never `--amend` nor a rewrite: the branch is published, and the factory refuses a rewritten history.
- **AI review findings**: one commit per finding fixed, never two findings in one commit, its message naming the finding (`<ID>: security-1, <what is fixed>`). A finding whose premise does not hold is contested, not fixed: say why, with the proof from the code. A contested finding stays open: the next review reads your justification and judges it again.

## 3. Verify and hand back

1. `factory:verification`: the tests of what you changed, the repository's type check and lint if they exist; for failed checks, rerun exactly the command that failed.
2. A conflict with the PR's base is not yours: do not merge or rebase the base, even when the PR shows it conflicting. Hand back as usual; the factory starts its own `factory:rebase` step on the conflict, after your run.
3. A human may have pushed to the branch (the factory paused you for it, then a human resumed you): `git fetch origin`, and if `origin/<branch>` has commits you do not have, `git rebase origin/<branch>`. Your commits not yet published go on top of theirs; the published ones are already under them. Resolve each conflicting hunk you have read with Edit, keeping the intent of both sides, then `git add` and continue the rebase; when the two sides contradict, two migrations change the same tables, or the resolution goes beyond the scope, `git rebase --abort` and a question. Without it, the factory refuses your commit (`factory/commits-humains`) and never publishes over theirs.
4. Commit, then end your turn: **the factory publishes**, after verifying your last commit. You do not push.

## Forbidden

Never merge the PR. Never push, to any branch: the factory publishes. Do not rewrite history, do not rebase a published branch. Do not switch branches. Do not disable or weaken any test or CI step.

## `submit_result` summary (published in Linear)

End your turn with `mcp__factory__submit_result`: its `summary` is this message, which the factory publishes. Nothing else you write is.

In English, one bullet per feedback item: `- <summarized feedback> → <what was done> (<short sha>)`, or `→ not applied: <reason>`. Then a **Verified** line (commands and result). End with the feedback not handled and why, if any.

If you ask a question with `factory-agent ask`, this summary is not published: the question must also say what has already been handled.

For **AI review findings**, `submit_result` also says what you did with each id of the block, every id once: in `fixed`, `{ finding, commit }` with the sha of its own commit; or in `contested`, `{ finding, justification }`. The factory refuses two findings on one commit.
