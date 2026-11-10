import { describe, expect, it } from 'vitest';
import type { EgressPolicy } from '../../network/levels.js';
import type { Exec, ExecResult } from '../exec.js';
import { ContainerSandboxProvider, defaultLimits, POSTGRES_IMAGE } from './docker-rootless.js';
import { DEFAULT_REQUIREMENTS, type SandboxRequest } from './types.js';

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', code: 0 });

/** Podman's global flag, before every subcommand. */
const QUIET = '--log-level=error';
const sub = (args: string[]) => (args[0] === QUIET ? args.slice(1) : args);

/** What `version --format '{{json .Client}}'` prints: Docker's client has `Os` and `Arch`, Podman's `OsArch`. */
const DOCKER_CLIENT = ok('{"Version":"28.2.2","ApiVersion":"1.50","Os":"linux","Arch":"amd64","Context":"default"}\n');
const PODMAN_CLIENT = ok('{"APIVersion":"5.4.0","Version":"5.4.0","GoVersion":"go1.23.6","Built":1739318400,"OsArch":"linux/amd64","Os":"linux"}\n');

/**
 * A scripted engine: `answer` gets the args after the cli (and podman's global flag) and says what the cli prints. Its
 * `version`, out of `calls`, is `client`'s: by default Podman's for a cli named podman, Docker's otherwise.
 */
function engine(answer: (args: string[], env?: Record<string, string>) => ExecResult, client?: ExecResult) {
  const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
  const versions: string[][] = [];
  const exec: Exec = async (cmd, args, opts) => {
    if (args[0] === 'version') {
      versions.push(args);
      return client ?? (/podman/.test(cmd) ? PODMAN_CLIENT : DOCKER_CLIENT);
    }
    calls.push({ cmd, args, ...(opts?.env ? { env: opts.env } : {}) });
    return answer(sub(args), opts?.env);
  };
  return { calls, versions, exec };
}

const req = (over: Partial<SandboxRequest> = {}): SandboxRequest => ({
  runId: 'r1',
  ticketId: 'ORC-1',
  workspacePath: '/home/d/wt/orc-1',
  network: 'none',
  requirements: DEFAULT_REQUIREMENTS,
  mounts: [],
  ...over,
});

const opts = { image: 'factory-runner:1', uid: 1000, gid: 1000 };

/** The proxy as the provider sees it: a socket per run, opened and closed. */
function fakeEgress(live: string[] = []) {
  const opened: { runId: string; policy: EgressPolicy }[] = [];
  const closed: string[] = [];
  const open = new Set(live);
  return {
    opened,
    closed,
    caCertPath: '/home/d/.factory/egress-ca/ca.crt',
    isOpen: (runId: string) => open.has(runId),
    open: async (runId: string, policy: EgressPolicy) => {
      opened.push({ runId, policy });
      open.add(runId);
      return `/home/d/.factory/network/${runId}/egress.sock`;
    },
    close: async (runId: string) => {
      closed.push(runId);
      open.delete(runId);
    },
  };
}
const inspectLine = (id: string, running: boolean, runId: string, network: string, allow = '') => `${id}\t${running}\t${runId}\t${network}\t${allow}\n`;

/** An engine with no container yet: `run` prints the new id. */
const empty = () => engine((a) => (a[0] === 'run' ? ok('c1\n') : ok()));
const runArgs = (calls: { args: string[] }[]) => calls.map((c) => sub(c.args)).find((a) => a[0] === 'run')!;

