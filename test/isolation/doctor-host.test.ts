import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execCmd, type Exec } from '../../src/adapters/exec.js';
import { checkHost } from '../../src/cli/doctor.js';
import { podmanCli } from '../../src/adapters/sandbox/docker-rootless.js';
import { enabled, image, podman } from './helpers.js';

/**
 * `doctor`'s host check on the real engines (ORC-427), not on the fakes of src/cli/doctor.test.ts: the fields it reads of
 * `podman info` and `docker info` exist and never claim a controller the cgroup tree lacks.
 * - Rootless Podman: never a controller its user's systemd session is not delegated, accepted on the CI's host; that the
 *   limits then apply is isolation n° 9's.
 * - The `docker` CLI on that Podman's socket (the compat API): never a controller the user lacks, never accepted where
 *   Podman itself is refused.
 * - The runner's rootful Docker, when it answers: never a controller the root cgroup lacks, and the limits applied when accepted.
 * Not covered: a host without `cpu` delegated. Taking it from the user's session means restarting `user@.service`, under
 * the engine the other isolation tests run on in parallel; the refusal stays tested on fakes only (docs/tests.md).
 */
const LIMITS = ['--network', 'none', '--cpus', '0.5', '--memory', '64m', '--pids-limit', '64'];
/** The cgroup files of those limits, as a container reads them: `cpu.max`, `memory.max`, `pids.max`. */
const APPLIED = ['50000 100000', String(64 * 1024 ** 2), '64'];
const READ_LIMITS = ['cat', '/sys/fs/cgroup/cpu.max', '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/pids.max'];
const ROOTFUL_DOCKER = 'unix:///var/run/docker.sock';
/** Tiny, so the rootful Docker's pull costs little; the other tests' image lives in Podman's store. */
const DOCKER_IMAGE = 'docker.io/library/busybox:1.37.0';

