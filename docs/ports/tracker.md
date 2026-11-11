# Tracker port

Ticket tracking: read a ticket, move it, label it, comment, and talk in its agent session.

- Interface: `Tracker` (`src/adapters/tracker/types.ts`), name kept.
- Implementations: `LinearTracker` (`src/adapters/tracker/linear/tracker.ts`), `FakeTracker` (`src/adapters/tracker/fake.ts`).
- Suite: `test/contracts/tracker.contract.ts`, run by `src/adapters/tracker/fake.test.ts` and `src/adapters/tracker/linear/tracker.live.test.ts`.

## Methods

| Method | What it guarantees | Replayed | Error |
|---|---|---|---|
| `getIssue(id)` | the ticket, `teamKey` = prefix of the identifier; a copy the caller may modify; `blockedBy`: the tickets it is « blocked by », each with its status name and type, all of them (ORC-363; on Linear, the `blocks` relations where it is the related issue, every page) | read | rejects on an unknown ticket with `IssueNotFoundError`, distinct from a read error |
| `history(id)` | the ticket with its comments, and the tickets related to it (each relation, both ways, « blocked by » included) with theirs, each dated (ORC-376): what the replay of a closed ticket keeps of before its start; on Linear, first pages only: 100 comments of the ticket, 25 relations each way, 25 comments of each related ticket | read | rejects on an unknown ticket with `IssueNotFoundError` |
| `listDelegated(teamKey)` | the team's tickets delegated to the app, and only those, each read as `getIssue` reads it | read | — |
| `search(term)` | the tickets the term finds, including those that have it in their title, with URL and status | read | — |
| `moveTo(id, status)` | the ticket is in that status | no further effect | rejects on an unknown ticket; on a status the team does not have, rejects and leaves the status |
| `setLabels(id, add, remove)` | the final state: `add` applied (created if missing), `remove` removed; removing an absent label is ignored; a label from an exclusive group (Linear label group, `FakeTracker.setLabelGroup`) removes the other labels of its group, two labels from the same group in `add` are refused; nothing is written if the ticket already has it | writes nothing | rejects on an unknown ticket |
| `comment(id, body, effectId?)` | a comment on the ticket; with `effectId`, it carries `<!-- factory:effect=<id> -->` (and, on Linear, a client id derived from the effect) | **writes a second comment**: the caller first looks with `findComment` | rejects on an unknown ticket |
| `findComment(id, effectId)` | the id of the ticket's comment written for that effect, `undefined` otherwise | read | rejects on an unknown ticket |
| `react(commentId, emoji, effectId?)` | the emoji on that comment (ORC-380); with `effectId`, on Linear, under a client id derived from the effect | **puts a second reaction**: the caller first looks with `findReaction` | rejects when the tracker refuses the reaction on that comment |
| `findReaction(commentId, effectId)` | the id of the comment's reaction put for that effect, `undefined` otherwise | read | unspecified |
| `ensureSession(id)` | an agent session identifier on the ticket | may open another session | rejects on an unknown ticket |
| `activity(session, a, effectId?)` | an activity in the session (`thought`, `response`, `elicitation`, `error`, `action`, ephemeral or not); with `effectId`, under an id derived from the effect | writes a second activity: the caller first looks with `findActivity` | unspecified (the fake accepts an unknown session) |
| `findActivity(session, effectId)` | the id of the session's activity written for that effect, `undefined` otherwise | read | unspecified |
| `addExternalUrl(session, label, url)` | a link on the session; nothing if the session already has that URL | writes nothing | unspecified |
| `setSessionPlan(session, plan)` | the session's plan is `plan`, in full (ORC-171) | rewrites the same state | unspecified; the factory logs the error and continues |

## Idempotence

The writes that can be replayed without harm are those that write a final state: `moveTo`, `setLabels`, `addExternalUrl` and `setSessionPlan`. `comment`, `activity` and `react` for an outbox effect are keyed by the effect id (ORC-162, ORC-380): the engine looks with `findComment` / `findActivity` / `findReaction` before writing, and a replay writes nothing. Without `effectId` (resume notices, replies outside the outbox, relaying a run's stream), or for `ensureSession`, a replay writes a duplicate. The details, and what the Linear API allows, are in [Idempotence of external effects](../idempotency.md); these cases are tested by `test/scenarios/idempotency.test.ts` and `linear/tracker.test.ts`, not yet by the conformance suite (ORC-189).

## Fencing

None at the port level: it has no notion of an attempt. Echoes of our own writes (labels, statuses) are filtered by the engine (`putEcho`/`isEcho`), not by the adapter.

## What the suite asks of the implementation

`TrackerSubject`: an existing ticket, a missing identifier from the same team, and optionally a search term, two statuses of the team, a team with one delegated ticket and one not delegated, and `written`, which reads back what `comment`, `ensureSession`, `activity` and `addExternalUrl` wrote (the port cannot read it back; `FakeTracker` provides it through `written()`). The write cases only run if the subject provides the two statuses: never against a shared workspace.

## Known gaps

None. `FakeTracker` accepted any status name: since ORC-189, it has a catalog per team and refuses, in `moveTo` as in `addIssue`, a status that is not in it.

- By default, each team has the statuses of the standard workflow (`STANDARD_STATES`, `packs/standard/workflow.yml`; a test checks that they do not diverge). The scenario harness passes those of the workflow config it loads.
- The catalog only carries the statuses the workflow names; a real Linear team has others (Backlog, Canceled…). A scenario that needs a status outside the catalog declares it: `h.tracker.setStates('REL', [...h.tracker.statesOf('REL'), 'Backlog'])` (keeps the statuses of the loaded workflow), or `new FakeTracker([...])` for all teams.

The live `LinearTracker` runs read-only (without statuses): `getIssue`, `history`, `search` and `listDelegated`, with the token's user as the app; variables in [the index](README.md#live-tests). Its writes, and therefore their effects, go through no suite.
