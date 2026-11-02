import { describe, expect, it } from 'vitest';
import type { Exec, ExecResult } from '../exec.js';
import { ContainerSandboxProvider } from './docker-rootless.js';
import { DEFAULT_REQUIREMENTS, type SandboxRequest } from './types.js';

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', code: 0 });

/** A scripted engine: `answer` gets the args after the cli and says what the cli prints. */
function engine(answer: (args: string[]) => ExecResult) {
  const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, ...(opts?.env ? { env: opts.env } : {}) });
    return answer(args);
  };
  return { calls, exec };
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
const inspectLine = (id: string, running: boolean, runId: string, network: string) => `${id}\t${running}\t${runId}\t${network}\n`;

/** An engine with no container yet: `run` prints the new id. */
const empty = () => engine((a) => (a[0] === 'run' ? ok('c1\n') : ok()));
const runArgs = (calls: { args: string[] }[]) => calls.find((c) => c.args[0] === 'run')!.args;

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
      '--user', '1000:1000',
      '-e', 'HOME=/home/factory',
      '--mount', 'type=bind,source=/home/d/wt/orc-1,target=/work',
      '--mount', 'type=bind,source=/h/.git,target=/h/.git,readonly',
      '--workdir', '/work',
      '--network', 'none',
      'factory-runner:1', 'sleep', 'infinity',
    ]);
  });

  it('keeps the uid under podman with --userns=keep-id', async () => {
    const e = empty();
    await new ContainerSandboxProvider({ ...opts, cli: '/usr/bin/podman', exec: e.exec }).create(req());
    expect(e.calls.every((c) => c.cmd === '/usr/bin/podman')).toBe(true);
    const a = runArgs(e.calls);
    expect(a.slice(a.indexOf('--userns=keep-id'), a.indexOf('--userns=keep-id') + 3)).toEqual(['--userns=keep-id', '--user', '1000:1000']);
  });

  it('opens the default bridge and maps host.docker.internal for any level but none (gap until ORC-213)', async () => {
    for (const network of ['claude-api', 'limited', 'full'] as const) {
      const e = empty();
      const sbx = await new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec }).create(req({ network }));
      expect(sbx.network).toBe(network);
      const a = runArgs(e.calls);
      expect(a).not.toContain('--network');
      expect(a).toContain('--add-host=host.docker.internal:host-gateway');
      expect(a).toContain(`factory.network=${network}`);
    }
    const e = empty();
    await new ContainerSandboxProvider({ ...opts, cli: 'docker', agentHost: '172.17.0.1', exec: e.exec }).create(req({ network: 'full' }));
    expect(runArgs(e.calls)).toContain('--add-host=host.docker.internal:172.17.0.1');
  });

  it('leaves podman its own host.docker.internal entry unless an agent host is set', async () => {
    const e = empty();
    await new ContainerSandboxProvider({ ...opts, cli: 'podman', exec: e.exec }).create(req({ network: 'claude-api' }));
    expect(runArgs(e.calls).some((x) => x.startsWith('--add-host'))).toBe(false);
    const f = empty();
    await new ContainerSandboxProvider({ ...opts, cli: 'podman', agentHost: '10.0.2.2', exec: f.exec }).create(req({ network: 'claude-api' }));
    expect(runArgs(f.calls)).toContain('--add-host=host.docker.internal:10.0.2.2');
  });

  it('maps no agent host under --network none', async () => {
    const e = empty();
    await new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec }).create(req());
    expect(runArgs(e.calls).some((x) => x.startsWith('--add-host'))).toBe(false);
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

  it('refuses requirements beyond L3 without browser nor services', async () => {
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: empty().exec });
    await expect(p.create(req({ requirements: { ...DEFAULT_REQUIREMENTS, minLevel: 'L4' } }))).rejects.toThrow(/L4/);
    await expect(p.create(req({ requirements: { ...DEFAULT_REQUIREMENTS, browser: true } }))).rejects.toThrow(/browser/);
    await expect(p.create(req({ requirements: { ...DEFAULT_REQUIREMENTS, services: ['postgres'] } }))).rejects.toThrow(/postgres/);
  });

  it('rejects when the engine fails to run the container', async () => {
    const e = engine((a) => (a[0] === 'run' ? { stdout: '', stderr: 'no such image', code: 125 } : ok()));
    await expect(new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec }).create(req())).rejects.toThrow(/no such image/);
  });
});

describe('ContainerSandboxProvider.exec', () => {
  const live = (a: string[]) => (a[0] === 'inspect' ? ok(inspectLine('c1', true, 'r1', 'none')) : ok('out'));

  it('runs argv in the container, env named on the command line and valued in the environment', async () => {
    const e = engine(live);
    const p = new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: e.exec });
    expect(await p.exec('c1', ['npm', 'ci'], { cwd: '/work/sub', env: { TOKEN: 's3cr3t' } })).toEqual(ok('out'));
    const call = e.calls.find((c) => c.args[0] === 'exec')!;
    expect(call.args).toEqual(['exec', '-w', '/work/sub', '-e', 'TOKEN', 'c1', 'npm', 'ci']);
    expect(call.env).toEqual({ TOKEN: 's3cr3t' });
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
  it('builds an attached exec with variable names only', () => {
    const p = new ContainerSandboxProvider({ ...opts, cli: 'podman', exec: empty().exec });
    expect(p.spawnCommand('c1', ['claude', '-p', 'hi'], { env: { CLAUDE_CODE_OAUTH_TOKEN: 'secret', A: 'b' } })).toEqual([
      'podman', 'exec', '-i', '-w', '/work', '-e', 'CLAUDE_CODE_OAUTH_TOKEN', '-e', 'A', 'c1', 'claude', '-p', 'hi',
    ]);
    expect(() => p.spawnCommand('', ['true'])).toThrow();
  });
});

describe('ContainerSandboxProvider lookups and destroy', () => {
  const two = engine((a) => {
    if (a[0] === 'ps') return ok('c1\nc2\n');
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
    expect(e.calls).toEqual([{ cmd: 'docker', args: ['rm', '-f', 'c1'] }]);
    const broken = engine(() => ({ stdout: '', stderr: 'Cannot connect to the Docker daemon', code: 1 }));
    await expect(new ContainerSandboxProvider({ ...opts, cli: 'docker', exec: broken.exec }).destroy('c1')).rejects.toThrow(/daemon/);
  });
});
