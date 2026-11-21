import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { execCmd, mustExec, type Exec } from '../adapters/exec.js';
import { CONTAINER_SERVICES, ContainerSandboxProvider, defaultLimits, type SandboxLimits } from '../adapters/sandbox/docker-rootless.js';
import { SandboxRouter } from '../adapters/sandbox/router.js';
import type { SandboxProvider } from '../adapters/sandbox/types.js';
import type { Egress } from '../network/proxy-service.js';

/** A daemon's id on a shared engine, from its home: two daemons never see (nor reap) each other's containers. */
export function instanceId(home: string): string {
  return createHash('sha256').update(resolve(home)).digest('hex').slice(0, 12);
}

/** What the sandboxes run with, as `sandboxConfig` checked it. */
interface SandboxConfig {
  cli: 'docker' | 'podman';
  image: string;
  uid: number;
  gid: number;
  limits: SandboxLimits;
}

/**
 * What the sandboxes run with (ORC-204), `FACTORY_CONTAINER_CLI` and `FACTORY_RUNNER_IMAGE`, the daemon's uid and gid and
 * the `FACTORY_SANDBOX_*` limits: none without the CLI, or the start's refusal, with its message: another CLI than docker or
 * podman, no runner image, no uid or gid, a limit `sandboxLimits` refuses (`cli` kept, the engine still askable, ORC-450).
 */
export function sandboxConfig(env: NodeJS.ProcessEnv): SandboxConfig | { cli?: 'docker' | 'podman'; refusal: string } | undefined {
  const cli = containerCli(env);
  if (!cli) return undefined;
  if (typeof cli !== 'string') return { refusal: `${cli.refused}.` };
  const image = env['FACTORY_RUNNER_IMAGE'];
  if (!image) return { cli, refusal: 'FACTORY_RUNNER_IMAGE is required with FACTORY_CONTAINER_CLI.' };
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return { cli, refusal: 'The sandboxes require a daemon on Linux (uid and gid).' };
  const limits = sandboxLimits(env);
  return 'refused' in limits ? { cli, refusal: limits.refused } : { cli, image, uid, gid, limits };
}

/**
 * The daemon's environment the start refuses, for the start and `factory doctor`'s host check alike (ORC-449), each with the
 * start's message: `sandboxConfig`'s refusal (a limit or the uid/gid too, ORC-450), or no container engine at all. An agent
 * runs in a sandbox or not at all: there is no run on the host any more (ORC-179).
 */
export function sandboxRefusals(env: NodeJS.ProcessEnv): string[] {
  const sandbox = sandboxConfig(env);
  if (sandbox) return 'refusal' in sandbox ? [sandbox.refusal] : [];
  return [
    'FACTORY_CONTAINER_CLI is not set: the agents run only in a rootless container, there is no run on this machine. ' +
      'Set FACTORY_CONTAINER_CLI (podman, or docker) and FACTORY_RUNNER_IMAGE (docs/first-run.md).',
  ];
}

/** The start's `sandboxRefusals`, before anything opens: the first one throws. */
export function checkSandboxes(env: NodeJS.ProcessEnv): void {
  const [refusal] = sandboxRefusals(env);
  if (refusal) throw new Error(refusal);
}

/**
 * The sandboxes of real runs (ORC-204): a container per attempt, from FACTORY_CONTAINER_CLI. Each reaches out only
 * through `egress`, the factory's proxy (ORC-213). Without an engine it throws, as the start did before anything opened (`checkSandboxes`).
 */
export function makeSandboxes(env: NodeJS.ProcessEnv, instance: string, egress: Egress, o: { browserImage?: string; exec?: Exec } = {}): SandboxProvider {
  const sandbox = sandboxConfig(env);
  if (!sandbox || 'refusal' in sandbox) throw new Error(sandboxRefusals(env)[0]);
  return new SandboxRouter([
    {
      name: 'container',
      provider: new ContainerSandboxProvider({
        ...sandbox, instance, egress,
        ...(env['FACTORY_POSTGRES_IMAGE'] ? { postgresImage: env['FACTORY_POSTGRES_IMAGE'] } : {}),
        ...(o.browserImage ? { browserImage: o.browserImage } : {}),
        ...(o.exec ? { exec: o.exec } : {}),
      }),
      capabilities: { level: 'L3', browser: !!o.browserImage, services: CONTAINER_SERVICES },
    },
  ]);
}

/** `FACTORY_CONTAINER_CLI`: none without sandboxes, or the reason another CLI is refused. */
export function containerCli(env: NodeJS.ProcessEnv): 'docker' | 'podman' | { refused: string } | undefined {
  const cli = env['FACTORY_CONTAINER_CLI'];
  if (!cli) return undefined;
  return cli === 'docker' || cli === 'podman' ? cli : { refused: `FACTORY_CONTAINER_CLI=${cli}: docker or podman expected` };
}

/** The label docker/browser.Dockerfile puts on the capture image, Playwright's version as its value. */
export const BROWSER_LABEL = 'factory.browser';