describe('ContainerSandboxProvider.create', () => {
  it('looks the attempt up by label, then runs a locked-down container under the daemon uid', async () => {
    const e = empty();
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec });
    const sbx = await p.create(req({ mounts: [{ host: '/h/.git', target: '/h/.git', readOnly: true }] }));
    expect(sbx).toEqual({ id: 'c1', network: 'none', level: 'L3' });
    expect(e.calls[0]).toEqual({ cmd: 'docker', args: ['ps', '-a', '-q', '--no-trunc', '--filter', 'label=factory.attempt=r1'] });
    expect(runArgs(e.calls)).toEqual([
      'run', '-d',
      '--label', 'factory.attempt=r1', '--label', 'factory.ticket=ORC-1', '--label', 'factory.network=none',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '512', '--memory', '4g', '--memory-swap', '4g', '--cpus', String(defaultLimits().cpus),
      '--user', '1000:1000',
      '-e', 'HOME=/home/factory',
      '--mount', 'type=bind,source=/home/d/wt/orc-1,target=/work',
      '--mount', 'type=bind,source=/h/.git,target=/h/.git,readonly',
      '--workdir', '/work',
      '--network', 'none',
      'factory-runner:1', 'sleep', 'infinity',
    ]);
  });

  it('caps processes, memory and cpus, as configured', async () => {
    const e = empty();
    await new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec, limits: { pids: 64, memory: '256m', cpus: 0.5 } }).create(req());
    const a = runArgs(e.calls);
    expect(a.slice(a.indexOf('--pids-limit'), a.indexOf('--pids-limit') + 8)).toEqual(['--pids-limit', '64', '--memory', '256m', '--memory-swap', '256m', '--cpus', '0.5']);
  });

  it('drops each limit left undefined, the swap with the memory', async () => {
    const e = empty();
    await new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec, limits: { cpus: 1 } }).create(req());
    const a = runArgs(e.calls);
    expect(a).not.toContain('--pids-limit');
    expect(a).not.toContain('--memory');
    expect(a).not.toContain('--memory-swap');
    expect(a.slice(a.indexOf('--cpus'), a.indexOf('--cpus') + 2)).toEqual(['--cpus', '1']);
    const none = empty();
    await new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: none.exec, limits: {} }).create(req());
    expect(runArgs(none.calls).filter((x) => /^--(pids-limit|memory|memory-swap|cpus)$/.test(x))).toEqual([]);
  });

  it('asks for no more cpus than the host has: 2 at most', () => {
    expect(defaultLimits(1)).toEqual({ pids: 512, memory: '4g', cpus: 1 });
    expect(defaultLimits(16).cpus).toBe(2);
  });

  it("knows podman by what its CLI reports of itself, never by its name: a `docker` that is Podman's takes Podman's flags (ORC-348)", async () => {
    const shim = engine((a) => (a[0] === 'run' ? ok('c1\n') : ok()), PODMAN_CLIENT);
    await new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: shim.exec }).create(req());
    expect(shim.versions).toEqual([['version', '--format', '{{json .Client}}']]);
    expect(shim.calls.every((c) => c.args[0] === QUIET)).toBe(true);
    expect(runArgs(shim.calls)).toContain('--userns=keep-id');
    const named = engine((a) => (a[0] === 'run' ? ok('c1\n') : ok()), DOCKER_CLIENT);
    await new ContainerSandboxProvider({ ...opts, cli: '/usr/bin/podman', exec: named.exec }).create(req());
    expect(named.calls.some((c) => c.args[0] === QUIET)).toBe(false);
    expect(runArgs(named.calls)).not.toContain('--userns=keep-id');
  });

  it("reads Docker's client when its daemon does not answer (exit 1), asks once, and asks again after an answer it cannot read", async () => {
    const down = engine((a) => (a[0] === 'run' ? ok('c1\n') : ok()), { ...PODMAN_CLIENT, stderr: 'Cannot connect to the server', code: 1 });
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: down.exec });
    await p.create(req());
    await p.create(req({ runId: 'r2' }));
    expect(down.versions).toHaveLength(1);
    expect(runArgs(down.calls)).toContain('--userns=keep-id');
    let client: ExecResult = { stdout: '', stderr: 'docker: command not found', code: 127 };
    const flaky = engine((a) => (a[0] === 'run' ? ok('c1\n') : ok()));
    const exec: Exec = async (cmd, args, o) => (args[0] === 'version' ? client : flaky.exec(cmd, args, o));
    const q = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec });
    await expect(q.create(req())).rejects.toThrow('docker version --format {{json .Client}}: docker: command not found');
    client = DOCKER_CLIENT;
    await expect(q.create(req())).resolves.toMatchObject({ id: 'c1' });
  });

  it('keeps the uid under podman with --userns=keep-id', async () => {
    const e = empty();
    await new ContainerSandboxProvider({ ...opts, cli: '/usr/bin/podman', exec: e.exec }).create(req());
    expect(e.calls.every((c) => c.cmd === '/usr/bin/podman')).toBe(true);
    const a = runArgs(e.calls);
    expect(a.slice(a.indexOf('--userns=keep-id'), a.indexOf('--userns=keep-id') + 3)).toEqual(['--userns=keep-id', '--user', '1000:1000']);
  });

  it('runs --network none at every level without an egress proxy: nothing gets out', async () => {
    for (const network of ['claude-api', 'limited', 'full'] as const) {
      const e = empty();
      const sbx = await new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec }).create(req({ network }));
      expect(sbx.network).toBe(network);
      const a = runArgs(e.calls);
      expect(a.slice(a.indexOf('--network'), a.indexOf('--network') + 2)).toEqual(['--network', 'none']);
      expect(a.slice(-2)).toEqual(['sleep', 'infinity']);
      expect(a.some((x) => /PROXY|add-host/i.test(x))).toBe(false);
    }
  });

  it('with an egress proxy: --network none, the run’s socket and the CA mounted, the relay in front, tools pointed at both', async () => {
    const e = empty();
    const egress = fakeEgress();
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec, egress });
    await p.create(req({ network: 'limited', allow: ['docs.exemple.com'] }));
    expect(egress.opened).toEqual([{ runId: 'r1', policy: { level: 'limited', allow: ['docs.exemple.com'] } }]);
    const a = runArgs(e.calls);
    // Its dir, read-only: bound anew after a restart, the socket stays in reach, and the agent cannot replace it (ORC-220).
    expect(a).toContain('type=bind,source=/home/d/.factory/network/r1,target=/run/factory/egress,readonly');
    expect(a).toContain('type=bind,source=/home/d/.factory/egress-ca/ca.crt,target=/run/factory/egress-ca.crt,readonly');
    expect(a.some((x) => x.includes('ca.key'))).toBe(false);
    expect(a.slice(a.indexOf('--network'), a.indexOf('--network') + 2)).toEqual(['--network', 'none']);
    for (const v of ['HTTPS_PROXY=http://127.0.0.1:3128', 'http_proxy=http://127.0.0.1:3128', 'NO_PROXY=localhost,127.0.0.1', 'NODE_USE_ENV_PROXY=1', 'NODE_EXTRA_CA_CERTS=/run/factory/egress-ca.crt', 'GIT_SSL_CAINFO=/run/factory/egress-ca.crt', 'YARN_HTTPS_PROXY=http://127.0.0.1:3128', 'YARN_HTTPS_CA_FILE_PATH=/run/factory/egress-ca.crt', 'COREPACK_NPM_REGISTRY=https://registry.npmjs.org']) {
      expect(a).toContain(v);
    }
    // Yarn ≥ 2 refuses `cafile` ("Unrecognized or legacy configuration settings").
    expect(a.some((x) => x.startsWith('YARN_CAFILE='))).toBe(false);
    expect(a.slice(-3, -1)).toEqual(['node', '-e']);
    expect(a.at(-1)).toMatch(/listen\(3128, *'127\.0\.0\.1'\)/);
    expect(a.at(-1)).toContain("net.connect('/run/factory/egress/egress.sock')");
  });

  it('closes the run’s egress when its container is destroyed, from the run it knows, or when it never runs', async () => {
    const e = empty();
    const egress = fakeEgress();
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec, egress });
    await p.create(req());
    await p.destroy('c1');
    expect(egress.closed).toEqual(['r1']);
    // No lookup of services: it joined none (ORC-309).
    expect(e.calls.map((c) => c.args[0])).toEqual(['ps', 'run', 'rm']);
    const failing = engine((a) => (a[0] === 'run' ? { stdout: '', stderr: 'no such image', code: 125 } : ok()));
    const f = fakeEgress();
    await expect(new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: failing.exec, egress: f }).create(req())).rejects.toThrow(/no such image/);
    expect(f.closed).toEqual(['r1']);
    // A failure while building the run's arguments closes it too.
    const g = { ...fakeEgress(), get caCertPath(): string { throw new Error('no CA'); } };
    await expect(new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: empty().exec, egress: g }).create(req())).rejects.toThrow(/no CA/);
    expect(g.closed).toEqual(['r1']);
  });

  it('replaces a live container whose egress this process does not hold (a daemon restart): its socket is dead', async () => {
    const e = engine((a) => {
      if (a[0] === 'ps') return ok('c9\n');
      if (a[0] === 'inspect') return ok(inspectLine('c9', true, 'r1', 'limited'));
      if (a[0] === 'run') return ok('c10\n');
      return ok();
    });
    const stale = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec, egress: fakeEgress() });
    expect(await stale.findByAttempt('r1')).toBeUndefined();
    expect((await stale.create(req({ network: 'limited' }))).id).toBe('c10');
    expect(e.calls.map((c) => c.args.slice(0, 2).join(' '))).toContain('rm -f');
    const live = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec, egress: fakeEgress(['r1']) });
    expect(await live.findByAttempt('r1')).toEqual({ id: 'c9', network: 'limited', level: 'L3' });
  });

  it('reattaches to the live container of an attempt from before a restart: its egress listens again, on its label (ORC-220)', async () => {
    const e = engine((a) => {
      if (a[0] === 'ps') return ok('c9\n');
      if (a[0] === 'inspect') return ok(inspectLine('c9', true, 'r1', 'limited'));
      throw new Error(`unexpected ${a.join(' ')}`);
    });
    const egress = fakeEgress();
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec, egress });
    expect(await p.reattach('r1')).toEqual({ id: 'c9', network: 'limited', level: 'L3' });
    expect(egress.opened).toEqual([{ runId: 'r1', policy: { level: 'limited', allow: [] } }]);
    // Usable from now on: the heartbeat finds it, and spawnCommand knows it.
    expect(await p.findByAttempt('r1')).toEqual({ id: 'c9', network: 'limited', level: 'L3' });
    expect(p.spawnCommand('c9', ['true']).command[0]).toBe('docker');
    // Twice in one process, the egress is not opened twice.
    await p.reattach('r1');
    expect(egress.opened).toHaveLength(1);
  });

  it('keeps the hosts of a custom repository on a label, and a resumed run gets them back (ORC-322)', async () => {
    const made = empty();
    await new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: made.exec, egress: fakeEgress() }).create(req({ network: 'limited', allow: ['a.example.com', 'b.example.com'] }));
    const a = runArgs(made.calls);
    expect(a[a.indexOf('factory.allow=a.example.com,b.example.com') - 1]).toBe('--label');

    const e = engine((x) => {
      if (x[0] === 'ps') return ok('c9\n');
      if (x[0] === 'inspect') return ok(inspectLine('c9', true, 'r1', 'limited', 'a.example.com,b.example.com'));
      throw new Error(`unexpected ${x.join(' ')}`);
    });
    const egress = fakeEgress();
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec, egress });
    await p.reattach('r1');
    expect(egress.opened).toEqual([{ runId: 'r1', policy: { level: 'limited', allow: ['a.example.com', 'b.example.com'] } }]);
    // The run's next create takes the container back as it is, without opening its egress again.
    expect((await p.create(req({ network: 'limited', allow: ['a.example.com', 'b.example.com'] }))).id).toBe('c9');
    expect(egress.opened).toHaveLength(1);
  });

  it('puts no allow label on a sandbox without hosts of its own, and reattaches a container without one with none', async () => {
    const made = empty();
    await new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: made.exec }).create(req({ network: 'limited' }));
    expect(runArgs(made.calls).some((x) => x.startsWith('factory.allow='))).toBe(false);

    // Some engines print a missing label as `<no value>`.
    const e = engine((x) => (x[0] === 'ps' ? ok('c9\n') : ok(inspectLine('c9', true, 'r1', 'limited', '<no value>'))));
    const egress = fakeEgress();
    await new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec, egress }).reattach('r1');
    expect(egress.opened).toEqual([{ runId: 'r1', policy: { level: 'limited', allow: [] } }]);
  });

  it('has nothing to reattach to when the container of the attempt is stopped or gone', async () => {
    const stopped = engine((a) => {
      if (a[0] === 'ps') return ok('c9\n');
      if (a[0] === 'inspect') return ok(inspectLine('c9', false, 'r1', 'limited'));
      return ok();
    });
    const egress = fakeEgress();
    expect(await new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: stopped.exec, egress }).reattach('r1')).toBeUndefined();
    expect(await new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: empty().exec, egress }).reattach('r1')).toBeUndefined();
    expect(egress.opened).toEqual([]);
  });

  it('returns the live container of the attempt instead of running a second one', async () => {
    const e = engine((a) => {
      if (a[0] === 'ps') return ok('c9\n');
      if (a[0] === 'inspect') return ok(inspectLine('c9', true, 'r1', 'claude-api'));
      throw new Error(`unexpected ${a.join(' ')}`);
    });
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec });
    expect(await p.create(req({ network: 'claude-api' }))).toEqual({ id: 'c9', network: 'claude-api', level: 'L3' });
    expect(e.calls.map((c) => c.args[0])).toEqual(['ps', 'inspect']);
  });

  it('refuses a replay at another network level', async () => {
    const e = engine((a) => (a[0] === 'ps' ? ok('c9\n') : ok(inspectLine('c9', true, 'r1', 'none'))));
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec });
    await expect(p.create(req({ network: 'full' }))).rejects.toThrow(/network none.*full/);
  });

  it('removes a stopped container of the attempt and runs a new one', async () => {
    const e = engine((a) => {
      if (a[0] === 'ps') return ok('c9\n');
      if (a[0] === 'inspect') return ok(inspectLine('c9', false, 'r1', 'none'));
      if (a[0] === 'run') return ok('c10\n');
      return ok();
    });
    const sbx = await new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec }).create(req());
    expect(sbx.id).toBe('c10');
    expect(e.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['ps -a', 'inspect --format', 'rm -f', 'run -d']);
  });

  it('never mounts an engine socket, nor a directory holding one', async () => {
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: empty().exec });
    for (const m of [
      { host: '/var/run/docker.sock', target: '/x', readOnly: true },
      { host: '/h/a', target: '/run/podman/podman.sock', readOnly: true },
      { host: '/var/run', target: '/x', readOnly: true },
      { host: '/', target: '/x', readOnly: true },
    ]) {
      await expect(p.create(req({ mounts: [m] }))).rejects.toThrow(/socket/);
    }
    await expect(p.create(req({ workspacePath: '/run' }))).rejects.toThrow(/socket/);
  });

  it('refuses a path that would break the --mount syntax', async () => {
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: empty().exec });
    await expect(p.create(req({ workspacePath: '/h/a,target=/etc' }))).rejects.toThrow(/mount/);
  });

  it('refuses requirements beyond L3, a browser, and a service other than postgres', async () => {
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: empty().exec });
    await expect(p.create(req({ requirements: { ...DEFAULT_REQUIREMENTS, minLevel: 'L4' } }))).rejects.toThrow(/L4/);
    await expect(p.create(req({ requirements: { ...DEFAULT_REQUIREMENTS, browser: true } }))).rejects.toThrow(/browser/);
    await expect(p.create(req({ requirements: { ...DEFAULT_REQUIREMENTS, services: ['redis'] } }))).rejects.toThrow(/redis/);
  });

  it('rejects when the engine fails to run the container', async () => {
    const e = engine((a) => (a[0] === 'run' ? { stdout: '', stderr: 'no such image', code: 125 } : ok()));
    await expect(new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec }).create(req())).rejects.toThrow(/no such image/);
  });
});

