import type { Clock } from "../../core/clock.js";
import { lastPush, pushedHeads } from "../../core/changelog.js";
import type { ProjectRuntime } from "../../runtime/daemon.js";
import { TRUSTED, type FactoryEvent, type TicketState } from "../../core/types.js";
import { isTakenOver } from "../../core/block-cause.js";
import { upcast } from "../../core/upcast.js";
import type { Store } from "../../store/types.js";
import { checksEventId, prEventId, prStateEventId, pushEventId, UNKNOWN_PUSHER } from "./github-webhook.js";
import type { Forge, PrInfo } from "./types.js";

/**
 * The GitHub half of the reconciliation (ORC-185): run with Linear's, every 5 minutes, by its timer in the store. It reads each
 * ticket's PR on the forge and writes what the webhooks may have lost (ORC-134), under their ids, so the inbox keeps a fact once.
 */
export class GithubReconciler {
  constructor(
    private d: {
      store: Store;
      forge: Forge;
      projects: ProjectRuntime[];
      /** Writes the event to the inbox; awaited, so a failed write is reported and retried at the next pass. */
      submit: (e: FactoryEvent) => unknown;
      clock: Clock;
      log: (m: string) => void;
    },
  ) {}

  /** One pass, over every project's tickets, or `projectId`'s only (its reconciliation, ORC-185). */
  async once(projectId?: string): Promise<void> {
    for (const t of await this.d.store.listTickets()) {
      if (projectId !== undefined && t.projectId !== projectId) continue;
      try {
        await this.ticket(t);
      } catch (err) {
        this.d.log(`github reconcile ${t.ticketId}: ${(err as Error).message}`);
      }
    }
  }

  private async ticket(t: TicketState): Promise<void> {
    {
      if (!t.branch) return;
      // Done in Linear is not merged: Linear may move the ticket before a pass sees the merge, and only
      // pr.merged marks it delivered (I8 b). A done ticket with a known PR is watched until that PR is seen
      // merged or closed (its number kept in `finalKey`, so a new PR is watched again).
      const finalKey = `pr-final:${t.projectId}:${t.ticketId}`;
      const done = t.logical === "done";
      if (done && (!t.prNumber || t.prState === "MERGED" || (await this.d.store.getMeta(finalKey)) === String(t.prNumber))) return;
      const project = this.d.projects.find((p) => p.id === t.projectId);
      if (!project) return;
      let pr;
      try {
        pr = await this.d.forge.findPr(project.repoPath, t.branch);
      } catch (err) {
        this.d.log(`github reconcile ${t.ticketId}: ${(err as Error).message}`);
        return;
      }
      if (!pr) return;
      const at = this.d.clock.now();
      const base = { ...TRUSTED, at, projectId: t.projectId, ticketId: t.ticketId };
      const payload = { number: pr.number, url: pr.url, branch: pr.branch };
      if (t.prNumber !== pr.number)
        await this.d.submit({
          ...base,
          id: prEventId(t.ticketId, pr.number, "opened"),
          type: "pr.opened",
          payload,
        });
      // The same PR, recorded closed, read open: reopened, its webhook lost (ORC-469). Until it is decided, the CI verdicts
      // of a closed PR are ignored.
      else if (t.prState === "CLOSED" && pr.state === "OPEN")
        await this.d.submit({ ...base, id: prStateEventId(t, pr.number, "reopened"), type: "pr.opened", payload });
      if (pr.state === "MERGED" || pr.state === "CLOSED") {
        // The merge commit, head and merge time the forge reads, as the webhook records them (ORC-278).
        const shas = {
          ...(pr.mergeSha ? { mergeSha: pr.mergeSha } : {}),
          ...(pr.headSha ? { headSha: pr.headSha } : {}),
          ...(pr.mergedAt !== undefined && Number.isFinite(pr.mergedAt) ? { mergedAt: pr.mergedAt } : {}),
        };
        if (pr.state === "MERGED") await this.d.submit({ ...base, id: prEventId(t.ticketId, pr.number, "merged"), type: "pr.merged", payload: { ...payload, ...shas } });
        // Per closing (ORC-469): a PR reopened then closed again is closed again; one recorded closed has nothing more to say.
        else if (t.prNumber !== pr.number || t.prState !== "CLOSED")
          await this.d.submit({ ...base, id: prStateEventId(t, pr.number, "closed"), type: "pr.closed", payload });
        if (done) await this.d.store.setMeta(finalKey, String(pr.number));
        return;
      }
      if (done) return;
      // A failed judgement of the head holds back no CI verdict: it is tried again at the next pass.
      await this.lostPush(t, pr, at).catch((err) => this.d.log(`github reconcile ${t.ticketId}: ${(err as Error).message}`));
      const metaKey = `checks:${t.projectId}:${t.ticketId}`;
      if (pr.checks === "none") return;
      // The verdict per head (ORC-466): a red CI the engine ignored, of a head left behind, hides not the next head's.
      const seen = pr.headSha ? `${pr.checks}:${pr.headSha}` : pr.checks;
      if (seen !== (await this.d.store.getMeta(metaKey))) {
        // Per head SHA, as the GitHub webhook names it (ORC-134): the reconciliation and the webhook report the same verdict once.
        const id = checksEventId(t.ticketId, pr.number, pr.checks, pr.headSha ?? String(at));
        if (pr.checks === "fail")
          await this.d.submit({
            ...base,
            id,
            type: "pr.checks_failed",
            payload: { ...payload, failures: pr.failedChecks, ...(pr.headSha ? { headSha: pr.headSha } : {}) },
          });
        else if (pr.checks === "pass")
          await this.d.submit({ ...base, id, type: "pr.checks_passed", payload: { ...payload, ...(pr.headSha ? { headSha: pr.headSha } : {}) } });
        await this.d.store.setMeta(metaKey, seen);
      }
    }
  }

