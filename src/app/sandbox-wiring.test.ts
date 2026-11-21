import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Exec, ExecResult } from '../adapters/exec.js';
import { BROWSER_REQUIREMENTS } from '../adapters/browser/types.js';
import { defaultLimits } from '../adapters/sandbox/docker-rootless.js';
import type { Egress } from '../network/proxy-service.js';
import { browserImage, checkHostRuns, instanceId, makeSandboxes, sandboxConfig, sandboxLimits, sandboxRefusals } from './sandbox-wiring.js';

describe('checkHostRuns (ORC-349)', () => {
  it('refuses agents on the host without a container engine, naming both ways out', () => {
    expect(() => checkHostRuns({})).toThrow(/FACTORY_CONTAINER_CLI.*FACTORY_ALLOW_HOST_RUNS=1/s);
    // Only `1` is the explicit choice: anything else is not.
    for (const v of ['', '0', 'true', 'yes']) expect(() => checkHostRuns({ FACTORY_ALLOW_HOST_RUNS: v })).toThrow();
  });

  it('lets a container engine, or the explicit choice of the host, through', () => {
    expect(() => checkHostRuns({ FACTORY_CONTAINER_CLI: 'podman', FACTORY_RUNNER_IMAGE: 'r:1' })).not.toThrow();
    expect(() => checkHostRuns({ FACTORY_ALLOW_HOST_RUNS: '1' })).not.toThrow();
  });
});

describe('sandboxRefusals (ORC-449)', () => {
  it("refuses, before anything opens, every environment the sandboxes cannot run in: the start's and doctor's", () => {
    expect(sandboxRefusals({})).toEqual([expect.stringMatching(/^FACTORY_CONTAINER_CLI is not set: .*FACTORY_ALLOW_HOST_RUNS=1/)]);
    expect(sandboxRefusals({ FACTORY_CONTAINER_CLI: 'lxc', FACTORY_RUNNER_IMAGE: 'r:1' })).toEqual(['FACTORY_CONTAINER_CLI=lxc: docker or podman expected.']);
    expect(sandboxRefusals({ FACTORY_CONTAINER_CLI: 'podman' })).toEqual(['FACTORY_RUNNER_IMAGE is required with FACTORY_CONTAINER_CLI.']);
  });

  it('lets an engine with its runner image, or the explicit choice of the host, through', () => {
    expect(sandboxRefusals({ FACTORY_CONTAINER_CLI: 'docker', FACTORY_RUNNER_IMAGE: 'r:1' })).toEqual([]);
    expect(sandboxRefusals({ FACTORY_ALLOW_HOST_RUNS: '1' })).toEqual([]);
  });

  it('is what checkHostRuns throws, at the start before anything opens', () => {
    expect(() => checkHostRuns({ FACTORY_CONTAINER_CLI: 'podman' })).toThrow('FACTORY_RUNNER_IMAGE is required with FACTORY_CONTAINER_CLI.');
  });
});

// ORC-450: the limits and the daemon's uid/gid, refused by sandboxConfig before anything opens rather than by makeSandboxes.
describe('the sandboxes the start refuses before anything opens (ORC-450)', () => {
  const ENGINE = { FACTORY_CONTAINER_CLI: 'docker', FACTORY_RUNNER_IMAGE: 'r:1' };
  afterEach(() => vi.restoreAllMocks());

  it('refuses a FACTORY_SANDBOX_* limit malformed, with its message', () => {
    for (const [k, v] of [['FACTORY_SANDBOX_PIDS', '1.5'], ['FACTORY_SANDBOX_MEMORY', 'lots'], ['FACTORY_SANDBOX_CPUS', 'two']]) {
      const env = { ...ENGINE, [k!]: v };
      const { refused } = sandboxLimits(env) as { refused: string };
      expect(sandboxConfig(env)).toEqual({ cli: 'docker', refusal: refused });
      expect(() => checkHostRuns(env)).toThrow(refused);
    }
  });

  it('refuses a daemon without a uid or a gid, with its message', () => {
    vi.spyOn(process, 'getgid').mockReturnValue(undefined as unknown as number);
    expect(sandboxConfig(ENGINE)).toEqual({ cli: 'docker', refusal: 'The sandboxes require a daemon on Linux (uid and gid).' });
    expect(() => checkHostRuns(ENGINE)).toThrow('The sandboxes require a daemon on Linux (uid and gid).');
    // Without sandboxes, none is needed.
    expect(() => checkHostRuns({ FACTORY_ALLOW_HOST_RUNS: '1' })).not.toThrow();
  });

  it('hands makeSandboxes the limits and the ids it checked', () => {
    expect(sandboxConfig({ ...ENGINE, FACTORY_SANDBOX_PIDS: '128', FACTORY_SANDBOX_MEMORY: 'none' })).toEqual({
      cli: 'docker',
      image: 'r:1',
      uid: process.getuid!(),
      gid: process.getgid!(),
      limits: { ...defaultLimits(), pids: 128, memory: undefined },
    });
  });
});