const uid = process.getuid?.() ?? 0;
const run = (cmd: string, args: string[], env: Record<string, string> = {}): string =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env } }).trim();
/** `docker` on `host`, whatever DOCKER_HOST the machine sets. */
const dockerOn = (host: string): Exec => (cmd, args, opts) => execCmd(cmd, args, { ...opts, env: { ...opts?.env, DOCKER_HOST: host } });
const controllersOf = (file: string): string[] => readFileSync(file, 'utf8').trim().split(/\s+/).filter(Boolean);
const answers = (fn: () => unknown): boolean => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};
/** `docker info` on `host`, with the fields `dockerCgroups` reads checked; undefined when the engine does not answer. */
function dockerInfo(host: string): Record<string, unknown> | undefined {
  let info: Record<string, unknown>;
  try {
    info = JSON.parse(run('docker', ['info', '--format', '{{json .}}'], { DOCKER_HOST: host })) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  for (const field of ['CpuCfsQuota', 'MemoryLimit', 'PidsLimit']) expect(typeof info[field], `${field} in docker info on ${host}`).toBe('boolean');
  expect(info['CgroupVersion']).toBe('2');
  expect(Array.isArray(info['SecurityOptions'])).toBe(true);
  return info;
}
/** Each controller `doctor` was told of is one `file` lists. */
function expectWithin(controllers: string[] | undefined, file: string, engine: string): void {
  const listed = controllersOf(file);
  for (const controller of controllers ?? []) expect(listed, `${engine} says ${controller}, ${file} does not`).toContain(controller);
}

describe.skipIf(!enabled || !podman)("doctor's host check on the real rootless Podman (ORC-427)", () => {
  /** The controllers systemd delegates to the user's session: what a rootless engine can limit through. */
  const delegatedFile = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`;

  it("reads the fields doctor reads, never a controller the user's session lacks, and accepts the CI's host", async () => {
    const info = JSON.parse(run('podman', ['info', '--format', 'json'])) as { host: Record<string, any> };
    expect(info.host).toMatchObject({ cgroupVersion: 'v2', cgroupManager: 'systemd', security: { rootless: true } });
    expect(Array.isArray(info.host['cgroupControllers'])).toBe(true);
    expect(existsSync(delegatedFile), `${delegatedFile}: no systemd session for uid ${uid}`).toBe(true);

    const report = await checkHost({ FACTORY_CONTAINER_CLI: 'podman', FACTORY_RUNNER_IMAGE: image });
    // Podman reads the controllers of its own process's cgroup, under the session's: a subset of what it delegates.
    expectWithin(report.controllers, delegatedFile, 'podman info');
    expect(report).toMatchObject({ engine: 'podman', cgroupV2: true, rootless: true });
    // The CI's session delegates cpu, memory and pids (isolation n° 9 needs them): accepted.
    expect(report.verdict, report.reasons.join('; ')).toBe('accepted');
  }, 120_000);

  it("the docker CLI on Podman's socket never claims a controller the user lacks, nor accepts what Podman refuses", async (ctx) => {
    if (!answers(() => run('docker', ['--version']))) return ctx.skip('no docker CLI on this host');
    if (await podmanCli(execCmd, 'docker')) return ctx.skip("this host's docker is Podman's shim, which ignores DOCKER_HOST");
    // The socket unit, started if it is not (and stopped after): the compat API answers there.
    const wasActive = answers(() => run('systemctl', ['--user', 'is-active', '--quiet', 'podman.socket']));
    if (!answers(() => run('systemctl', ['--user', 'start', 'podman.socket']))) return ctx.skip('podman.socket does not start in this session');
    if (!wasActive) ctx.onTestFinished(() => void answers(() => run('systemctl', ['--user', 'stop', 'podman.socket'])));
    // A path, or already a URI on some Podman versions.
    const host = `unix://${run('podman', ['info', '--format', '{{.Host.RemoteSocket.Path}}']).replace(/^unix:\/\//, '')}`;
    const info = dockerInfo(host);
    expect(info, `docker info on Podman's socket ${host}`).toBeDefined();

    const [compat, native] = await Promise.all([checkHost({ FACTORY_CONTAINER_CLI: 'docker', FACTORY_RUNNER_IMAGE: image }, dockerOn(host)), checkHost({ FACTORY_CONTAINER_CLI: 'podman', FACTORY_RUNNER_IMAGE: image })]);
    // Seen in the job's log: how the compat API tells the same engine (an under-report only refuses a good host).
    console.info(`ORC-427 compat API: ${JSON.stringify({ compat, native, CgroupDriver: info?.['CgroupDriver'], SecurityOptions: info?.['SecurityOptions'] })}`);
    expect(compat.engine).toBe('docker');
    expectWithin(compat.controllers, delegatedFile, "the compat API's docker info");
    if (compat.verdict === 'accepted') expect(native.verdict, native.reasons.join('; ')).toBe('accepted');
  }, 120_000);
});

describe.skipIf(!enabled)("doctor's host check on the runner's rootful Docker (ORC-427)", () => {
  it('reads the flags doctor reads, never a controller the host lacks, and an accepted host applies the limits', async (ctx) => {
    if (!existsSync(ROOTFUL_DOCKER.slice('unix://'.length)) || !answers(() => run('docker', ['--version']))) return ctx.skip(`no rootful Docker at ${ROOTFUL_DOCKER}`);
    if (!dockerInfo(ROOTFUL_DOCKER)) return ctx.skip(`the Docker at ${ROOTFUL_DOCKER} does not answer`);

    const report = await checkHost({ FACTORY_CONTAINER_CLI: 'docker', FACTORY_RUNNER_IMAGE: image }, dockerOn(ROOTFUL_DOCKER));
    console.info(`ORC-427 rootful Docker: ${JSON.stringify(report)}`);
    expect(report).toMatchObject({ engine: 'docker', cgroupV2: true, rootless: false });
    expectWithin(report.controllers, '/sys/fs/cgroup/cgroup.controllers', 'docker info');
    // Docker reads its flags in its own cgroup parent, which systemd may give fewer controllers than the root: a refusal
    // there is a false alarm, logged above; an acceptance must hold.
    if (report.verdict === 'accepted') {
      expect(run('docker', ['run', '--rm', ...LIMITS, DOCKER_IMAGE, ...READ_LIMITS], { DOCKER_HOST: ROOTFUL_DOCKER }).split('\n')).toEqual(APPLIED);
    }
  }, 300_000);
});