describe('ContainerSandboxProvider.exec', () => {
  const live = (a: string[]) => (a[0] === 'inspect' ? ok(inspectLine('c1', true, 'r1', 'none')) : ok('out'));

  it('runs argv in the container, its env under neutral names on the command line and valued in the environment', async () => {
    const e = engine(live);
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec });
    expect(await p.exec('c1', ['npm', 'ci'], { cwd: '/work/sub', env: { TOKEN: 's3cr3t' } })).toEqual(ok('out'));
    const call = e.calls.find((c) => c.args[0] === 'exec')!;
    expect(call.args).toEqual([
      'exec', '-w', '/work/sub', '-e', 'FACTORY_SANDBOX_ENV_0', 'c1',
      'sh', '-c', 'export TOKEN="$FACTORY_SANDBOX_ENV_0"; unset FACTORY_SANDBOX_ENV_0; exec "$@"', 'sh', 'npm', 'ci',
    ]);
    expect(call.env).toEqual({ FACTORY_SANDBOX_ENV_0: 's3cr3t' });
  });

  /** What the engines read on the host, measured on Podman 5.8: each of them moves its storage or its target, or fails it. */
  const READ_BY_THE_ENGINE = ['HOME', 'PATH', 'TMPDIR', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'CONTAINER_HOST', 'CONTAINER_CONNECTION', 'CONTAINERS_CONF', 'CONTAINERS_STORAGE_CONF', 'LD_PRELOAD'];

  it.each(READ_BY_THE_ENGINE)('never hands %s to the engine CLI, whatever the container is given', async (name) => {
    const e = engine(live);
    const p = new ContainerSandboxProvider({ ...opts, cli: 'podman', exec: e.exec });
    await p.exec('c1', ['true'], { env: { [name]: '/moved' } });
    const call = e.calls.find((c) => c.args[1] === 'exec')!;
    expect(Object.keys(call.env!)).not.toContain(name);
    expect(call.args).not.toContain(name);
    // The command in the container gets it under its own name.
    expect(call.args.join(' ')).toContain(`export ${name}="$FACTORY_SANDBOX_ENV_0"`);
  });

  it('never puts a value on the command line, the whole of a setup env included', async () => {
    const e = engine(live);
    const p = new ContainerSandboxProvider({ ...opts, cli: 'podman', exec: e.exec });
    await p.exec('c1', ['true'], { env: { HOME: '/tmp/setup-home', NPM_TOKEN: 'npm-s3cr3t', MULTI: 'line "one"\n$two' } });
    const call = e.calls.find((c) => c.args[1] === 'exec')!;
    for (const value of ['/tmp/setup-home', 'npm-s3cr3t', 'line']) expect(call.args.join(' ')).not.toContain(value);
    expect(Object.values(call.env!)).toEqual(['/tmp/setup-home', 'npm-s3cr3t', 'line "one"\n$two']);
  });

  it.each(['A=B', 'A B', 'A;touch /x', '$(id)', '1A', ''])('refuses the name %j, which would land in the shell of the container', async (name) => {
    const e = engine(live);
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec });
    await expect(p.exec('c1', ['true'], { env: { [name]: 'v' } })).rejects.toThrow(/variable/);
    expect(e.calls.some((c) => c.args[0] === 'exec')).toBe(false);
  });

  it('defaults cwd to the workspace and returns a non-zero exit as a result', async () => {
    const e = engine((a) => (a[0] === 'inspect' ? live(a) : { stdout: '', stderr: 'boom', code: 2 }));
    const r = await new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec }).exec('c1', ['false']);
    expect(r.code).toBe(2);
    expect(e.calls.find((c) => c.args[0] === 'exec')!.args).toEqual(['exec', '-w', '/work', 'c1', 'false']);
  });

  it('rejects on an unknown or stopped container', async () => {
    const gone = engine(() => ({ stdout: '', stderr: 'No such object: c1', code: 1 }));
    await expect(new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: gone.exec }).exec('c1', ['true'])).rejects.toThrow(/c1/);
    const stopped = engine(() => ok(inspectLine('c1', false, 'r1', 'none')));
    await expect(new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: stopped.exec }).exec('c1', ['true'])).rejects.toThrow(/c1/);
    expect(stopped.calls.some((c) => c.args[0] === 'exec')).toBe(false);
  });

  it('rejects when the engine itself fails the exec (125)', async () => {
    const e = engine((a) => (a[0] === 'inspect' ? live(a) : { stdout: '', stderr: 'container died', code: 125 }));
    await expect(new ContainerSandboxProvider({ ...opts, cli: 'podman', exec: e.exec }).exec('c1', ['true'])).rejects.toThrow(/container died/);
  });
});

