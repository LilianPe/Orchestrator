# Linear

Relais acts in Linear as an **agent**: an OAuth application installed with `actor=app`, to which tickets are delegated and which is mentioned with `@relais`. This page describes creating the application, connecting, webhooks and day-to-day use.

## 1. Create the OAuth application

`relais init` displays these instructions with the exact URLs of your instance. In Linear (workspace admin account): **Settings → API → OAuth applications → New application**.

| Field | Value |
|---|---|
| Name | `relais`: this is the name that will be mentioned with `@`. |
| Callback URL | `http://localhost:4100/oauth/callback`, or `<publicUrl>/oauth/callback` if `publicUrl` is set. The port follows `port` in `config.yaml`. |
| Webhooks | Checked. URL: the smee channel created by `relais init` (`https://smee.io/…`), or `<publicUrl>/webhooks/linear`. |
| Webhook categories | **Agent session events**, **Issues**, **Comments**. |

Create the application, then copy into `relais init`:

- the **Client ID**;
- the **Client secret**;
- the **Webhook signing secret**.

They are saved in `<RELAIS_HOME>/secrets.json` (mode `0600`, see [`configuration.md`](configuration.md#secretsjson)).

Linear may refuse a callback URL on `http://localhost`: in that case, temporarily expose Relais through a tunnel (`cloudflared tunnel --url http://localhost:4100`), put the tunnel URL in `publicUrl` in `config.yaml`, update the application's Callback URL and restart `relais up` for the duration of the connection. This point is to be checked during the acceptance run ([`acceptance.md`](acceptance.md)).

## 2. Connect Linear (install the agent)

1. `relais up`.
2. Open the UI (`http://localhost:4100`) and click **Connect Linear** (or open `/oauth/start`).
3. Linear asks you to authorize the application for the workspace, with the scopes `read`, `write`, `app:assignable`, `app:mentionable` and `actor=app` (the application acts in its own name, not yours).
4. Back on `/oauth/callback`: « Linear is connected. You can close this tab. »

On connection, Relais:

- saves the tokens, the agent's id (`appUserId`) and the organization's;
- **creates the missing statuses in each configured team** (see § 5) and the `agent:stop` and `Bloqué` labels;
- runs a reconciliation right away; after that, it runs every 5 minutes (ORC-185).

The token is refreshed automatically. On later startups, Relais reconnects on its own with the tokens in `secrets.json`. `relais status` and the UI show whether Linear is connected.

## 3. Webhooks: smee or public URL

Linear must be able to reach Relais. Two modes, set in `config.yaml`:

- **smee relay (default on a workstation)**: `relay: { kind: smee, url: https://smee.io/… }`. Linear sends the webhooks to the public smee.io channel; `relais up` subscribes to it (SSE stream) and replays them locally. Nothing to open on the machine. The channel is created by `relais init`.
- **Public URL (server, tunnel)**: `publicUrl: https://relais.exemple.fr` and `relay: { kind: none }`. Linear calls `POST <publicUrl>/webhooks/linear` directly.

Every webhook is verified, whatever the mode:

- **HMAC-SHA256 signature** of the raw body with the *webhook signing secret*, compared with the `linear-signature` header (constant-time comparison); otherwise refused (401);
- **secret required**: if the *webhook signing secret* is empty (or only whitespace) or missing from `secrets.json`, **all** webhooks are refused (401), even those whose signature is computed with that empty secret (anyone could compute it). `relais init` asks for the secret again as long as the answer is empty, and `relais up` displays a warning at startup if it is missing;
- **freshness**: `webhookTimestamp` within 60 s of the local clock; otherwise refused (401). Keep the machine's clock synchronized (NTP).
- **inbox written before the response** (ORC-147): the events drawn from the webhook are written to the store's inbox (Postgres, or SQLite without `FACTORY_DATABASE_URL`) before Relais responds; the acknowledgement goes out afterwards, as an effect of the event's decision (below). A 200 means "written": if the daemon goes down right after, even abruptly, nothing is lost, the event is processed at the next startup. If the write fails (database unreachable), the response is 500 and Linear resends the webhook. With the small model on (ORC-336), a webhook that may carry a message (a mention, a reply, a comment), and any webhook of the same issue behind one, is answered once it is kept in the store instead: it is classified and written to the inbox after the answer, and a restart writes what was kept and not written. Linear fails a delivery not answered within 5 s ([webhooks](https://linear.app/developers/webhooks)): the answer never waits on the model.
- **deduplication**: a webhook already received creates neither a new event nor a new run. The key comes from the signed body, never from the `linear-delivery` header (unsigned): activity id for a reply or a stop, session id for a delegation or a mention, ticket id and `updatedAt` for a ticket change, otherwise the SHA-256 fingerprint of the body without its `webhookTimestamp`. A replay of the same body, or a resend by Linear with a new `webhookTimestamp`, is therefore ignored: the event id is already in the inbox, the replay is neither reprocessed nor acknowledged again. Deduplication lives in the database: it survives a restart.
- **typed events, signed actor and taint** (ORC-160): a webhook becomes typed events (`ticket.delegated`, `session.mentioned`, `command`, `session.prompted`, `session.stopped`, `status.changed`, `label.changed`), never free text; a label added **or removed** by hand comes in as `label.changed` (`change: added` / `removed`; workflow rules only see additions). Each event carries `schemaVersion`, the Linear id of its **actor** as the signed body gives it (`actor`: the author of the reply, the comment or the delegation, or the `actor` of a ticket change), and a **taint** label. The event is `trusted`, with the user's id, when Linear names a workspace user as the author; `untrusted`, without `actor`, otherwise: no user id, change made by an integration or an OAuth app (`actor.type` other than `user`), comment that came through a bot or from outside the workspace (`botActor`, `externalUser`: Slack, email, customer requests). The delegation, status change and label that reconciliation finds without a webhook have no signed actor: they are `untrusted` too. The author's name (`author`) comes from the same object as their id. An `untrusted` event does not launch a `knowledge` job and its runs carry the sensitive paths ([workflow](workflow.md)). Authorizations (who can do what) are checked against this `actor`, never against a name quoted in the text: see [Authorizations](#authorizations-who-can-do-what) (ORC-186). Labels and statuses set by Relais itself are ignored echoes, additions as well as removals; only the removal of a label that a Relais addition takes off within the same exclusive group comes back as a removed `label.changed`, which triggers nothing. In a Linear label group, adding a label removes the others in the group; a rule that asks for two from the same group fails.
- **acknowledgement** (ORC-171): the comment « Got it. », then the plan: see [Triggering](#triggering). A refusal by the matrix only receives the refusal.
- **ticket not found** (ORC-302): a delegation, a mention, a command or a reply on a ticket the factory does not track yet rereads that ticket in Linear to keep its snapshot. If Linear can no longer find it (deleted in the meantime, in the trash or already purged; Linear responds the same way for a ticket the app can no longer see, access to its team removed), the event is journaled then ignored, with no retry: no run, and nothing is written in the session. If the ticket becomes visible again, it has to be delegated again or the mention repeated. A read error (network, Linear unavailable) makes it retry, like any processing error.

A smee channel is public: anyone who knows the URL can read the events on it (ticket contents) and write to it. The signature prevents injecting fake events, not reading. For long-term use or sensitive data, prefer a public URL.

**Limit of the smee relay: it does not forward the original bytes.** smee.io decodes the JSON received from Linear and only relays the decoded object; Relais re-encodes it (`JSON.stringify`) before verifying the signature. The result is identical to the signed bytes as long as Linear sends compact JSON produced by `JSON.stringify`, which is the case today (validated during the 11/10 acceptance run): accents, emojis, `\n`, quotes and ordinary numbers go through. It differs, and the webhook is refused with 401, if the body contains spaces or indentation, optional escapes (`\/`, `\u00e9`), numbers written differently from how `JSON.stringify` would write them (for example `1.0`, `1e3`, `-0`, `0.30000000000000001` instead of `0.3`, `9007199254740993`, `1000000000000000000000` instead of `1e+21`), duplicate keys or numeric keys out of `JSON.stringify` order. In that case, the log shows `relay: webhook rejected with 401 (…)` with the three possible causes (wrong secret, clock offset, non-reproducible body); if the secret and the clock are correct, switch to `publicUrl`.

**Reconciliation** rereads every 5 minutes the delegated tickets of each team (all of them, page after page, excluding completed or canceled statuses; ORC-347), then, one by one, those the factory still tracks that drop out of that list. It catches up on:

- a **delegation**;
- a **delegation removal**: the run in progress is stopped by the workflow's `session.stopped` rule, present in the standard pack. A ticket deleted in Linear (in the trash, where Linear keeps it 30 days, or already purged) is handled the same way: run stopped, delegation removed;
- a **status change** between statuses declared in `workflow.states`, including the **move to done** (to `done`); a run still in progress on a done ticket is stopped (`session.stopped`), and the delegation is only removed if Linear no longer shows it. A completed status that `workflow.states` does not call `done` is not a move to done: the ticket goes to the logical state that name designates, if it designates one, and its delegation is removed, even if Linear still shows it;
- the **move to canceled** of a delegated ticket, as the webhook would report it (`status.changed` with `cancelled`, ORC-170: work stops), followed by the removal of the delegation; on a ticket that is no longer delegated, only its run is stopped. A cancellation already received by webhook may come back once through reconciliation: its only effect, stopping work already stopped, is invisible;
- the **end of a wait on « blocked by » tickets** (ORC-363): a waiting ticket none of whose blockers is still open (done, or the relation taken off) gets `blockers.done`, `trusted` since it carries nothing a human wrote and the start it resumes keeps its own restrictions ([preset](preset.md#waiting-on-a-blocked-by-ticket-orc-363));
- **labels added or removed**. The factory keeps, per ticket, the labels it last read: reconciliation records the full list, a webhook only applies to it the labels it changes itself (including its own writes), never the whole list, which may contain a label whose webhook was lost. A change is only reported if it differs from that record, whichever source sees it first, and the webhook and reconciliation take turns on that record: a `label.changed` rule is not launched twice for the same change. The first pass on a ticket only records its labels; a label put back later is a new change. Each record is dated by the ticket's last modification in Linear: an older record (webhook arriving out of order, a pass that read Linear before a webhook) never replaces a newer one; a webhook arriving after a newer one still adds the change it reported, so that reconciliation does not report it a second time. A label written by the factory whose webhook is lost, and which is only reread after its echo has expired (60 s), is taken for a human change.

What it finds has no signed actor (`untrusted`): a rule that launches a run is refused by the matrix (see [Authorizations](#authorizations-who-can-do-what)), and a **caught-up move to done never merges**: only a signed human decides the merge. A ticket that Linear does not return because of a read error (network, Linear unavailable) is left as is until the next pass. Everything else only arrives by webhook and is lost if the webhook is missed or refused: replies in the session, `@relais` mentions and commands, stop requested in the session, and the changes on a ticket the factory does not track or that is no longer delegated.

In a team with several repositories, the list is read only once per pass and each catch-up (status, cancellation, labels and their record) goes only to the project that has the ticket ([routing](projects-and-workspaces.md#one-team-several-repositories)). Another project that keeps a trace of it, because the ticket waited there for its repository, only sees its run stopped and its delegation removed.

Its cadence is a **timer in the database** (ORC-185): each project's pseudo-ticket `_reconcile.<projet>` carries its `reconcile` timer, set at daemon startup if missing, in 5 minutes (connecting to Linear already runs a pass; a restart does not arm a second one), and re-armed on every pass. A failed pass is journaled without breaking the chain; the timer of a project removed from the configuration is deleted at startup. Each pass also rereads the PRs (see [GitHub](github.md)); what it catches up on enters the inbox like any event, with a deterministic id, so an event already received by webhook is not processed twice.

## 4. Using the agent day to day

| In Linear | Effect (standard pack) |
|---|---|
| **Delegate** a ticket to `relais` (the ticket's "delegate" field) | Agent session opened, comment « Got it. » and plan in the session in under 10 s, pickup checks, then `dev` run: status *In Progress*, PR opened, status *Human Review*, summary in the session. |
| Reply in the agent's session | The message is classified on arrival (a small model, bounded at a few seconds), enters `humanInbox`, and a sign of life written without a model goes out right after (see [Human messages](#human-messages-during-a-run)). An instruction is handed to the agent at its next step boundary, without interrupting it; a question also launches a read-only answer (`ask`). On a blocked ticket, a reply relaunches right away. |
| `/status`, `/stop` as a reply in a session | The ticket's state read from the projection, without a model; the stop, like the stop button. |
| `/approve`, `/changes <comment>`, `/reject` as a reply in the ticket's session | The spec gate, when the repository runs `spec_draft` (ORC-212, [preset](preset.md#spec_draft-spec_check-and-the-spec_review-gate-orc-212)): approves the published version, asks for a new one, or rejects it. Validators only, never the run's initiator. |
| Move from *Human Review* to *In Progress* | `dev-feedback` run (feedback from the PR and the thread). |
| Move to *AI Review* | The AI review of the published commit again (two read-only lenses, findings on the PR, ORC-183), then back to *Human Review*. `dev`'s end starts it by itself. |
| `@relais <question>` in a comment | Read-only answer (`ask`), including on a non-delegated ticket. |
| `@relais retiens <fait>` | PR in the knowledge repository (`remember`). |
| `@relais fais-le` | Reminds that the ticket must be delegated. |
| `agent:stop` label, the session's stop button, or removing the delegation | Run stopped, ticket blocked. |
| Reply on a blocked ticket (comment or session) | Relaunches the blocked step, with the reply as input: see [The blocking comment](#the-blocking-comment-orc-196). |

**Done means a merge decision (ORC-148).** A delegated ticket in *Human Review*, whose PR is open, moved to *Done* by a human who has GitHub merge rights (checked against the actor of the signed webhook), is merged by the factory with its GitHub App, on the **commit shown in *Human Review***: when the factory moves the ticket to *Human Review* at the end of its own work, it records the PR head, and only merges that commit, if it is still the head of the ticket's PR and its checks are green. **Repository without CI**: a reviewed commit with no checks at all is only merged in a repository without CI, recognized by three signs reread at merge time: the reviewed commit still has no checks, the repository has no active GitHub Actions workflow of its own (a CI on `pull_request` only leaves no check on the base; GitHub's dynamic workflows, Pages or Dependabot, do not count; unreadable workflows, for lack of read *Actions* permission, count as a CI), and the PR's base commit has no checks (a non-Actions CI that checks the base). Otherwise the CI has not run yet on the reviewed commit, and the factory refuses. A non-Actions CI that only runs on PRs is not recognized: protect the branch with required checks. Checks required by branch protection are still enforced by GitHub on merge. The merge method is the first one the repository allows (merge, otherwise squash, otherwise rebase).

**Push during review**: nothing is merged, and the new commits **go back through AI review**. The factory moves the ticket to *AI Review* and itself launches the job of the `status.changed` `to: ai_review` rule (`review` in the standard pack): a move made by the factory does not emit `status.changed`, so the rule would not trigger on its own. The Linear webhook for that move does not launch a second review, even if it arrives after the echo has expired (60 s): a change to the status where the factory itself put the ticket, as long as it is still there and no human has moved it since, does nothing. If it arrives after the review has brought the ticket back to *Human Review* (a delivery retried by Linear much later), it is read as a human move to *AI Review*. A successful review brings the ticket back to *Human Review* on the new head, which becomes the reviewed commit: the next *Done* merges it. The rule is chosen as for a human who would move the ticket from *Done* to *AI Review* (`from`, `when` included); only its `run` is applied. A blocked ticket (it is waiting for a human), or a workflow without an `ai_review` state or without that rule, goes back to *Human Review* as for the other refusals. A refusal that arrives after a human has taken the ticket out of *Done* (effect replayed late) only gets a reply: the ticket stays where the human put it.

The other refusals merge nothing and send the ticket back to *Human Review* with the reason in a comment: actor without rights, checks of the reviewed commit red or still running, no check on the reviewed commit in a repository that has a CI, PR of a branch that is not the ticket's, PR that GitHub refuses to merge, merge that keeps failing through all its retries (GitHub unavailable), no reviewed commit recorded (the factory only records one at the end of its own work, an AI review or a dev that brings the ticket back to *Human Review*, and only if the PR head is the commit on which that work ended: not for a ticket put there by hand, nor after a refusal, nor if the PR head could not be read; move the ticket to *AI Review*, the AI review records it when bringing it back to *Human Review*). A PR already merged on GitHub in the meantime is not a refusal: the ticket stays in *Done*. This return **keeps** the reviewed commit: a head pushed since is never taken as reviewed. To abandon a PR, move the ticket to *Canceled*, not *Done*. **Canceling a ticket never writes anything on the forge**: no merge, no closing of the PR, which stays open (two tickets may share a PR). With the `gh` CLI instead of the GitHub App, the factory does not merge.

What triggers nothing: a *Done* with no signed actor (Linear's GitHub integration after a merge done on GitHub, reconciliation), a *Done* set during dev or AI review, a *Done* on a ticket without an open PR.

After the PR is merged (detected by the GitHub poll): status *Done*, worktree deleted, `learn` run. The code run still in progress is stopped, and whatever was waiting (queue, reply in `debounce`) is dropped. After that, no more code work starts on the ticket: a reply in the ticket relaunches nothing (a reply is only kept). To resume the ticket, change its status to something other than *Done* (also when Relais could not move it to *Done*) or delegate it again.

A team with several repositories: each ticket designates its own with a `repo:<id>` label ([`projects-and-workspaces.md`](projects-and-workspaces.md#one-team-several-repositories)).

Only tickets **delegated** to the agent receive code work; a mention on a non-delegated ticket only gets an answer. All this behavior is changed in `.relais/workflow.yml`: [`workflow.md`](workflow.md). The checks before taking a ticket (description of at least 30 characters, no existing branch…) are described in [`workflow.md`](workflow.md#tracker); `relais plan` applies them as a dry run.

A blocked ticket (failure, cap, question, stop, lease expired twice, too many relaunches after an outage) is waiting for a human: reply in the ticket.

### What the factory publishes (ORC-214)

Every comment and activity the factory writes in Linear, and the PR's title and body on GitHub, goes through its `OutputPolicy` (`src/publish/output-policy.ts`). Nothing an agent writes as a message is posted as is: the end of a run is composed by the factory from the agent's `submit_result` (its summary for a reply or a review synthesis; the recap for the end of a build), and a run that returned none posts a fixed sentence saying so.

**The recap (ORC-195).** When the build ends, the ticket moves to *Human Review* and its PR leaves draft, the factory posts in the session the end of the build as ORC-289 posts it (the summary, then why, risks, untested and points to review when the agent stated them), the tests added, then the work of every attempt of the ticket (intake, tests and questions included) as the dashboard measures it: attempts, turns, tokens (what a token cap counts: input, output and cache writes, cache reads apart) and duration (the sum of the attempts' durations). What is not known is said (« tokens not reported », « 1 attempt reported none », « 1 attempt not measured »), never shown as zero. The PR's description carries them too, with the assumptions and the trusted section, in the reviewer's order ([`github.md`](github.md)).

The policy refuses a text over its cap, a base64 or hexadecimal blob, and a secret found by gitleaks, the scanner of the diff check, in a sandbox without network, the `gitleaks:allow` of the text ignored. A refused text is not posted: the factory posts in its place a notice naming the rules it broke, never its content, and logs it. A gitleaks that cannot run is no green: the write fails and the outbox retries it. A PR text refused blocks the publication, with the reason.

The caps, in `OUTPUT_LIMITS` (`src/publish/output-limits.ts`, proposed values, to be confirmed): 10,000 characters for a comment, an activity or a PR body; 256 for a PR title (GitHub's limit; the factory clips a longer ticket title); in `submit_result`, which refuses them so the agent shortens within its run: 6,000 for the summary, 2,000 for `why` and the question, 500 per list entry, 20 entries per list. A run of 65 hexadecimal characters (a sha-256 is 64), or of 100 base64 characters dense enough to be encoded data, is a blob, its lines joined when it is wrapped as `base64` or `xxd -p` wrap it. A comment and an activity with the same text, or a write retried, are scanned once.

**The live feed.** During a run, the session still shows what the agent is doing, at most every 2 seconds: the kind of action, in the factory's words (« Running a command », « Reading the code », « Searching the code », « Editing files », « Following a method skill », « Working with a subagent », « Submitting its result », « Using a tool » for any other), and the step (`step build`). What it no longer shows: the agent's thoughts (its text between tools) and the parameters of its tools (the command, the path, the search). Both stay in the dashboard's live session and the run's transcript, which do not leave the factory. The feed's words are the factory's alone, so it does not go through the policy.

### The blocking comment (ORC-196)

Every block is reported in the same place and the same way, in a comment on the ticket, the only escalation channel, with the `Bloqué` label next to the status:

```
🔴 Blocked at step <step> (attempt <n>/<max>)
Reason: <one sentence>
What I tried:
- <fact>
Question: <a closed question if possible>
State: branch <name> · last commit <sha> · CI <state> · code-run tokens <n> · <duration>
Reply on this ticket: I will resume as soon as you answer.
```

`decide` writes the fields, the factory composes the text in a single place (`src/core/block-comment.ts`; the `OutputPolicy` checks it before it is posted, ORC-214) and reads the state at write time. What the factory does not know, it says (`none`, `unknown`). "What I tried" only lists facts: sometimes just one, never invented. A block that a reply does not lift (repository to add or to name) says so on the last line. A stop on request (`stop`, PR closed) stays a reply in the session: there is nothing to escalate.

**Replying.** A comment from a workspace user on a blocked and delegated ticket, or a reply in its session, relaunches the blocked step. The comment can be at the ticket level or in a thread. These do not count as a reply: a comment from the factory, from an integration or synced (Slack, email), a comment that starts with a mention (`@relais` opens its own session, `@someone` talks to someone else), `/refreeze`. A human who is not a member of the team is refused: the refusal is journaled and replied to in the ticket. An accepted comment follows the same path as a reply in the session: secret masked before the journal, classified, kept in `humanInbox` with its taint, and the run that empties the inbox takes the taint of everything it empties (I12). A question on a blocked ticket counts as a reply and relaunches the step. `/status` and `/stop` are commands: they relaunch nothing, and `/status` is answered in a comment. On a ticket that is not waiting for a reply, a comment remains a conversation between humans: the factory does not read it, it does not enter `humanInbox`, and a comment written just after the resumption is therefore not kept. To talk to the agent while it works, use its session. A comment lost by Linear is not caught up by reconciliation.

Tickets already started stay on the pinned version of their workflow: they keep free text in the session, and the `agent:reprendre` label still relaunches `dev-feedback` there, until they finish.

### Triggering

**Acknowledgement** (ORC-171). An authorized delegation, mention or command arriving by webhook receives an acknowledgement, the first effect of its decision, therefore written through the outbox and replayable without duplicates:

- **delegation**: the comment « Got it. » on the ticket (a comment and not a reaction, until ORC-140 has decided), the same text as a `thought` activity in the session (Linear marks a session as unresponsive if no activity arrives within 10 s; a plan alone does not count), then the plan if the delegation launches a run;
- **mention, command**: the `thought` activity in the session opened under the comment, neither comment nor plan. `/refreeze` has no acknowledgement: its reply (done, nothing to refreeze, or refusal), written by the same decision, stands in for it.

The acknowledgement does not hold up the work: a comment or an activity that Linear refuses is journaled, without a retry and without blocking the ticket; the run starts anyway. The webhook → acknowledgement delay is kept on the inbox row (`acked_at`, time of the first visible write, before the plan; nothing if none succeeded): it is `signOfLifeMs` in the [measures](operations.md). **The 10 s are not guaranteed in two cases**, which this measure shows: the acknowledgement comes after role resolution (Linear and GitHub, cached 60 s; if one of them does not respond, the event waits), and after work already in progress on the same ticket, because the outbox executes a ticket's effects in order (a mention during the worktree preparation of a `start_run`, an effect waiting for its retry). A new ticket has nothing ahead of it. A refusal (ORC-186) or an already active run only receives its reply in the session: nothing was taken. A delegation found by reconciliation is not acknowledged.

### Human messages during a run

A message (reply in a session, mention, command) goes through ingestion, then through `decide` (ORC-180).

- **On arrival.** The known secret shapes from transcripts (`maskTranscriptLine`) are masked before the journal; its author is warned, because the message stays in Linear. Masking only sees those shapes: neither the values of the factory's secrets, nor gitleaks (which only reads commits, in a sandbox). No injection analysis exists: the message remains data, marked by its taint.
- **Classification** (`classifyMessage`, journaled with the event: a change in the rules does not change a past decision, and replay never calls a model). Commands come first, read by their first word, and never reach a model: `/status` and `/stop`, `/refreeze`, the spec gate's `/approve`, `/changes` and `/reject`, and the workflow's `say:` commands of a mention (`retiens`, `fais-le`). Every other message is classified `instruction` or `question` by a small model (`claude-haiku-5-5`, low effort, no tool) at ingestion, before the event is journaled (ORC-336). Only an explicit request to change or do something is an `instruction`; anything else (thanks, acknowledgements, remarks, questions) is a `question`. The message goes to it as quoted, untrusted data, and only the exact word `instruction` or `question` counts as its verdict. Without a verdict (the model disabled, no credential, an error, past its bound, any other answer), a fallback rule decides: a `?` outside a URL makes a question, anything else an instruction. Which backend, and its bound, are in [operations](operations.md#the-small-model-of-messages).
- **Sign of life.** An acknowledgement through the outbox as soon as the decision is made, written in the session, the `signOfLifeMs` of the [measures](operations.md).
- **`humanInbox`.** Every accepted message enters it, whatever its classification; a message refused by the matrix receives its refusal and does not enter it. It leaves when an attempt that reads it is written, or when the ticket is canceled; beyond 50, the oldest of those already answered (question from a thread, command) leaves too, and stays in the journal. It keeps its event's taint: a run that empties the inbox has the sensitive paths protected as soon as it contains an untrusted message, including a command, even though it is not given to it.
- **Classification adds, it does not divert.** A question launches `ask` right away (ORC-182 will extend this), and remains for the agent: a misclassified message is never lost. In a question thread, a question alone does not call the agent; an instruction does.
- **The step boundary.** The launch of a run of the implementing agent (`tests`, `dev`, resumption after a failed verification, `fix-ci`, `dev-feedback`) carries all pending messages, in its prompt and in its record: relaunching a cut attempt rereads the same thing. A `review` does not read them. The 3-minute batching remains, and launches nothing while a run, a verification or a pending job is in progress: their end is what hands over the messages. When the work is finished with no next step (move to *Human Review*), or with no work in progress at all once the 3 minutes have passed, the agent is resumed on them by `dev-feedback`.
- **Questions of `clarify`** (ORC-210). Each is an `elicitation` activity; with options, it carries Linear's `select` signal (`signalMetadata.options`, each option its own label and value). A picked option comes back as an ordinary reply in the session, as free text does. While they wait, each authorized reply answers the next open question; see [preset](preset.md#clarify-questions-reminder-and-expiry-orc-210).
- **Blocked ticket.** A reply in the ticket's session relaunches it through the workflow's `session.prompted` rule (ORC-196), and the run reads the whole inbox. A reply in a question thread does not relaunch it, nor does batching: a message written before the block does not answer its question.

**Plan in the session.** `Understand · Questions · Spec · Tests · Build · Verify · PR`, written in full on every change (`agentSessionUpdate` with `plan`; Linear replaces the plan each time). It stays in the session of the delegation that opened it. The step advances when a `dev` queue run that hands the ticket back is launched (`spec` for `spec_draft`, `tests` for a job with a `red` check, `build` otherwise), on the `verify` check, on a PR seen outside a run; the end of the factory's work (move to *Human Review*) closes the current step, and the PR one if it exists. A run that does not hand the ticket back (`dev-feedback`, `fix-ci`) does not change the plan: nothing would close the step again. Relaunching a lost run (`run.lost`) puts its step back in progress, without a new acknowledgement; blocked by the relaunch bound, the ticket keeps its step as is, as under any block. A skipped step is marked canceled, not done: today `questions` (even when `clarify` asks, ORC-210), `spec` when the repository does not run `spec_draft` (ORC-212), and `tests` or `Verify` depending on the workflow. The plan is kept in `meta` (`plan:<projet>:<ticket>`), outside the journal. Linear's plan API is in preview: a refused plan is journaled and never stops the work. A ticket picked up before ORC-171 has no plan.

**A single active run per ticket.** A new delegation on a ticket that has a run or a verification in progress launches nothing, queues nothing, keeps the initiator and replies in its session; after a restart, this holds for the resumed run as well as the relaunched one. Two delegations of a queued ticket give a single queue row, but `decide` does not see the queue: the second is acknowledged too, and its author becomes the initiator.

**Team without a repository.** A delegation on a Linear team that no project in `config.yaml` takes goes to Blocked (`Bloqué` label, reason in the blocking comment), whoever its author: without a repository, there is no role to check. The ticket waits under the **first** project in the configuration, and no work starts. To fix it: add a project for that team and restart, the next reconciliation pass lifts the block and the label, then delegate again. A delegation that arrives before that pass already goes to the new repository, and removes the label. Everything else on that team (mention, reply, ticket change) stays ignored, as before. Attachment by Linear *project* does not exist yet: routing is done by team, and `repos` in `factory.yml` is not read for routing yet (ORC-204).

### Authorizations: who can do what

Each human action is checked against the webhook's **signed actor** (the Linear id of the author, see above), never against a name quoted in the text: a comment "Lilian says: start the dev" written by someone else counts as written by that someone else. The default matrix (ORC-186):

| Action | Required role | Channel | Wired today to |
|---|---|---|---|
| Trigger the agent | Member of the Linear team **and** GitHub write access to the repository | Linear | delegation, `@relais` mention, command; status change or label that launches a run on a non-blocked ticket |
| Reply to the agent (`clarify`), ask it a question | Requester (who delegated the ticket) **or** team member | Linear session | reply in the ticket's session, `clarify`'s answers included (ORC-210), question in a question session |
| Approve the spec | Designated approver, **never** the run's initiator | Linear session | `/approve`, `/changes`, `/reject` replied in the ticket's session (ORC-212), also refused without resolved roles; elsewhere (a mention, another session), refused as not through this channel |
| Refreeze (`/refreeze`) | Designated maintainer | Linear or PR | `/refreeze` command by mentioning the agent in the ticket or replying in its session (ORC-131), also refused without resolved roles; not yet from the PR |
| Relaunch a blocked run | Team member | Linear (comment, reply in the session, project label) | reply in the ticket, label or status change that launches a run, on a blocked ticket |
| Move to *Done* (merge) | GitHub merge rights | Linear | no merge, refusal replied to in the ticket, back to *Human Review* (ORC-148) |

A refusal launches nothing, does not keep the refused reply for the next run and does not unblock the ticket; it is replied to where the human acted (in the event's session, otherwise as a ticket comment), through the outbox, so only once even if the effect is replayed, and the daemon logs `authz: refused …`. The refused delegation stays recorded (Linear did delegate): an authorized member can then relaunch. An event with no signed actor (integration, Slack, email, delegation found by reconciliation) is refused for every action in the matrix; if it has no session either (delegation, move or label found by reconciliation, change made by an integration), there is nobody to reply to: the refusal is only journaled. A delegation whose webhook was lost is therefore no longer caught up by reconciliation: delegate again. Stopping (`agent:stop`, stop button, removing the delegation) is not in the matrix. GitHub events (`push.human`, `pr.reviewed`, `pr.conflicted`, `pr.closed`) do not go through it today either: none makes the factory act on behalf of a human (a review without reaction, ORC-190; a conflict starts the factory's own rebase step, ORC-146; a closed PR only stops; a human push is untrusted: it pauses the agent's work and runs `verify` on the pushed commit, ORC-159, and launches no agent). Their reactions will bring their own check, on the signed GitHub login.

**Where roles come from.** Before deciding a human event that the matrix can check, the daemon resolves its actor's roles and **journals them with the event**: a replay of the journal decides on the same roles, and `decide` stays pure: replaying the journal (`npm run test:replay`, ORC-174) makes the same decision, refusals included, and the refusal trace is kept in `decision_trace`. An event that the matrix does not check (label removed, status change that no rule with `run` takes, untracked ticket) waits for neither Linear nor GitHub.

- *Team member*: active members of the project's Linear team (`teams { members }`).
- *Write access* and *merge rights*: the user's permission on the repository (`GET /repos/{owner}/{repo}/collaborators/{login}/permission`), read by the GitHub App or, as a fallback, by `gh api` (a login GitHub does not know has no rights with the App; with `gh`, which gives the same 404 for a repository it cannot see, any error makes the event wait); `write`, `maintain` and `admin` grant both (GitHub allows merging with write access, branch protections aside). Linear provides no GitHub login that Relais can read: each Linear user whose GitHub rights matter is linked to their login in `config.yaml` (`projects[].authz.githubLogins`). Without a login, no GitHub rights: that user cannot trigger.
- *Maintainer* and *approver*: lists of Linear ids in `config.yaml` (`projects[].authz.maintainers`, `validators`), until `.factory/config.yml` (ORC-209). See [configuration](configuration.md#authorization).
- *Requester*, *initiator*: the signed author of the ticket's last authorized delegation.

Linear members and GitHub permissions are cached for **60 s** then reread: someone who leaves the team or loses their rights can no longer act beyond that. If Linear or GitHub does not respond, the event waits in the inbox and is retried; it is never decided without its roles. The matrix is a constant in the code (`src/core/authz.ts`) until the `factory/default` preset declares it (ORC-187).

## 5. States, columns and labels

Relais reasons in five **logical states** mapped by name to the team's statuses ("Ready to Merge" no longer exists since ORC-170):

| Logical state | Linear status (pack) | Linear type given if created |
|---|---|---|
| `todo` | Todo | `unstarted` |
| `dev` | In Progress | `started` |
| `human_review` | Human Review | `started` |
| `ai_review` | AI Review | `started` |
| `done` | Done | `completed` |

Missing statuses are created on connection. If your columns have other names, declare them in `states` in `.relais/workflow.yml` **before** connecting Linear ([`workflow.md`](workflow.md#states)), otherwise Relais creates the pack's names next to yours.

Moves made by Relais itself are recognized (for 60 s) and do not re-trigger a rule.

A delegated ticket moved by a human to a status of type *Canceled* cancels its run (stop, queue and pending replies dropped); it is not blocked, and a block in progress is lifted along with its label (ORC-170).

As long as a ticket is **blocked** (the factory is waiting for a reply), the `Bloqué` label is set next to its status; it is removed when the ticket restarts. Relais creates it on connection, along with `agent:stop`.

## 6. Teams and projects

A Relais project = one repository + **one** Linear team (`linearTeamKey` in `config.yaml`). A single instance can track several teams (one project each); see [`projects-and-workspaces.md`](projects-and-workspaces.md). Webhooks from an unconfigured team are ignored.

## Troubleshooting

See [`operations.md`](operations.md#troubleshooting): rejected webhooks, refused callback, duplicate statuses, reconnection.
