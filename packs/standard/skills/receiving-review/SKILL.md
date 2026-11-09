---
name: receiving-review
description: Handle feedback (human or AI review, PR comments, failing checks or CI) rigorously: understand, verify in the code, fix what is right, refuse with a reason what is not. Used by factory:feedback and factory:fix-ci.
---

# factory:receiving-review

A piece of feedback is a claim about the code, and the fix it proposes is another one. Both are verified before writing a line. No flattery ("great point!"), no blind application, no defensiveness on principle.

## 1. Read everything, then understand

- Read **all** the feedback before fixing any of it: several items can describe the same mechanism, or contradict each other.
- Restate each one as a technical requirement ("the date must be validated server-side"). Anchored feedback (`path:line — text`): open that file at that line.
- **Ambiguous feedback, or feedback contrary to the ticket or to another human's feedback**: fix nothing that depends on it. Ask ONE precise question with `factory-agent ask "<question>"` (what you understood, the two possible readings), handle the independent feedback, then end your turn.

## 2. Verify in the code

For each piece of feedback:

- **The premise**: read the cited function in full (not a `grep`); for "X can happen", trace whether a real path leads there. Feedback based on a wrong reading is refused, with what the code shows.
- **The proposed fix**, as severely as the defect: a suggested rewrite is unverified code. Known pitfalls:
  - "these two forms are equivalent": at runtime perhaps, but a lint or typing rule can be the reason for the current form;
  - "compute it only once": compare the copies operand by operand; if they differ, merging them changes the behavior;
  - "delete this test": name the regression it is the only guard against before touching it;
  - "do it properly" (export, metrics, options): check that someone uses it (`grep`); otherwise it is beyond the need;
  - **a trade-off** (fail open or closed, retry or give up, a limit, a timeout, a threshold): it is not a defect but a decision. Apply neither side alone; describe both failure scenarios and let it be decided (a question, or "left for a human").
- **The repository's rules** for what you are going to touch (`CLAUDE.md` on tests, comments, migrations). A fix that breaks them is not applied: say which one.
- **An existing test that pins the opposite behavior** is a contract the reviewer did not see: never invert its assertion to satisfy feedback; report the conflict.

Source of the feedback:

- **Human** (Linear thread, PR comment from a reviewer): it is the product decision. Apply it after understanding it; if it contradicts the ticket or an earlier choice, ask instead of deciding.
- **AI or tool** (automated review, a `factory:code-review` finding): skeptical. Unverified feedback is not applied.
- **Failing check or CI**: it is not an opinion, it is a symptom; go through `factory:debugging`.

## 3. Fix

- Order: what breaks (bug, vulnerability) first, then the simple fixes, then the heavier ones.
- **One commit per cause.** Several items on the same mechanism are a single defect seen from several angles: one fix at the cause, one commit that names them all. Independent items each keep their own commit.
- **Fix the rule, not the example**: feedback that cites one case of a class of bugs is fixed by what covers the whole class.
- **Duplication is removed**, not commented ("see above").
- **Every behavior fix has its proof** (`factory:tdd`): a test red on the old code then green. For hardening with no visible change, show that the test turns red when you deliberately break the guard (with Edit), then restore it.
- Run the tests of what the fix changes (`factory:verification`), not the full suite.
- Never `git commit --amend` nor a history rewrite: the branch is already published, and the factory refuses a rewritten history. To undo a fix: `git revert --no-edit <sha>`.

## 4. Answer

No thanks and no lip-service agreement: the action shows the feedback was heard. For each piece of feedback, one line:

- fixed: `<summarized feedback> → <what changed> (<short sha>)`;
- refused: `<summarized feedback> → not applied: <technical reason, with what the code or the test shows>`;
- pending: `<summarized feedback> → question asked: <question>` or `→ to be decided by a human: <the two options>`.

You were wrong to refuse: say so in one sentence ("verified: you were right, X does Y") and fix it.

## Done when

Each piece of feedback has a reply line; each fix has its commit and its proof; nothing was applied without being verified nor refused without a reason.
