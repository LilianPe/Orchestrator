import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { systemEnv } from '../adapters/exec.js';
import { verifyCommand } from './clean-verify.js';
import { cappedCommand } from './verify.js';

// `verify` and `setup` run in sandboxes alone (ORC-151, ORC-179): their commands, as the image's shell runs them.
describe('loads no login profile: what the machine prints there is not the command output (ORC-324)', () => {
  function home(): string {
    const dir = mkdtempSync(join(tmpdir(), 'factory-home-'));
    for (const file of ['.bash_profile', '.profile', '.bashrc', '.bash_logout']) writeFileSync(join(dir, file), `printf 'from ${file}\\n'; printf 'err ${file}\\n' >&2\n`);
    return dir;
  }

  // GNU `timeout`, as in the images. On the host: none on macOS, and Windows' own `timeout.exe` first on a PATH out of Git Bash.
  const gnuTimeout = spawnSync('timeout', ['--version'], { encoding: 'utf8' }).stdout?.includes('coreutils') ?? false;
  it.skipIf(!gnuTimeout).each([
    ['setup in a sandbox', cappedCommand],
    ['verify in a sandbox', verifyCommand],
  ])('%s', (_, argv) => {
    const [cmd, ...args] = argv('echo boom >&2; exit 3');
    const r = spawnSync(cmd!, args, { env: { ...systemEnv(process.env), HOME: home() }, encoding: 'utf8' });
    expect(r.status).toBe(3);
    expect(r.stdout + r.stderr).toBe('boom\n');
  });
});