/**
 * The capture image of the visual proof (ORC-404): `FACTORY_BROWSER_IMAGE`, when the engine has it, it carries the label of
 * docker/browser.Dockerfile (the runner's image named there by mistake is no browser), and it was built on the runner image
 * the commands run in (one left from before the runner's update would start the application with other tools). `detail`
 * says why for the start's log and `factory doctor`; it never rejects. Without it, a required proof stays unavailable, indicative.
 */
export async function browserImage(env: NodeJS.ProcessEnv, run: Exec = execCmd): Promise<{ image?: string; detail: string }> {
  const cli = containerCli(env);
  if (!cli) return { detail: 'no sandboxes (FACTORY_CONTAINER_CLI is not set)' };
  if (typeof cli !== 'string') return { detail: cli.refused };
  const image = env['FACTORY_BROWSER_IMAGE'];
  if (!image) return { detail: 'FACTORY_BROWSER_IMAGE is not set (see docker/browser.Dockerfile)' };
  const inspect = async (img: string, format: string): Promise<{ out: string } | { error: string }> => {
    try {
      return { out: (await mustExec(run, cli, ['image', 'inspect', '--format', format, img], { timeoutMs: 60_000 })).trimEnd() };
    } catch (err) {
      // An engine that fails as one that cannot be run: said, never thrown.
      return { error: (err as Error).message.slice(0, 600) };
    }
  };
  const own = await inspect(image, `{{index .Config.Labels "${BROWSER_LABEL}"}}\t{{json .RootFS.Layers}}`);
  if ('error' in own) return { detail: own.error };
  const [label = '', layers = '[]'] = own.out.split('\t');
  // A label the image lacks prints as `<no value>` under Docker, empty under Podman: the line then starts with the tab, kept by `trimEnd`.
  if (!label || label === '<no value>') return { detail: `${image} is not a capture image: no label ${BROWSER_LABEL} (see docker/browser.Dockerfile)` };
  const runner = env['FACTORY_RUNNER_IMAGE'];
  if (runner) {
    const base = await inspect(runner, '{{json .RootFS.Layers}}');
    if ('error' in base) return { detail: base.error };
    const ours = JSON.parse(layers) as string[];
    const theirs = JSON.parse(base.out) as string[];
    if (!theirs.every((l, i) => ours[i] === l)) return { detail: `${image} was not built on ${runner}: build it again on it (see docker/browser.Dockerfile)` };
  }
  return { image, detail: `the captures run in ${image} (${label})` };
}

/** What the start's log and `factory doctor` say of it. */
export function visualProofLine(v: { image?: string; detail: string }): string {
  return `Visual proof on this instance: ${v.image ? 'available' : 'unavailable'} — ${v.detail}`;
}

/**
 * Each limit of the attempt containers: unset, the default; `0` or `none`, left out (a host whose cgroups lack the controller);
 * or the reasons every malformed one is refused, together (ORC-455).
 */
export function sandboxLimits(env: NodeJS.ProcessEnv): SandboxLimits | { refused: string } {
  const d = defaultLimits();
  const pids = limit(env, 'FACTORY_SANDBOX_PIDS', /^[1-9]\d*$/, 'a whole number of processes', d.pids, Number);
  const memory = limit(env, 'FACTORY_SANDBOX_MEMORY', /^[1-9]\d*[bkmg]?$/i, 'a size such as 4g or 512m', d.memory, String, {
    ok: (v) => bytes(v) >= bytes(MIN_MEMORY),
    hint: `at least ${MIN_MEMORY}`,
  });
  const cpus = limit(env, 'FACTORY_SANDBOX_CPUS', /^(\d+|\d*\.\d+)$/, 'a number of CPUs such as 2 or 0.5', d.cpus, Number);
  if (typeof pids === 'object' || typeof memory === 'object' || typeof cpus === 'object') {
    const refusals = [pids, memory, cpus].flatMap((l) => (typeof l === 'object' ? [l.refused] : []));
    return { refused: refusals.join(' ') };
  }
  return { pids, memory, cpus };
}

function limit<T extends number | string>(
  env: NodeJS.ProcessEnv,
  name: string,
  ok: RegExp,
  hint: string,
  def: T | undefined,
  cast: (v: string) => T,
  floor?: { ok: (v: string) => boolean; hint: string },
): T | undefined | { refused: string } {
  const v = env[name]?.trim();
  if (!v) return def;
  if (/^(0|none)$/i.test(v)) return undefined;
  const refused = (expected: string) => ({ refused: `${name}=${v}: ${expected} expected, or 0 / none for no limit.` });
  if (!ok.test(v) || !(Number.parseFloat(v) > 0)) return refused(hint);
  if (floor && !floor.ok(v)) return refused(floor.hint);
  return cast(v);
}

/** Docker and Podman refuse a `--memory` under 6 MiB: refused at the start, not at the first run (ORC-452). */
const MIN_MEMORY = '6m';
const MEMORY_UNITS: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
const bytes = (size: string): number => Number.parseInt(size, 10) * (MEMORY_UNITS[size.slice(-1).toLowerCase()] ?? 1);
