import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { ContainerSandboxProvider, isPodman, type ContainerSandboxOptions } from '../../src/adapters/sandbox/docker-rootless.js';
import { DEFAULT_REQUIREMENTS, type Sandbox, type SandboxRequest } from '../../src/adapters/sandbox/types.js';

/** The isolation suite's knobs; global-setup.ts pulls the image once per run. */
export const enabled = process.env['FACTORY_ISOLATION'] === '1';
export const cli = process.env['FACTORY_CONTAINER_CLI'] ?? 'podman';
export const podman = isPodman(cli);
// A public image, so the CI need not build docker/runner.Dockerfile: the checks only need sh, perl-base, node and coreutils.
export const image = process.env['FACTORY_RUNNER_IMAGE'] ?? 'docker.io/library/node:24.22.1-bookworm-slim';

/**
 * One provider per file, its containers under a file-wide prefix that afterAll destroys, and fresh
 * workspaces removed with them. Call it at the top of a `describe.skipIf(!enabled)`.
 */
export function useSandboxes(name: string, over: Partial<ContainerSandboxOptions> = {}) {
  const provider = new ContainerSandboxProvider({ cli, image, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000, ...over });
  const prefix = `isolation-${name}-${Date.now()}`;
  const dirs: string[] = [];
  let made = 0;

  afterAll(async () => {
    const ours = (await provider.list()).filter((x) => x.runId.startsWith(prefix));
    await Promise.all(ours.map((x) => provider.destroy(x.sandbox.id)));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }, 120_000);

  const workspace = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'factory-iso-'));
    dirs.push(d);
    return d;
  };
  /** A request for a new run under the file's prefix, on a fresh workspace unless given one. */
  const request = (over: Partial<SandboxRequest> = {}): SandboxRequest => ({
    runId: `${prefix}-${++made}`,
    ticketId: 'ISO-1',
    workspacePath: over.workspacePath ?? workspace(),
    network: 'none',
    requirements: DEFAULT_REQUIREMENTS,
    mounts: [],
    ...over,
  });
  const create = (over: Partial<SandboxRequest> = {}): Promise<Sandbox> => provider.create(request(over));
  /** `sh -c` in the sandbox: stdout trimmed, the exit code kept. */
  const sh = async (id: string, script: string) => {
    const r = await provider.exec(id, ['sh', '-c', script]);
    return { ...r, stdout: r.stdout.trim() };
  };
  return { provider, request, create, sh, workspace };
}
