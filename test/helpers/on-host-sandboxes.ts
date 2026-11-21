import { execCmd, type ExecResult } from '../../src/adapters/exec.js';
import { FakeSandboxProvider } from '../../src/adapters/sandbox/fake.js';
import type { SandboxExecOptions, SpawnCommand } from '../../src/adapters/sandbox/types.js';

/** The one sandbox `OnHostSandboxes` knows, none created: any other id is unknown, as a sandbox gone. */
export const ON_HOST = 'sbx-on-host';

/**
 * A test's sandboxes that isolate nothing: `spawnCommand` and `exec` run on the test's machine, in their `cwd`. The
 * runner reaches `claude` only through a `SandboxProvider` (ORC-179); this one lets its tests drive a fake CLI, never the factory.
 */
export class OnHostSandboxes extends FakeSandboxProvider {
  override spawnCommand(id: string, argv: readonly string[], opts?: SandboxExecOptions): SpawnCommand {
    if (id !== ON_HOST) throw new Error(`unknown sandbox ${id}`);
    // In `cwd`, as an engine's `exec -w`: the runner spawns the engine's CLI from the daemon's folder, never the run's.
    const command = opts?.cwd ? ['sh', '-c', 'cd -- "$1" && shift && exec "$@"', 'sh', opts.cwd, ...argv] : [...argv];
    return { command, env: opts?.env ?? {} };
  }

  override async exec(id: string, argv: readonly string[], opts?: SandboxExecOptions): Promise<ExecResult> {
    if (id !== ON_HOST) throw new Error(`unknown sandbox ${id}`);
    return execCmd(argv[0]!, argv.slice(1), { ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
  }
}
