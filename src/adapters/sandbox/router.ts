import type { ExecResult } from '../exec.js';
import type { IsolationLevel, Sandbox, SandboxExecOptions, SandboxProvider, SandboxRequest, SandboxRequirements, SpawnCommand } from './types.js';

export interface SandboxBackend {
  name: string;
  provider: SandboxProvider;
  capabilities: { level: IsolationLevel; browser: boolean; services: readonly string[] };
}

const RANK: Record<IsolationLevel, number> = { L3: 3, L4: 4, L5: 5 };

/** What `b` lacks of `req`, in the words of the refusal; empty when it satisfies all of it. */
function unmet(b: SandboxBackend, req: SandboxRequirements): string[] {
  const { level, browser, services } = b.capabilities;
  return [
    ...(RANK[level] < RANK[req.minLevel] ? [`level >= ${req.minLevel}`] : []),
    ...(req.browser && !browser ? ['browser'] : []),
    ...req.services.filter((s) => !services.includes(s)).map((s) => `service ${s}`),
  ];
}

/**
 * Picks the backend of each sandbox from the requirements (ORC-204), and refuses when none satisfies
 * them: a weaker backend is never a fallback. Each id goes back to the backend that made it.
 */
export class SandboxRouter implements SandboxProvider {
  /** In memory only: after a daemon restart, `list` and `findByAttempt` fill it again from the backends. */
  private owner = new Map<string, SandboxBackend>();

  /** Those of any backend (ORC-282): a request naming another is refused, whatever else it asks. */
  readonly services: readonly string[];

  constructor(private readonly backends: readonly SandboxBackend[]) {
    this.services = [...new Set(backends.flatMap((b) => b.capabilities.services))];
  }

  async create(req: SandboxRequest): Promise<Sandbox> {
    // A replayed create can land after a restart, or after the backend list changed: the run's sandbox wins.
    const existing = await this.findByAttempt(req.runId);
    // Never handed back if it is not what was asked: the run would get another network or a weaker isolation.
    if (existing) {
      const b = this.owner.get(existing.id)!;
      if (existing.network !== req.network) throw new Error(`sandbox of ${req.runId} has network ${existing.network}, asked ${req.network}`);
      const missing = unmet(b, req.requirements);
      if (missing.length) throw new Error(`sandbox of ${req.runId} does not satisfy the requirements: ${b.name} lacks ${missing.join(', ')}`);
      // Its services are the backend's to give back (ORC-309): `findByAttempt` does not.
      return req.requirements.services.length ? this.remember(await b.provider.create(req), b) : existing;
    }
    const chosen = this.backends.find((b) => unmet(b, req.requirements).length === 0);
    if (!chosen) {
      const why = this.backends.map((b) => `${b.name} lacks ${unmet(b, req.requirements).join(', ')}`).join('; ');
      throw new Error(`no sandbox backend satisfies the requirements of ${req.runId}: ${why || 'no backend'}`);
    }
    return this.remember(await chosen.provider.create(req), chosen);
  }

  /** Its services are a target of `exec` and `destroy` too (ORC-309). */
  private remember(sandbox: Sandbox, b: SandboxBackend): Sandbox {
    this.owner.set(sandbox.id, b);
    if (sandbox.services) this.owner.set(sandbox.services, b);
    return sandbox;
  }

  async exec(id: string, argv: readonly string[], opts?: SandboxExecOptions): Promise<ExecResult> {
    return this.ownerOf(id).provider.exec(id, argv, opts);
  }

  spawnCommand(id: string, argv: readonly string[], opts?: SandboxExecOptions): SpawnCommand {
    return this.ownerOf(id).provider.spawnCommand(id, argv, opts);
  }

  findByAttempt(runId: string): Promise<Sandbox | undefined> {
    return this.firstOwned((p) => p.findByAttempt(runId));
  }

  reattach(runId: string): Promise<Sandbox | undefined> {
    return this.firstOwned((p) => p.reattach(runId));
  }

  /** The first backend's answer, remembered as the owner of that sandbox. */
  private async firstOwned(ask: (provider: SandboxProvider) => Promise<Sandbox | undefined>): Promise<Sandbox | undefined> {
    for (const b of this.backends) {
      const sandbox = await ask(b.provider);
      if (!sandbox) continue;
      this.owner.set(sandbox.id, b);
      return sandbox;
    }
    return undefined;
  }

  async list(): Promise<{ runId: string; sandbox: Sandbox }[]> {
    const all = [];
    for (const b of this.backends) {
      for (const l of await b.provider.list()) {
        this.owner.set(l.sandbox.id, b);
        all.push(l);
      }
    }
    return all;
  }

  async destroy(id: string): Promise<void> {
    const b = this.owner.get(id);
    if (!b) return;
    await b.provider.destroy(id);
    this.owner.delete(id);
  }

  private ownerOf(id: string): SandboxBackend {
    const b = this.owner.get(id);
    if (!b) throw new Error(`unknown sandbox ${id}`);
    return b;
  }
}
