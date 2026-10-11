import type { Clock } from '../../core/clock.js';
import type { ProjectRuntime } from '../../core/orchestrator.js';
import type { RelaisEvent } from '../../core/types.js';
import type { Store } from '../../store/types.js';
import type { Forge } from './types.js';

export class PrPoller {
  private handle: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private d: { store: Store; forge: Forge; projects: ProjectRuntime[]; submit: (e: RelaisEvent) => void; clock: Clock; log: (m: string) => void },
  ) {}

  async pollOnce(): Promise<void> {
    for (const t of this.d.store.listTickets()) {
      if (!t.branch || t.logical === 'done') continue;
      const project = this.d.projects.find((p) => p.id === t.projectId);
      if (!project) continue;
      let pr;
      try {
        pr = await this.d.forge.findPr(project.repoPath, t.branch);
      } catch (err) {
        this.d.log(`pr poll ${t.ticketId}: ${(err as Error).message}`);
        continue;
      }
      if (!pr) continue;
      const at = this.d.clock.now();
      const base = { at, projectId: t.projectId, ticketId: t.ticketId };
      const payload = { number: pr.number, url: pr.url, branch: pr.branch };
      if (t.prNumber !== pr.number) this.d.submit({ ...base, id: `pr:${t.ticketId}:${pr.number}:opened`, type: 'pr.opened', payload });
      if (pr.state === 'MERGED') {
        this.d.submit({ ...base, id: `pr:${t.ticketId}:${pr.number}:merged`, type: 'pr.merged', payload });
        continue;
      }
      if (pr.state === 'CLOSED') {
        this.d.submit({ ...base, id: `pr:${t.ticketId}:${pr.number}:closed`, type: 'pr.closed', payload });
        continue;
      }
      const metaKey = `checks:${t.projectId}:${t.ticketId}`;
      if ((pr.checks === 'pass' || pr.checks === 'fail') && this.d.store.getMeta(metaKey) !== pr.checks) {
        this.d.store.setMeta(metaKey, pr.checks);
        const id = `pr:${t.ticketId}:${pr.number}:checks:${pr.checks}:${at}`;
        if (pr.checks === 'fail') this.d.submit({ ...base, id, type: 'pr.checks_failed', payload: { ...payload, failures: pr.failedChecks } });
        else this.d.submit({ ...base, id, type: 'pr.checks_passed', payload });
      }
    }
  }

  start(intervalMs = 30_000): void {
    this.stop();
    this.handle = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.pollOnce().finally(() => (this.running = false));
    }, intervalMs);
  }

  stop(): void {
    if (this.handle) clearInterval(this.handle);
    this.handle = undefined;
  }
}
