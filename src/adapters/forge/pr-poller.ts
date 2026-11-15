import type { Clock } from "../../core/clock.js";
import { pushedPublications } from "../../core/changelog.js";
import type { ProjectRuntime } from "../../runtime/daemon.js";
import { TRUSTED, type FactoryEvent, type TicketState } from "../../core/types.js";
import { isTakenOver } from "../../core/block-cause.js";
import { upcast } from "../../core/upcast.js";
import type { Store } from "../../store/types.js";
import { checksEventId, prEventId, pushEventId } from "./github-webhook.js";
import type { Forge, PrInfo } from "./types.js";

export class PrPoller {
  private handle: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;

  constructor(
    private d: {
      store: Store;
      forge: Forge;
      projects: ProjectRuntime[];
      /** Writes the event to the inbox; awaited, so a failed write is reported and retried at the next poll. */
      submit: (e: FactoryEvent) => unknown;
      clock: Clock;
      log: (m: string) => void;
    },
  ) {}

  /** One pass, over every project's tickets, or `projectId`'s only (its reconciliation, ORC-185). */
  async pollOnce(projectId?: string): Promise<void> {
    for (const t of await this.d.store.listTickets()) {
      if (projectId !== undefined && t.projectId !== projectId) continue;
      try {
        await this.pollTicket(t);
      } catch (err) {
        this.d.log(`pr poll ${t.ticketId}: ${(err as Error).message}`);
      }
    }
  }

  private async pollTicket(t: TicketState): Promise<void> {
    {
      if (!t.branch) return;
      // Done in Linear is not merged: Linear may move the ticket before a poll sees the merge, and only
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
        this.d.log(`pr poll ${t.ticketId}: ${(err as Error).message}`);
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
      if (pr.state === "MERGED" || pr.state === "CLOSED") {
        // The merge commit, head and merge time the forge reads, as the webhook records them (ORC-278).
        const shas = {
          ...(pr.mergeSha ? { mergeSha: pr.mergeSha } : {}),
          ...(pr.headSha ? { headSha: pr.headSha } : {}),
          ...(pr.mergedAt !== undefined && Number.isFinite(pr.mergedAt) ? { mergedAt: pr.mergedAt } : {}),
        };
        if (pr.state === "MERGED") await this.d.submit({ ...base, id: prEventId(t.ticketId, pr.number, "merged"), type: "pr.merged", payload: { ...payload, ...shas } });
        else await this.d.submit({ ...base, id: prEventId(t.ticketId, pr.number, "closed"), type: "pr.closed", payload });
        if (done) await this.d.store.setMeta(finalKey, String(pr.number));
        return;
      }
      if (done) return;
      // A failed judgement of the head holds back no CI verdict: it is tried again at the next pass.
      await this.lostPush(t, pr, at).catch((err) => this.d.log(`pr poll ${t.ticketId}: ${(err as Error).message}`));
      const metaKey = `checks:${t.projectId}:${t.ticketId}`;
      if (pr.checks === "none") return;
      const last = await this.d.store.getMeta(metaKey);
      if (pr.checks !== last) {
        // Per head SHA, as the GitHub webhook names it (ORC-134): the poll and the webhook report the same verdict once.
        const id = checksEventId(t.ticketId, pr.number, pr.checks, pr.headSha ?? String(at));
        if (pr.checks === "fail")
          await this.d.submit({
            ...base,
            id,
            type: "pr.checks_failed",
            payload: { ...payload, failures: pr.failedChecks },
          });
        else if (pr.checks === "pass")
          await this.d.submit({ ...base, id, type: "pr.checks_passed", payload });
        await this.d.store.setMeta(metaKey, pr.checks);
      }
    }
  }

  /**
   * A head of the open PR the factory neither published, verified, nor heard of is a human's push whose webhook got lost
   * (ORC-281), under the webhook's id. Each head is judged once: the journal is read again only for a new one.
   */
  private async lostPush(pass: TicketState, pr: PrInfo, at: number): Promise<void> {
    const head = pr.headSha;
    if (!head) return;
    // The factory's push is on the forge before its event: the ticket as it is now, read after the PR, knows the commit it verified.
    const t = (await this.d.store.getTicket(pass.projectId, pass.ticketId)) ?? pass;
    // A take-over's bundle is pushed before its `push.human`, under the human's name, is accepted (ORC-234).
    if (head === t.verifiedSha || head === t.humanHead || isTakenOver(t)) return;
    const seenKey = `lost-push:${t.projectId}:${t.ticketId}`;
    if ((await this.d.store.getMeta(seenKey)) === head) return;
    // One head per commit: a commit published twice in a row is pushed once.
    const heads = pushedPublications((await this.d.store.ticketJournal(t.projectId, t.ticketId)).map((j) => upcast(j.event)))
      .map((p) => p.sha)
      .filter((sha, i, all) => sha !== all[i - 1]);
    const published = heads.at(-1);
    // Its last publication, and the one before, which the forge may still read just after a push. A branch put back on an older one
    // is a human's push, as the webhook reports it.
    if (published && !heads.slice(-2).includes(head))
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
        payload: { branch: pr.branch, sha: head, author: "unknown", before: t.humanHead ?? published },
      });
    await this.d.store.setMeta(seenKey, head);
  }

  start(intervalMs = 30_000): void {
    if (this.handle) clearInterval(this.handle);
    this.handle = setInterval(() => {
      this.polling ??= this.pollOnce()
        .catch((e: Error) => this.d.log(`pr poll: ${e.message}`))
        .finally(() => (this.polling = undefined));
    }, intervalMs);
  }

  /** No poll starts after it; resolves once the poll under way, if any, has finished. */
  async stop(): Promise<void> {
    if (this.handle) clearInterval(this.handle);
    this.handle = undefined;
    await this.polling;
  }
}
