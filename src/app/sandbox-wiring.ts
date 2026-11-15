import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { execCmd, type Exec } from '../adapters/exec.js';
import { CONTAINER_SERVICES, ContainerSandboxProvider, defaultLimits, type SandboxLimits } from '../adapters/sandbox/docker-rootless.js';
import { SandboxRouter } from '../adapters/sandbox/router.js';
import type { SandboxProvider } from '../adapters/sandbox/types.js';
import type { Egress } from '../network/proxy-service.js';

/** A daemon's id on a shared engine, from its home: two daemons never see (nor reap) each other's containers. */
export function instanceId(home: string): string {
  return createHash('sha256').update(resolve(home)).digest('hex').slice(0, 12);
}

/**
 * Without a container engine, an agent would run on the host under the daemon's user, next to its secrets: the daemon
 * refuses to start real runs so, unless `FACTORY_ALLOW_HOST_RUNS=1` chooses it, for development (ORC-349).
 */
export function checkHostRuns(env: NodeJS.ProcessEnv): void {
  if (env['FACTORY_CONTAINER_CLI'] || env['FACTORY_ALLOW_HOST_RUNS'] === '1') return;
  throw new Error(
    'FACTORY_CONTAINER_CLI is not set: the agents would run on this machine, under the daemon\'s user, without isolation. ' +
      'Set FACTORY_CONTAINER_CLI (docker or podman) and FACTORY_RUNNER_IMAGE, or FACTORY_ALLOW_HOST_RUNS=1 to run them on the host anyway (development only).',
  );
}

/**
 * The sandboxes of real runs (ORC-204): a container per attempt when FACTORY_CONTAINER_CLI is set, none
 * otherwise. Each reaches out only through `egress`, the factory's proxy (ORC-213).
 */
export function makeSandboxes(env: NodeJS.ProcessEnv, instance: string, egress: Egress, o: { browserImage?: string; exec?: Exec } = {}): SandboxProvider | undefined {
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
      provider: new ContainerSandboxProvider({
        cli, image, uid, gid, instance, limits: sandboxLimits(env), egress,
        ...(env['FACTORY_POSTGRES_IMAGE'] ? { postgresImage: env['FACTORY_POSTGRES_IMAGE'] } : {}),
        ...(o.browserImage ? { browserImage: o.browserImage } : {}),
        ...(o.exec ? { exec: o.exec } : {}),
      }),
      capabilities: { level: 'L3', browser: !!o.browserImage, services: CONTAINER_SERVICES },
    },
  ]);
}

/** The label docker/browser.Dockerfile puts on the capture image, Playwright's version as its value. */
export const BROWSER_LABEL = 'factory.browser';

/**
 * The capture image of the visual proof (ORC-404): `FACTORY_BROWSER_IMAGE`, when the engine has it and it carries the label
 * of docker/browser.Dockerfile, so that the runner's image named there by mistake is no browser. `detail` says why for
 * the start's log and `factory doctor`. Without it, a required proof stays unavailable, indicative.
 */
export async function browserImage(env: NodeJS.ProcessEnv, run: Exec = execCmd): Promise<{ image?: string; detail: string }> {
  const cli = env['FACTORY_CONTAINER_CLI'];
  if (!cli) return { detail: 'no sandboxes (FACTORY_CONTAINER_CLI is not set)' };
  const image = env['FACTORY_BROWSER_IMAGE'];
  if (!image) return { detail: 'FACTORY_BROWSER_IMAGE is not set (see docker/browser.Dockerfile)' };
  const r = await run(cli, ['image', 'inspect', '--format', `{{index .Config.Labels "${BROWSER_LABEL}"}}`, image], { timeoutMs: 60_000 });
  if (r.code !== 0) return { detail: `the engine has no image ${image}: ${r.stderr.trim().slice(-500)}` };
  const label = r.stdout.trim();
  // A label the image lacks prints as `<no value>` under Docker, empty under Podman.
  if (!label || label === '<no value>') return { detail: `${image} is not a capture image: no label ${BROWSER_LABEL} (see docker/browser.Dockerfile)` };
  return { image, detail: `the captures run in ${image} (${label})` };
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
