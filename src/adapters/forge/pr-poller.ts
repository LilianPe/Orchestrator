import type { Clock } from "../../core/clock.js";
import type { ProjectRuntime } from "../../core/orchestrator.js";
import { TRUSTED, type FactoryEvent, type TicketState } from "../../core/types.js";
import type { Store } from "../../store/types.js";
import type { Forge } from "./types.js";

export class PrPoller {
  private handle: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private d: {
      store: Store;
      forge: Forge;
      projects: ProjectRuntime[];
      submit: (e: FactoryEvent) => void;
      clock: Clock;
      log: (m: string) => void;
    },
  ) {}

  async pollOnce(): Promise<void> {
    for (const t of this.d.store.listTickets()) {
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
      if (done && (!t.prNumber || t.prState === "MERGED" || this.d.store.getMeta(finalKey) === String(t.prNumber))) return;
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
        this.d.submit({
          ...base,
          id: `pr:${t.ticketId}:${pr.number}:opened`,
          type: "pr.opened",
          payload,
        });
      if (pr.state === "MERGED" || pr.state === "CLOSED") {
        if (pr.state === "MERGED") this.d.submit({ ...base, id: `pr:${t.ticketId}:${pr.number}:merged`, type: "pr.merged", payload });
        else this.d.submit({ ...base, id: `pr:${t.ticketId}:${pr.number}:closed`, type: "pr.closed", payload });
        if (done) this.d.store.setMeta(finalKey, String(pr.number));
        return;
      }
      if (done) return;
      const metaKey = `checks:${t.projectId}:${t.ticketId}`;
      if (pr.checks === "none") return;
      const last = this.d.store.getMeta(metaKey);
      if (pr.checks !== last) {
        const id = `pr:${t.ticketId}:${pr.number}:checks:${pr.checks}:${at}`;
        if (pr.checks === "fail")
          this.d.submit({
            ...base,
            id,
            type: "pr.checks_failed",
            payload: { ...payload, failures: pr.failedChecks },
          });
        else if (pr.checks === "pass")
          this.d.submit({ ...base, id, type: "pr.checks_passed", payload });
        this.d.store.setMeta(metaKey, pr.checks);
      }
    }
  }

  start(intervalMs = 30_000): void {
    this.stop();
    this.handle = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.pollOnce()
        .catch((e: Error) => this.d.log(`pr poll: ${e.message}`))
        .finally(() => (this.running = false));
    }, intervalMs);
  }

  stop(): void {
    if (this.handle) clearInterval(this.handle);
    this.handle = undefined;
  }
}