describe('ContainerSandboxProvider.spawnCommand', () => {
  it('builds an attached exec with variable names only, for a sandbox it made', async () => {
    const e = engine((x) => ok(x[0] === 'run' ? 'c1\n' : ''));
    const p = new ContainerSandboxProvider({ ...opts, cli: 'podman', exec: e.exec });
    expect(() => p.spawnCommand('c1', ['true'])).toThrow(/unknown sandbox/);
    await p.create(req());
    expect(p.spawnCommand('c1', ['claude', '-p', 'hi'], { env: { CLAUDE_CODE_OAUTH_TOKEN: 'secret', A: 'b' } })).toEqual({
      command: [
        'podman', QUIET, 'exec', '-i', '-w', '/work', '-e', 'FACTORY_SANDBOX_ENV_0', '-e', 'FACTORY_SANDBOX_ENV_1', 'c1',
        'sh', '-c', 'export CLAUDE_CODE_OAUTH_TOKEN="$FACTORY_SANDBOX_ENV_0" A="$FACTORY_SANDBOX_ENV_1"; unset FACTORY_SANDBOX_ENV_0 FACTORY_SANDBOX_ENV_1; exec "$@"', 'sh', 'claude', '-p', 'hi',
      ],
      env: { FACTORY_SANDBOX_ENV_0: 'secret', FACTORY_SANDBOX_ENV_1: 'b' },
    });
    await p.destroy('c1');
    expect(() => p.spawnCommand('c1', ['true'])).toThrow(/unknown sandbox/);
  });

  it('adds no wrapper to a command with no env', async () => {
    const e = engine((x) => ok(x[0] === 'run' ? 'c1\n' : ''));
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec });
    await p.create(req());
    expect(p.spawnCommand('c1', ['true'])).toEqual({ command: ['docker', 'exec', '-i', '-w', '/work', 'c1', 'true'], env: {} });
  });

  it('gives the caller nothing the engine reads, whatever the container is given', async () => {
    const e = engine((x) => ok(x[0] === 'run' ? 'c1\n' : ''));
    const p = new ContainerSandboxProvider({ ...opts, cli: 'podman', exec: e.exec });
    await p.create(req());
    const { command, env } = p.spawnCommand('c1', ['claude'], { env: { HOME: '/moved', XDG_RUNTIME_DIR: '/moved', CONTAINER_HOST: 'tcp://evil:1' } });
    expect(Object.keys(env)).toEqual(['FACTORY_SANDBOX_ENV_0', 'FACTORY_SANDBOX_ENV_1', 'FACTORY_SANDBOX_ENV_2']);
    expect(command.join(' ')).not.toContain('/moved');
    expect(command.join(' ')).not.toContain('tcp://evil:1');
  });
});