  /**
   * A head of the open PR the factory neither published, verified, nor heard of is a human's push whose webhook got lost
   * (ORC-281), under the webhook's id. A head is judged at each pass that reads it, against the ticket's journal then.
   */
  private async lostPush(pass: TicketState, pr: PrInfo, at: number): Promise<void> {
    const head = pr.headSha;
    if (!head) return;
    // The factory's push is on the forge before its event: the ticket as it is now, read after the PR, knows the commit it verified.
    const t = (await this.d.store.getTicket(pass.projectId, pass.ticketId)) ?? pass;
    // A take-over's bundle is pushed before its `push.human`, under the human's name, is accepted (ORC-234): read once it ends.
    if (isTakenOver(t)) return;
    if (head === t.verifiedSha || head === t.humanHead) return;
    const events = (await this.d.store.ticketJournal(t.projectId, t.ticketId)).map((j) => upcast(j.event));
    const last = lastPush(events);
    const published = last?.sha;
    // The last push and the head it went over, which the forge may still read just after it (ORC-438). A branch put back on
    // any other is a human's push, as the webhook reports it.
    if (last?.before ? head === published || head === last.before : await this.inWindow(t, head, pushedHeads(events))) return;
    await this.d.submit({
      ...TRUSTED,
      // What the push brought was verified by no one in the factory (I12).
      taint: "untrusted",
      at,
      projectId: t.projectId,
      ticketId: t.ticketId,
      id: pushEventId(t.ticketId, head),
      type: "push.human",
      // The PR names no pusher; `before`, the head last known, so that only the commits since are the human's (ORC-338).
      payload: { branch: pr.branch, sha: head, author: UNKNOWN_PUSHER, before: t.humanHead ?? published },
    });
  }

  /**
   * A last push journaled with no head it went over (before ORC-438, a push that made the branch, or one whose publisher failed
   * before it said the head): the factory's heads are then its last two commits pushed, and, before the second, the head read
   * with no publication, which the forge may still read just after the first.
   */
  private async inWindow(t: TicketState, head: string, heads: string[]): Promise<boolean> {
    if (heads.length <= 1) {
      const unpublishedKey = `lost-push:${t.projectId}:${t.ticketId}`;
      const unpublished = await this.d.store.getMeta(unpublishedKey);
      // With no publication, there is nothing to compare with: the head read then is kept.
      if (!heads.length) {
        if (unpublished !== head) await this.d.store.setMeta(unpublishedKey, head);
        return true;
      }
      if (unpublished === head) return true;
    }
    return heads.slice(-2).includes(head);
  }
}
