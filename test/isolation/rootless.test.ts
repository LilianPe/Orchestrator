import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const enabled = process.env['FACTORY_ISOLATION'] === '1';

describe.skipIf(!enabled)('rootless container engine', () => {
  it('runs rootless', () => {
    let rootless: string;
    try {
      rootless = execFileSync('podman', ['info', '--format', '{{.Host.Security.Rootless}}'], {
        encoding: 'utf8',
        timeout: 60_000,
      }).trim();
    } catch (error) {
      throw new Error(`podman is not available: ${(error as Error).message}`, { cause: error });
    }
    expect(rootless).toBe('true');
  });
});