describe('instanceId', () => {
  it('is 12 hex chars, stable for one daemon home whatever its spelling, distinct across homes', () => {
    const home = join(process.cwd(), 'h');
    expect(instanceId(home)).toMatch(/^[0-9a-f]{12}$/);
    expect(instanceId(join(home, '.', 'x', '..'))).toBe(instanceId(home));
    expect(instanceId(join(process.cwd(), 'other'))).not.toBe(instanceId(home));
  });
});

describe('sandboxLimits', () => {
  it('keeps the defaults without the variables', () => {
    expect(sandboxLimits({})).toEqual(defaultLimits());
    expect(sandboxLimits({ FACTORY_SANDBOX_PIDS: '' })).toEqual(defaultLimits());
  });

  it('takes a value per limit, and drops one on 0 or none', () => {
    expect(sandboxLimits({ FACTORY_SANDBOX_PIDS: '128', FACTORY_SANDBOX_MEMORY: '512m', FACTORY_SANDBOX_CPUS: '0.5' })).toEqual({ pids: 128, memory: '512m', cpus: 0.5 });
    expect(sandboxLimits({ FACTORY_SANDBOX_PIDS: '0', FACTORY_SANDBOX_MEMORY: 'none', FACTORY_SANDBOX_CPUS: 'NONE' })).toEqual({});
  });

  it('refuses garbage, naming the variable', () => {
    for (const [k, v] of [['FACTORY_SANDBOX_PIDS', '1.5'], ['FACTORY_SANDBOX_PIDS', '-1'], ['FACTORY_SANDBOX_MEMORY', '4 GB'], ['FACTORY_SANDBOX_MEMORY', 'lots'], ['FACTORY_SANDBOX_CPUS', 'two'], ['FACTORY_SANDBOX_CPUS', '1.']]) {
      expect(sandboxLimits({ [k!]: v })).toEqual({ refused: expect.stringMatching(`^${k}=${v}: `) });
    }
  });

  it('refuses a FACTORY_SANDBOX_MEMORY under 6m, the engines\' minimum, giving it (ORC-452)', () => {
    for (const size of ['5m', '6143k', '6143K', '6291455', '6291455b', '1k', '1']) {
      expect(sandboxLimits({ FACTORY_SANDBOX_MEMORY: size })).toEqual({ refused: `FACTORY_SANDBOX_MEMORY=${size}: at least 6m expected (the engines refuse less), or 0 / none for no limit.` });
    }
    for (const size of ['6m', '6M', '6144k', '6291456', '6291456b', '1g']) {
      expect(sandboxLimits({ FACTORY_SANDBOX_MEMORY: size })).toEqual(expect.objectContaining({ memory: size }));
    }
  });

  it("takes FACTORY_SANDBOX_MEMORY as docs/configuration.md writes it, each example as the row says (ORC-451, ORC-452)", () => {
    const row = readFileSync(join(import.meta.dirname, '../../docs/configuration.md'), 'utf8').split('\n').find((line) => line.startsWith('| `FACTORY_SANDBOX_MEMORY`'));
    expect(row).toContain('`^[1-9][0-9]*[bkmg]?$`');
    for (const [size, taken] of [['512m', true], ['4g', true], ['4G', true], ['1.5g', false], ['4gb', false], ['512 m', false], ['6m', true], ['6144k', true], ['6291456', true], ['5m', false]] as const) {
      expect(row).toContain(`\`${size}\``);
      expect(sandboxLimits({ FACTORY_SANDBOX_MEMORY: size })).toEqual(taken ? expect.objectContaining({ memory: size }) : { refused: expect.any(String) });
    }
  });
});

