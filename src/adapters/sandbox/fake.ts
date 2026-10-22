import type { Sandbox, SandboxProvider, SandboxRequest } from './types.js';

export class FakeSandboxProvider implements SandboxProvider {
  created: SandboxRequest[] = [];
  destroyed: string[] = [];
  private live = new Map<string, Sandbox & { runId: string }>();
  private made = 0;

  /** Keyed by run, like a container labelled with its attempt id: a replayed create finds it. */
  async create(req: SandboxRequest): Promise<Sandbox> {
    this.created.push(req);
    const existing = [...this.live.values()].find((s) => s.runId === req.runId);
    if (existing) return { id: existing.id, network: existing.network };
    const sandbox = { id: `sbx-${++this.made}`, network: req.network };
    this.live.set(sandbox.id, { ...sandbox, runId: req.runId });
    return sandbox;
  }

  async destroy(id: string): Promise<void> {
    if (this.live.delete(id)) this.destroyed.push(id);
  }

  active(): Sandbox[] {
    return [...this.live.values()].map(({ id, network }) => ({ id, network }));
  }
}
