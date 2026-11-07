import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { ContainerSandboxProvider, defaultLimits, type SandboxLimits } from '../adapters/sandbox/docker-rootless.js';
import { SandboxRouter } from '../adapters/sandbox/router.js';
import type { SandboxProvider } from '../adapters/sandbox/types.js';
import type { Egress } from '../network/proxy-service.js';

/** A daemon's id on a shared engine, from its home: two daemons never see (nor reap) each other's containers. */
export function instanceId(home: string): string {
  return createHash('sha256').update(resolve(home)).digest('hex').slice(0, 12);
}

/**
 * The sandboxes of real runs (ORC-204): a container per attempt when FACTORY_CONTAINER_CLI is set, none
 * otherwise. Each reaches out only through `egress`, the factory's proxy (ORC-213).
 */
export function makeSandboxes(env: NodeJS.ProcessEnv, instance: string, egress: Egress): SandboxProvider | undefined {
  const cli = env['FACTORY_CONTAINER_CLI'];
  if (!cli) return undefined;
  if (cli !== 'docker' && cli !== 'podman') throw new Error(`FACTORY_CONTAINER_CLI=${cli}: docker or podman expected.`);
  const image = env['FACTORY_RUNNER_IMAGE'];
  if (!image) throw new Error('FACTORY_RUNNER_IMAGE is required with FACTORY_CONTAINER_CLI.');
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error('The sandboxes require a daemon on Linux (uid and gid).');
  return new SandboxRouter([
    {
      name: 'container',
      provider: new ContainerSandboxProvider({ cli, image, uid, gid, instance, limits: sandboxLimits(env), egress }),
      capabilities: { level: 'L3', browser: false, services: [] },
    },
  ]);
}

/** Each limit of the attempt containers: unset, the default; `0` or `none`, left out (a host whose cgroups lack the controller). */
export function sandboxLimits(env: NodeJS.ProcessEnv): SandboxLimits {
  const d = defaultLimits();
  return {
    pids: limit(env, 'FACTORY_SANDBOX_PIDS', /^[1-9]\d*$/, 'a whole number of processes', d.pids, Number),
    memory: limit(env, 'FACTORY_SANDBOX_MEMORY', /^[1-9]\d*[bkmg]?$/i, 'a size such as 4g or 512m', d.memory, String),
    cpus: limit(env, 'FACTORY_SANDBOX_CPUS', /^(\d+|\d*\.\d+)$/, 'a number of CPUs such as 2 or 0.5', d.cpus, Number),
  };
}

function limit<T>(env: NodeJS.ProcessEnv, name: string, ok: RegExp, hint: string, def: T | undefined, cast: (v: string) => T): T | undefined {
  const v = env[name]?.trim();
  if (!v) return def;
  if (/^(0|none)$/i.test(v)) return undefined;
  if (!ok.test(v) || !(Number.parseFloat(v) > 0)) throw new Error(`${name}=${v}: ${hint} expected, or 0 / none for no limit.`);
  return cast(v);
}