describe('ContainerSandboxProvider under podman', () => {
  it('passes --log-level=error before every subcommand: its warnings would land in the command stderr', async () => {
    const e = engine((a) => {
      if (a[0] === 'run') return ok('c1\n');
      if (a[0] === 'ps') return ok(e.calls.some((c) => sub(c.args)[0] === 'run') ? 'c1\n' : '');
      if (a[0] === 'inspect') return ok(inspectLine('c1', true, 'r1', 'none'));
      return ok();
    });
    const p = new ContainerSandboxProvider({ ...opts, cli: 'podman', exec: e.exec });
    await p.create(req());
    await p.exec('c1', ['true']);
    await p.list();
    await p.findByAttempt('r1');
    await p.destroy('c1');
    expect(new Set(e.calls.map((c) => sub(c.args)[0]))).toEqual(new Set(['ps', 'run', 'inspect', 'exec', 'rm']));
    expect(e.calls.every((c) => c.args[0] === QUIET)).toBe(true);
  });

  it('leaves docker without it', async () => {
    const e = empty();
    await new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec }).create(req());
    expect(e.calls.some((c) => c.args.includes(QUIET))).toBe(false);
  });
});

describe('ContainerSandboxProvider with an instance (several daemons on one engine)', () => {
  const mine = 'label=factory.instance=abc123';

  it('labels its containers with the instance and looks up only those', async () => {
    const e = empty();
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', instance: 'abc123', exec: e.exec });
    await p.create(req());
    await p.findByAttempt('r1');
    await p.list();
    const a = runArgs(e.calls);
    expect(a.slice(a.indexOf('factory.instance=abc123') - 1, a.indexOf('factory.instance=abc123') + 1)).toEqual(['--label', 'factory.instance=abc123']);
    const ps = e.calls.filter((c) => c.args[0] === 'ps').map((c) => c.args);
    expect(ps).toEqual([
      ['ps', '-a', '-q', '--no-trunc', '--filter', 'label=factory.attempt=r1', '--filter', mine],
      ['ps', '-a', '-q', '--no-trunc', '--filter', 'label=factory.attempt=r1', '--filter', mine],
      ['ps', '-a', '-q', '--no-trunc', '--filter', 'label=factory.attempt', '--filter', mine],
      ['ps', '-a', '-q', '--no-trunc', '--filter', 'label=factory.services', '--filter', mine],
    ]);
  });

  it('adds no instance label nor filter without one', async () => {
    const e = empty();
    await new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec }).create(req());
    expect(e.calls.flatMap((c) => c.args).some((x) => x.includes('factory.instance'))).toBe(false);
  });
});

