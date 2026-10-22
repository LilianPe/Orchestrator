import type { Sandbox, SandboxProvider, SandboxRequest } from './types.js';

export class FakeSandboxProvider implements SandboxProvider {
  created: SandboxRequest[] = [];
  destroyed: string[] = [];
  /** Keyed by run, like a container labelled with its attempt id: a replayed create finds it. */
  private live = new Map<string, Sandbox>();
  private made = 0;

  async create(req: SandboxRequest): Promise<Sandbox> {
    this.created.push(req);
    const existing = this.live.get(req.runId);
    if (existing) return { ...existing };
    const sandbox = { id: `sbx-${++this.made}`, network: req.network };
    this.live.set(req.runId, sandbox);
    return { ...sandbox };
  }

  async destroy(id: string): Promise<void> {
    for (const [runId, s] of this.live) {
      if (s.id !== id) continue;
      this.live.delete(runId);
      this.destroyed.push(id);
    }
  }

  active(): Sandbox[] {
    return [...this.live.values()].map((s) => ({ ...s }));
  }
}
