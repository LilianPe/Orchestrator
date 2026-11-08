---
name: code-review
description: Review a diff at a level proportionate to its risk (quick, standard, thorough), limited to what the diff changes or breaks, with classified and verified defects. Used by factory:review and as a self-review in factory:dev.
---

# factory:code-review

You review a diff as a demanding reviewer, not as its author. The result is a **list of verified defects**, classified, that the caller fixes. A review costs tokens: its level is chosen from the diff's risk, once, before starting.

## 1. Scope the diff

The base is the PR's target branch, as the `## Pull request` section of the prompt names it (or `factory-agent pr`); without that section, in a review, `factory-agent pr` (as `factory:review` step 0 says); in a self-review in `factory:dev`, the trunk (`git rev-parse --abbrev-ref origin/HEAD`, which prints `origin/<trunk>`). In a review, the factory keeps `origin/<base>` up to date in your worktree: never `gh` nor `git fetch`, a review has no network. In `factory:dev`, it is the `origin/<trunk>` the worktree holds: this skill fetches nothing. One command per call, no shell chaining:

```bash
git log --oneline origin/<base>..HEAD
git diff --stat origin/<base>...HEAD
git diff origin/<base>...HEAD
```

For a targeted round (reviewing only fix commits): `git show <sha>` for each commit, plus their consumers (see 4).

Also read the repository's rules that apply to the touched files: `CLAUDE.md` (root and relevant folders), `docs/agent/`, and the ticket (what the diff must do).

## 2. Choose the level

Take the highest level that matches any part of the diff; when in doubt between two, the higher one.

| The diff touches… | Level |
|---|---|
| Text, labels, typos, trivial configuration, documentation that claims nothing about the code | **quick** |
| Application logic, state, routes, services, queries; documentation that describes the code's behavior; tests | **standard** |
| Authentication, permissions, isolation between customers, secrets, schema migrations, data deletion, concurrency, money; or a large diff (more than ~800 lines or ~20 code files) | **thorough** |

Documentation that describes the code is not a "quick" diff: its truth is in the code, outside the diff. List every claim it makes and check it in the code.

- **Quick**: one careful reading of the diff, hunk by hunk. No exploration beyond it.
- **Standard**: the reading, plus the passes of section 3, plus the consumers of the changed symbols (`grep -rn "<symbol>"`).
- **Thorough**: all of standard, in separate passes per angle (section 3), with the explicit list of critical surfaces to test (access controls, per-customer filtering, reversibility of a migration, what happens on a failure halfway through). If the subagent tool is available, run one pass per angle in parallel (instructions for each: the exact diff, the angle, "only report defects in these lines or in what they break", read-only, no subagent); otherwise do the passes yourself, one after the other. Keep it for diffs that warrant it: it is the most expensive level.

## 3. The angles

1. **Correctness**: does the code do what the ticket asks? Edge cases (empty, null, zero, a single one, very large), errors (what happens when the call fails?), inverted conditions, shared state.
2. **What the diff breaks elsewhere**: a deleted or renamed symbol → search for the old name across the whole repository, comments and docs included; a widened exported type or signature → its implementations and callers; an effect moved into a shared function → does each of its callers satisfy the new condition? A condition removed while the data it guarded remains; a new counter added to a total from which a "remainder" is deduced.
3. **The tests**: do they cover the behavior, or the mock? An assertion that cannot fail (mock set too late, a value the test bench would produce anyway, `not.toThrow` never seen red) guards nothing. A deleted test whose name describes a fallback case: is the case still covered?
4. **The repository's rules**: conventions written in `CLAUDE.md` and its neighbors, a pattern established elsewhere in the code. Cite the rule.
5. **Security and data** (thorough, or as soon as a sensitive surface is touched): unvalidated input, unfiltered access, a secret in the code or the logs, an irreversible or destructive migration, a non-atomic operation.
6. **Comments and messages**: a comment or doc that contradicts the code (or a fix in the same diff) is a defect, not a detail: the next reader will "fix" it the wrong way. A claim in a commit message ("already handled elsewhere", "same pattern as X") is checked by opening X.

Read **every hunk** of a touched file, even when the commit message says the file "only moves code".

## 4. Classify each finding

First the **scope**, by causality, not by file:

- **in scope**: a consequence of this diff, including in a file the diff does not modify (a broken caller);
- **out of scope**: a defect that existed before and that the diff does not change. It is never fixed here: list it separately;
- **rule conflict**: caused by the diff, but the proposed fix breaks a written rule of the repository. Do not apply it; report it with the rule.

Then the **severity**:

- **blocking**: bug, data loss or corruption, vulnerability, regression, broken contract, critical path without a test, a test that cannot fail;
- **important**: a real defect but rare or caught elsewhere, duplication that will diverge, a comment or doc that says the opposite of the code;
- **minor**: readability, naming, style not covered by the lint, with no effect on behavior.

Ignore what the lint, the compiler or the CI already catch, and preferences without a written rule.

## 5. Verify before reporting

A finding is a claim: verify it before keeping it.

- Read the cited function **in full**, not the lines of a `grep`: the guard is often between two matches.
- "X can happen": trace whether a real caller reaches that state. Unreachable: discard it, with the trace.
- A finding that depends on a library version: search the repository for an existing use of the same form before declaring it wrong.
- Keep only what you are sure of after verification. A real and important doubt: keep it, saying what would settle it.

## 6. Return the result

One line per finding, from most to least severe:

```
[blocking|important|minor] path/file.ts:42 — what is wrong, in which scenario, why it matters → suggested fix
```

Then, if any: "Out of scope" (one line each), "Rule conflicts" (with the rule). No findings: write "no defect found" and what you checked (level, angles, files).

The reviewer changes nothing during the review: the fixes come afterwards, from the caller (`factory:receiving-review`).
