import type { ExecResult } from '../exec.js';
import type { Sandbox, SandboxExecOptions, SandboxProvider, SandboxRequest, SpawnCommand } from './types.js';

export class FakeSandboxProvider implements SandboxProvider {
  created: SandboxRequest[] = [];
  destroyed: string[] = [];
  execs: { id: string; argv: string[]; opts?: SandboxExecOptions }[] = [];
  /** What `exec` answers; a test scripts it to fail a `setup`. */
  execResult: (argv: readonly string[]) => ExecResult = () => ({ stdout: '', stderr: '', code: 0 });
  /** Keyed by run, like a container labelled with its attempt id: a replayed create finds it. */
  private live = new Map<string, Sandbox>();
  private made = 0;

  async create(req: SandboxRequest): Promise<Sandbox> {
    this.created.push(req);
    const existing = this.live.get(req.runId);
    if (existing) return { ...existing };
    const sandbox: Sandbox = { id: `sbx-${++this.made}`, network: req.network, level: 'L3' };
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

  async list(): Promise<{ runId: string; sandbox: Sandbox }[]> {
    return [...this.live].map(([runId, s]) => ({ runId, sandbox: { ...s } }));
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

  private known(id: string): void {
    if (![...this.live.values()].some((s) => s.id === id)) throw new Error(`unknown sandbox ${id}`);
  }
}
