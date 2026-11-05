import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { cli, enabled, image } from './helpers.js';

const built = enabled && !!process.env['FACTORY_RUNNER_IMAGE'];

/** docker/runner.Dockerfile (ORC-203): skipped on the public node image the other isolation tests default to. */
describe.skipIf(!built)(`the runner image (${cli})`, () => {
  const inImage = (script: string) => execFileSync(cli, ['run', '--rm', '--network', 'none', image, 'sh', '-c', script], { encoding: 'utf8', timeout: 60_000 }).trim();

  it.each([
    ['node', 'node --version', /^v24\./],
    ['pnpm', 'pnpm --version', /^10\.20\.0$/],
    ['python', 'python3 --version', /^Python 3\./],
    ['uv', 'uv --version', /^uv 0\.13\.7/],
    ['git', 'git --version', /^git version/],
    ['gitleaks', 'gitleaks version', /^v?8\.30\.1/],
    ['claude', 'claude --version', /^2\.1\.316/],
  ])('has %s', (_name, command, expected) => {
    expect(inImage(command)).toMatch(expected);
  });

  it('has neither gh nor an engine CLI, nor any daemon code', () => {
    // One name at a time: dash's `command -v` looks at its first operand only.
    expect(inImage('for c in gh docker podman; do command -v "$c"; done; echo end')).toBe('end');
    expect(inImage('ls /app 2>/dev/null || echo none')).toBe('none');
  });
});
