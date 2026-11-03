import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { ContainerSandboxProvider } from '../adapters/sandbox/docker-rootless.js';
import { SandboxRouter } from '../adapters/sandbox/router.js';
import type { SandboxProvider } from '../adapters/sandbox/types.js';
import type { EgressProxy } from '../network/proxy.js';

/** A daemon's id on a shared engine, from its home: two daemons never see (nor reap) each other's containers. */
export function instanceId(home: string): string {
  return createHash('sha256').update(resolve(home)).digest('hex').slice(0, 12);
}

/**
 * The sandboxes of real runs (ORC-204): a container per attempt when FACTORY_CONTAINER_CLI is set, none
 * otherwise. Each reaches out only through `egress`, the daemon's proxy (ORC-213).
 */
export function makeSandboxes(env: NodeJS.ProcessEnv, instance: string, egress: EgressProxy): SandboxProvider | undefined {
  const cli = env['FACTORY_CONTAINER_CLI'];
  if (!cli) return undefined;
  if (cli !== 'docker' && cli !== 'podman') throw new Error(`FACTORY_CONTAINER_CLI=${cli} : docker ou podman attendu.`);
  const image = env['FACTORY_RUNNER_IMAGE'];
  if (!image) throw new Error('FACTORY_RUNNER_IMAGE est requis avec FACTORY_CONTAINER_CLI.');
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error('Les sandboxes exigent un démon sous Linux (uid et gid).');
  return new SandboxRouter([
    {
      name: 'container',
      provider: new ContainerSandboxProvider({ cli, image, uid, gid, instance, egress }),
      capabilities: { level: 'L3', browser: false, services: [] },
    },
  ]);
}
