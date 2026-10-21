import type { Sandbox, SandboxProvider, SandboxRequest } from './types.js';

export class FakeSandboxProvider implements SandboxProvider {
  created: SandboxRequest[] = [];
  destroyed: string[] = [];
  private live = new Map<string, Sandbox>();

  async create(req: SandboxRequest): Promise<Sandbox> {
    this.created.push(req);
    const sandbox = { id: `sbx-${this.created.length}`, network: req.network };
    this.live.set(sandbox.id, sandbox);
    return sandbox;
  }

  async destroy(id: string): Promise<void> {
    if (this.live.delete(id)) this.destroyed.push(id);
  }

  active(): Sandbox[] {
    return [...this.live.values()];
  }
}