describe('browserImage (ORC-404)', () => {
  const engine = (answer: (args: string[]) => ExecResult) => {
    const calls: { cmd: string; args: string[] }[] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push({ cmd, args });
      return answer(args);
    };
    return { calls, exec };
  };
  const ok = (stdout: string): ExecResult => ({ stdout: `${stdout}\n`, stderr: '', code: 0 });
  const RUNNER = ['sha256:a', 'sha256:b'];
  /** The capture image with `label`, on `layers`; the runner image, on its own. */
  const images = (label: string, layers = [...RUNNER, 'sha256:c']) =>
    engine((a) => (a.at(-1) === 'factory-runner:1' ? ok(JSON.stringify(RUNNER)) : ok(`${label}\t${JSON.stringify(layers)}`)));
  const ENV = { FACTORY_CONTAINER_CLI: 'podman', FACTORY_BROWSER_IMAGE: 'localhost/factory-browser:1', FACTORY_RUNNER_IMAGE: 'factory-runner:1' };

  it('is none without sandboxes, with another engine CLI, or without FACTORY_BROWSER_IMAGE, and asks no engine', async () => {
    const e = images('playwright-1.64.1');
    expect(await browserImage({ FACTORY_BROWSER_IMAGE: 'x' }, e.exec)).toEqual({ detail: expect.stringMatching(/FACTORY_CONTAINER_CLI/) });
    expect(await browserImage({ FACTORY_CONTAINER_CLI: 'nerdctl', FACTORY_BROWSER_IMAGE: 'x' }, e.exec)).toEqual({ detail: expect.stringMatching(/nerdctl: docker or podman expected/) });
    expect(await browserImage({ FACTORY_CONTAINER_CLI: 'docker' }, e.exec)).toEqual({ detail: expect.stringMatching(/FACTORY_BROWSER_IMAGE is not set.*docker\/browser\.Dockerfile/) });
    expect(e.calls).toEqual([]);
  });

  it('is the image when the engine has it with the label of docker/browser.Dockerfile, on the runner image', async () => {
    const e = images('playwright-1.64.1');
    expect(await browserImage(ENV, e.exec)).toEqual({ image: 'localhost/factory-browser:1', detail: expect.stringContaining('localhost/factory-browser:1 (playwright-1.64.1)') });
    expect(e.calls).toEqual([
      { cmd: 'podman', args: ['image', 'inspect', '--format', '{{index .Config.Labels "factory.browser"}}\t{{json .RootFS.Layers}}', 'localhost/factory-browser:1'] },
      { cmd: 'podman', args: ['image', 'inspect', '--format', '{{json .RootFS.Layers}}', 'factory-runner:1'] },
    ]);
  });

  it('is none when the image is not a capture image (the runner\'s, say), or was built on another runner image', async () => {
    for (const label of ['', '<no value>']) {
      expect(await browserImage(ENV, images(label).exec)).toEqual({ detail: expect.stringMatching(/not a capture image.*factory\.browser/) });
    }
    expect(await browserImage(ENV, images('playwright-1.64.1', ['sha256:a', 'sha256:old', 'sha256:c']).exec)).toEqual({ detail: expect.stringMatching(/localhost\/factory-browser:1 was not built on factory-runner:1/) });
  });

  it('is none, and never rejects, when the engine lacks the image, fails, or cannot be run', async () => {
    const missing = engine(() => ({ stdout: '', stderr: 'Error: localhost/factory-browser:1: image not known', code: 125 }));
    expect(await browserImage(ENV, missing.exec)).toEqual({ detail: expect.stringMatching(/podman image inspect .* localhost\/factory-browser:1: Error: .*image not known/) });
    const hung = engine(() => ({ stdout: '', stderr: '', code: 124 }));
    expect((await browserImage(ENV, hung.exec)).detail).toMatch(/localhost\/factory-browser:1: exit 124$/);
    const absent: Exec = () => Promise.reject(new Error('spawn podman ENOENT'));
    expect(await browserImage(ENV, absent)).toEqual({ detail: 'spawn podman ENOENT' });
  });
});

describe('makeSandboxes and the browser (ORC-404)', () => {
  const egress = { open: async () => '/n/r1/egress.sock', close: async () => {}, isOpen: () => false, caCertPath: '/ca.crt' } as unknown as Egress;
  const ENV = { FACTORY_CONTAINER_CLI: 'docker', FACTORY_RUNNER_IMAGE: 'factory-runner:1' };
  const request = { runId: 'r1', ticketId: 'T-1', workspacePath: '/w', network: 'none' as const, requirements: BROWSER_REQUIREMENTS, mounts: [] };
  /** An engine with no container yet, Docker's: `run` prints the new id. */
  const engine = () => {
    const runs: string[][] = [];
    const exec: Exec = async (_cmd, args) => {
      if (args[0] === 'version') return { stdout: '{"Os":"linux","Arch":"amd64"}', stderr: '', code: 0 };
      if (args[0] === 'run') runs.push(args);
      return { stdout: args[0] === 'run' ? 'c1\n' : '', stderr: '', code: 0 };
    };
    return { runs, exec };
  };

  it('refuses a sandbox with a browser without the capture image', async () => {
    const e = engine();
    await expect(makeSandboxes(ENV, 'i', egress, { exec: e.exec })!.create(request)).rejects.toThrow(/container lacks browser/);
    expect(e.runs).toEqual([]);
  });

  it('serves requirements.browser on the capture image once it is given', async () => {
    const e = engine();
    await makeSandboxes(ENV, 'i', egress, { browserImage: 'factory-browser:1', exec: e.exec })!.create(request);
    expect(e.runs[0]).toContain('factory-browser:1');
  });
});
