import type { ExecResult } from '../exec.js';
import type { Sandbox, SandboxExecOptions, SandboxProvider, SandboxRequest, SpawnCommand } from './types.js';

export class FakeSandboxProvider implements SandboxProvider {
  /** The container backend's (ORC-309); a test sets fewer to have a service refused (ORC-282). */
  services: readonly string[] = ['postgres'];
  created: SandboxRequest[] = [];
  destroyed: string[] = [];
  execs: { id: string; argv: string[]; opts?: SandboxExecOptions }[] = [];
  /** What `exec` answers; a test scripts it to fail a `setup`. */
  execResult: (argv: readonly string[]) => ExecResult = () => ({ stdout: '', stderr: '', code: 0 });
  /** Keyed by run, like a container labelled with its attempt id: a replayed create finds it. */
  private live = new Map<string, Sandbox>();
  /** The services (ORC-309) by the key they serve (`servicesOf`), as their own containers: alive until their owner or they are destroyed. */
  private serving = new Map<string, string>();
  private made = 0;
  private madeServices = 0;

  unprovided(services: readonly string[]): string[] {
    return services.filter((s) => !this.services.includes(s));
  }

  async create(req: SandboxRequest): Promise<Sandbox> {
    const unknown = this.unprovided(req.requirements.services);
    if (unknown.length) throw new Error(`fake sandbox: no services (${unknown.join(', ')})`);
    this.created.push(req);
    const existing = this.live.get(req.runId);
    if (existing) return { ...existing };
    const sandbox: Sandbox = { id: `sbx-${++this.made}`, network: req.network, level: 'L3' };
    if (req.requirements.services.length) {
      const key = req.servicesOf ?? req.runId;
      if (!this.serving.has(key)) this.serving.set(key, `svc-${++this.madeServices}`);
      sandbox.services = this.serving.get(key)!;
    }
    this.live.set(req.runId, sandbox);
    return { ...sandbox };
  }

  async exec(id: string, argv: readonly string[], opts?: SandboxExecOptions): Promise<ExecResult> {
    this.known(id);
    this.execs.push({ id, argv: [...argv], ...(opts ? { opts } : {}) });
    return this.execResult(argv);
  }

  /** Runs `argv` on the host as is: the fake isolates nothing. */
  spawnCommand(id: string, argv: readonly string[], opts?: SandboxExecOptions): SpawnCommand {
    this.known(id);
    return { command: [...argv], env: opts?.env ?? {} };
  }

  async findByAttempt(runId: string): Promise<Sandbox | undefined> {
    const s = this.live.get(runId);
    return s && { ...s };
  }

  reattach(runId: string): Promise<Sandbox | undefined> {
    return this.findByAttempt(runId);
  }

  async list(): Promise<{ runId: string; sandbox: Sandbox }[]> {
    return [
      ...[...this.live].map(([runId, s]) => ({ runId, sandbox: { ...s } })),
      ...[...this.serving].map(([runId, id]) => ({ runId, sandbox: { id, network: 'none' as const, level: 'L3' as const } })),
    ];
  }

  /** A sandbox whose `runId` keys services takes them with it, as the container backend does. */
  async destroy(id: string): Promise<void> {
    for (const [runId, s] of this.live) {
      if (s.id !== id) continue;
      this.live.delete(runId);
      this.destroyed.push(id);
      this.dropServices((key) => key === runId);
    }
    this.dropServices((_, svc) => svc === id);
  }

  active(): Sandbox[] {
    return [...this.live.values()].map((s) => ({ ...s }));
  }

  /** The ids of the live services (ORC-309). */
  activeServices(): string[] {
    return [...this.serving.values()];
  }

  private dropServices(which: (key: string, id: string) => boolean): void {
    for (const [key, svc] of this.serving) {
      if (!which(key, svc)) continue;
      this.serving.delete(key);
      this.destroyed.push(svc);
    }
  }

  private known(id: string): void {
    if (![...this.live.values()].some((s) => s.id === id) && !this.activeServices().includes(id)) throw new Error(`unknown sandbox ${id}`);
  }
}