describe('ContainerSandboxProvider lookups and destroy', () => {
  const two = engine((a) => {
    if (a[0] === 'ps') return ok(a.includes('label=factory.attempt') ? 'c1\nc2\n' : '');
    if (a[0] === 'inspect') return ok(inspectLine('c1', true, 'r1', 'none') + inspectLine('c2', false, 'r2', 'full'));
    return ok();
  });

  it('list returns every container labelled by the factory, stopped ones too so recover reaps them', async () => {
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: two.exec });
    expect(await p.list()).toEqual([
      { runId: 'r1', sandbox: { id: 'c1', network: 'none', level: 'L3' } },
      { runId: 'r2', sandbox: { id: 'c2', network: 'full', level: 'L3' } },
    ]);
    expect(two.calls[0]!.args).toEqual(['ps', '-a', '-q', '--no-trunc', '--filter', 'label=factory.attempt']);
  });

  it('findByAttempt returns the live container of the run, none without one', async () => {
    const e = engine((a) => (a[0] === 'ps' ? ok('c1\n') : ok(inspectLine('c1', true, 'r1', 'limited'))));
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec });
    expect(await p.findByAttempt('r1')).toEqual({ id: 'c1', network: 'limited', level: 'L3' });
    expect(await new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: empty().exec }).findByAttempt('r1')).toBeUndefined();
  });

  it('destroy removes by force and ignores an unknown container', async () => {
    const e = engine(() => ({ stdout: '', stderr: 'Error: No such container: c1', code: 1 }));
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec });
    await p.destroy('c1');
    expect(e.calls).toEqual([{ cmd: 'docker', args: ['rm', '-f', '-v', 'c1'] }]);
    const broken = engine(() => ({ stdout: '', stderr: 'Cannot connect to the Docker daemon', code: 1 }));
    await expect(new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: broken.exec }).destroy('c1')).rejects.toThrow(/daemon/);
  });
});

