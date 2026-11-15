import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Exec, ExecResult } from '../adapters/exec.js';
import { BROWSER_REQUIREMENTS } from '../adapters/browser/types.js';
import { defaultLimits } from '../adapters/sandbox/docker-rootless.js';
import type { Egress } from '../network/proxy-service.js';
import { browserImage, checkHostRuns, instanceId, makeSandboxes, sandboxLimits } from './sandbox-wiring.js';

describe('checkHostRuns (ORC-349)', () => {
  it('refuses agents on the host without a container engine, naming both ways out', () => {
    expect(() => checkHostRuns({})).toThrow(/FACTORY_CONTAINER_CLI.*FACTORY_ALLOW_HOST_RUNS=1/s);
    // Only `1` is the explicit choice: anything else is not.
    for (const v of ['', '0', 'true', 'yes']) expect(() => checkHostRuns({ FACTORY_ALLOW_HOST_RUNS: v })).toThrow();
  });

  it('lets a container engine, or the explicit choice of the host, through', () => {
    expect(() => checkHostRuns({ FACTORY_CONTAINER_CLI: 'podman' })).not.toThrow();
    expect(() => checkHostRuns({ FACTORY_ALLOW_HOST_RUNS: '1' })).not.toThrow();
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
      expect(() => sandboxLimits({ [k!]: v })).toThrow(`${k}=${v}`);
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
  const labelled = (label: string) => engine(() => ({ stdout: `${label}\n`, stderr: '', code: 0 }));
  const ENV = { FACTORY_CONTAINER_CLI: 'podman', FACTORY_BROWSER_IMAGE: 'localhost/factory-browser:1' };

  it('is none without sandboxes, or without FACTORY_BROWSER_IMAGE, and asks no engine', async () => {
    const e = labelled('playwright-1.64.1');
    expect(await browserImage({ FACTORY_BROWSER_IMAGE: 'x' }, e.exec)).toEqual({ detail: expect.stringMatching(/FACTORY_CONTAINER_CLI/) });
    expect(await browserImage({ FACTORY_CONTAINER_CLI: 'docker' }, e.exec)).toEqual({ detail: expect.stringMatching(/FACTORY_BROWSER_IMAGE is not set.*docker\/browser\.Dockerfile/) });
    expect(e.calls).toEqual([]);
  });

  it('is the image when the engine has it with the label of docker/browser.Dockerfile', async () => {
    const e = labelled('playwright-1.64.1');
    expect(await browserImage(ENV, e.exec)).toEqual({ image: 'localhost/factory-browser:1', detail: expect.stringContaining('localhost/factory-browser:1 (playwright-1.64.1)') });
    expect(e.calls).toEqual([{ cmd: 'podman', args: ['image', 'inspect', '--format', '{{index .Config.Labels "factory.browser"}}', 'localhost/factory-browser:1'] }]);
  });

  it('is none when the engine lacks the image, or the image is not a capture image (the runner\'s, say)', async () => {
    const missing = engine(() => ({ stdout: '', stderr: 'Error: localhost/factory-browser:1: image not known', code: 125 }));
    expect(await browserImage(ENV, missing.exec)).toEqual({ detail: expect.stringMatching(/no image localhost\/factory-browser:1.*image not known/) });
    for (const label of ['', '<no value>']) {
      expect(await browserImage(ENV, labelled(label).exec)).toEqual({ detail: expect.stringMatching(/not a capture image.*factory\.browser/) });
    }
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