describe('ContainerSandboxProvider services (ORC-309)', () => {
  interface Container { labels: Record<string, string>; env: Record<string, string>; running: boolean; args: string[] }

  /** An engine that keeps its containers: their labels and env at `run` (a bare `-e NAME` from the CLI's env), looked up by `ps --filter`. */
  function stateful(over: { ready?: () => number; role?: () => ExecResult; failRun?: (args: string[]) => boolean } = {}) {
    const containers = new Map<string, Container>();
    let made = 0;
    const pair = (x: string): [string, string] => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)];
    const e = engine((a, cliEnv = {}) => {
      if (a[0] === 'run') {
        if (over.failRun?.(a)) return { stdout: '', stderr: 'run failed', code: 125 };
        const labels = Object.fromEntries(a.flatMap((x, i) => (a[i - 1] === '--label' ? [pair(x)] : [])));
        const env = Object.fromEntries(a.flatMap((x, i) => (a[i - 1] === '-e' ? [x.includes('=') ? pair(x) : [x, cliEnv[x]!]] : [])));
        const id = labels['factory.services'] ? `svc${++made}` : `c${++made}`;
        containers.set(id, { labels, env, running: true, args: a });
        return ok(`${id}\n`);
      }
      if (a[0] === 'ps') {
        const filters = a.flatMap((x, i) => (a[i - 1] === '--filter' ? [x.slice('label='.length)] : []));
        const match = (c: Container) => filters.every((f) => (f.includes('=') ? c.labels[pair(f)[0]] === pair(f)[1] : f in c.labels));
        return ok([...containers].filter(([, c]) => match(c)).map(([id]) => `${id}\n`).join(''));
      }
      if (a[0] === 'inspect') {
        const format = a[2]!;
        const found = a.slice(3).flatMap((id) => (containers.has(id) ? [[id, containers.get(id)!] as const] : []));
        if (format.startsWith('{{.State.Running}}')) return ok(found.map(([, c]) => `${c.running}${Object.entries(c.env).map(([k, v]) => `\t${k}=${v}`).join('')}\n`).join(''));
        if (format.includes('"factory.services"')) return ok(found.map(([id, c]) => `${id}\t${c.labels['factory.services']}\n`).join(''));
        return ok(found.map(([id, c]) => inspectLine(id, c.running, c.labels['factory.attempt']!, c.labels['factory.network']!, c.labels['factory.allow'])).join(''));
      }
      if (a[0] === 'exec' && a.includes('pg_isready')) return { stdout: '', stderr: 'no response', code: over.ready?.() ?? 0 };
      if (a[0] === 'exec' && a[2] === 'sh') return over.role?.() ?? ok();
      if (a[0] === 'rm') containers.delete(a.at(-1)!);
      return ok();
    });
    return { ...e, containers };
  }
  const pg = { ...DEFAULT_REQUIREMENTS, services: ['postgres'] };
  const rms = (calls: { args: string[] }[]) => calls.map((c) => sub(c.args)).filter((a) => a[0] === 'rm');

  it('starts a Postgres of its own for the attempt, without route nor capability, and the sandbox joins its loopback with DATABASE_URL', async () => {
    const e = stateful();
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec, instance: 'i1' });
    const sbx = await p.create(req({ requirements: pg }));
    expect(sbx).toEqual({ id: 'c2', network: 'none', level: 'L3', services: 'svc1' });
    const svc = e.containers.get('svc1')!;
    expect(svc.labels).toEqual({ 'factory.services': 'r1', 'factory.ticket': 'ORC-1', 'factory.instance': 'i1' });
    expect(svc.args.slice(svc.args.indexOf('--cap-drop'))).toEqual([
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '512', '--memory', '4g', '--memory-swap', '4g', '--cpus', String(defaultLimits().cpus),
      '--user', 'postgres',
      '--mount', 'type=tmpfs,target=/var/lib/postgresql/data,tmpfs-mode=1777',
      '-e', 'POSTGRES_DB=factory', '-e', 'PGDATA=/var/lib/postgresql/data/pgdata', '-e', 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust',
      '-e', 'POSTGRES_PASSWORD', '-e', 'FACTORY_DB_PASSWORD',
      '--network', 'none',
      POSTGRES_IMAGE,
    ]);
    const password = svc.env['FACTORY_DB_PASSWORD']!;
    expect(password).toMatch(/^[0-9a-f]{48}$/);
    // The superuser's is another, given to nobody; DATABASE_URL's role is made by it, no superuser.
    expect(svc.env['POSTGRES_PASSWORD']).toMatch(/^[0-9a-f]{48}$/);
    expect(svc.env['POSTGRES_PASSWORD']).not.toBe(password);
    expect(svc.env).toMatchObject({ POSTGRES_DB: 'factory', POSTGRES_INITDB_ARGS: '--auth-host=scram-sha-256 --auth-local=trust' });
    expect(svc.env).not.toHaveProperty('POSTGRES_USER');
    const role = e.calls.map((c) => sub(c.args)).find((a) => a[0] === 'exec' && a[2] === 'sh')!;
    expect(role.slice(0, 4)).toEqual(['exec', 'svc1', 'sh', '-c']);
    expect(role[4]).toContain(`CREATE ROLE factory LOGIN PASSWORD '$FACTORY_DB_PASSWORD'`);
    expect(role[4]).toContain('ALTER DATABASE factory OWNER TO factory');
    expect(role[4]).not.toMatch(/SUPERUSER/i);
    const box = e.containers.get('c2')!;
    expect(box.args.slice(box.args.indexOf('--network'), box.args.indexOf('--network') + 2)).toEqual(['--network', 'container:svc1']);
    expect(box.env['DATABASE_URL']).toBe(`postgres://factory:${password}@127.0.0.1:5432/factory`);
    // Neither the passwords nor the URL on a command line, which the host's process list shows.
    expect(e.calls.flatMap((c) => c.args).some((x) => x.includes(password) || x.includes(svc.env['POSTGRES_PASSWORD']!))).toBe(false);
  });

  it('waits until Postgres accepts connections on the loopback before the sandbox starts', async () => {
    const answers = [2, 2, 0];
    const e = stateful({ ready: () => answers.shift() ?? 0 });
    await new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec }).create(req({ requirements: pg }));
    const steps = e.calls.map((c) => sub(c.args)).filter((a) => a[0] === 'run' || a[0] === 'exec').map((a) => (a[0] === 'run' ? `run ${a.at(-1)}` : `${a[1]} ${a[2]}`));
    expect(steps).toEqual([`run ${POSTGRES_IMAGE}`, 'svc1 pg_isready', 'svc1 pg_isready', 'svc1 pg_isready', 'svc1 sh', 'run infinity']);
  });

  it('a Postgres whose role cannot be made is removed, and no sandbox starts', async () => {
    const e = stateful({ role: () => ({ stdout: '', stderr: 'role exists', code: 1 }) });
    await expect(new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec }).create(req({ requirements: pg }))).rejects.toThrow('postgres role not made in svc1: role exists');
    expect([...e.containers.keys()]).toEqual([]);
  });

  it('a Postgres never ready is removed, and no sandbox starts', async () => {
    const e = stateful({ ready: () => 2 });
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec, serviceReadyMs: 0 });
    await expect(p.create(req({ requirements: pg }))).rejects.toThrow('postgres not ready in svc1: no response');
    expect([...e.containers.keys()]).toEqual([]);
  });

  it("the attempt's setup and its agent share one Postgres; another key gets a new one", async () => {
    const e = stateful();
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec });
    const setup = await p.create(req({ runId: 'r1-setup', servicesOf: 'r1', requirements: pg }));
    await p.destroy(setup.id);
    expect([...e.containers.keys()]).toEqual(['svc1']);
    const agent = await p.create(req({ requirements: pg }));
    expect(agent.services).toBe('svc1');
    expect(e.containers.get(agent.id)!.env['DATABASE_URL']).toBe(`postgres://factory:${e.containers.get('svc1')!.env['FACTORY_DB_PASSWORD']}@127.0.0.1:5432/factory`);
    const verify = await p.create(req({ runId: 'r1-verify', requirements: pg }));
    expect(verify.services).not.toBe('svc1');
    expect(e.containers.get(verify.id)!.env['DATABASE_URL']).not.toBe(e.containers.get(agent.id)!.env['DATABASE_URL']);
  });

  it('never starts a new Postgres in place of a stopped one: its database would be empty', async () => {
    const e = stateful();
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec });
    await p.create(req({ runId: 'r1-setup', servicesOf: 'r1', requirements: pg }));
    e.containers.get('svc1')!.running = false;
    await expect(p.create(req({ requirements: pg }))).rejects.toThrow('the services of r1 are no longer running');
  });

  it('destroying the sandbox that owns them destroys its services; one that only joins them leaves them', async () => {
    const e = stateful();
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec });
    const setup = await p.create(req({ runId: 'r1-setup', servicesOf: 'r1', requirements: pg }));
    await p.destroy(setup.id);
    expect(e.containers.has('svc1')).toBe(true);
    const agent = await p.create(req({ requirements: pg }));
    await p.destroy(agent.id);
    expect([...e.containers.keys()]).toEqual([]);
    expect(rms(e.calls)).toEqual([['rm', '-f', '-v', setup.id], ['rm', '-f', '-v', agent.id], ['rm', '-f', '-v', 'svc1']]);
  });

  it('a sandbox that fails to start takes the services it owns or started with it; one that only joins them leaves them', async () => {
    const owner = stateful({ failRun: (a) => a.includes('container:svc1') });
    await expect(new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: owner.exec }).create(req({ requirements: pg }))).rejects.toThrow('run failed');
    expect([...owner.containers.keys()]).toEqual([]);
    // A setup whose container never ran: no agent follows it.
    const starter = stateful({ failRun: (a) => a.includes('container:svc1') });
    await expect(new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: starter.exec }).create(req({ runId: 'r1-setup', servicesOf: 'r1', requirements: pg }))).rejects.toThrow('run failed');
    expect([...starter.containers.keys()]).toEqual([]);
    let fail = false;
    const joiner = stateful({ failRun: (a) => fail && a.includes('container:svc1') });
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: joiner.exec });
    await p.create(req({ runId: 'r1-setup', servicesOf: 'r1', requirements: pg }));
    fail = true;
    await expect(p.create(req({ runId: 'r1-again', servicesOf: 'r1', requirements: pg }))).rejects.toThrow('run failed');
    expect(joiner.containers.has('svc1')).toBe(true);
  });

  it('removes with --depend under Podman, which refuses a service a leftover container still joins', async () => {
    const e = stateful();
    const p = new ContainerSandboxProvider({ ...opts, cli: 'podman', exec: e.exec });
    const agent = await p.create(req({ requirements: pg }));
    await p.destroy(agent.id);
    expect(rms(e.calls)).toEqual([['rm', '-f', '-v', '--depend', agent.id], ['rm', '-f', '-v', '--depend', 'svc1']]);
  });

  it('removes with --depend under Podman even as the first command of a provider, before it asked anything else (ORC-348)', async () => {
    const e = engine(() => ok());
    await new ContainerSandboxProvider({ ...opts, cli: 'podman', exec: e.exec }).destroy('svc1');
    expect(rms(e.calls)).toEqual([['rm', '-f', '-v', '--depend', 'svc1']]);
  });

  it('list gives the services under the key they serve, so recover destroys those of dead attempts', async () => {
    const e = stateful();
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec });
    await p.create(req({ runId: 'r1-setup', servicesOf: 'r1', requirements: pg }));
    expect(await p.list()).toEqual([
      { runId: 'r1-setup', sandbox: { id: 'c2', network: 'none', level: 'L3' } },
      { runId: 'r1', sandbox: { id: 'svc1', network: 'none', level: 'L3' } },
    ]);
    await p.destroy('svc1');
    expect([...e.containers.keys()]).toEqual(['c2']);
  });

  it('refuses a service it does not start, naming it, before anything runs', async () => {
    const e = stateful();
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec });
    await expect(p.create(req({ requirements: { ...DEFAULT_REQUIREMENTS, services: ['postgres', 'redis'] } }))).rejects.toThrow('no services (redis)');
    expect(e.calls).toEqual([]);
  });
});
