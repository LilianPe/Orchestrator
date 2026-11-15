import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecResult } from '../adapters/exec.js';
import { probeStart } from './preview-probe.js';

/** A sandbox that runs the probe on this host, in a dir of its own: the script itself is what is under test. */
function host() {
  const cwd = mkdtempSync(join(tmpdir(), 'factory-probe-'));
  const seen: { argv: readonly string[]; env: Record<string, string> }[] = [];
  return {
    seen,
    exec: async (_id: string, argv: readonly string[], opts?: { env?: Record<string, string> }): Promise<ExecResult> => {
      seen.push({ argv, env: opts?.env ?? {} });
      const p = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8', env: { ...process.env, ...opts?.env } });
      return { stdout: p.stdout, stderr: p.stderr, code: p.status ?? 1 };
    },
  };
}

const port = () => 20000 + Math.floor(Math.random() * 20000);
const SERVER = `exec node -e "require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT)"`;

describe('the probe of a start recipe the agent found (ORC-386)', () => {
  it('answers once the application serves HTTP on PORT, with the variables of the repository', async () => {
    const sandboxes = host();
    const res = await probeStart(sandboxes, 'box', { start: SERVER, port: port(), env: { APP_MODE: 'demo' }, waitS: 20 });
    expect(res).toEqual({ answered: true });
    expect(sandboxes.seen[0]!.env).toEqual({ APP_MODE: 'demo' });
  });

  it('an application that never listens: not answered, with the tail of what it printed', async () => {
    const sandboxes = host();
    const p = port();
    const res = await probeStart(sandboxes, 'box', { start: 'echo "Error: Cannot find module vite"; exit 1', port: p, env: {}, waitS: 2 });
    expect(res).toEqual({ answered: false, detail: expect.stringContaining('Cannot find module vite') });
    expect(res.answered ? '' : res.detail).toContain(`nothing answers on port ${p}`);
  });

  it('something that listens but speaks no HTTP is no answer', async () => {
    const sandboxes = host();
    const tcp = `exec node -e "require('net').createServer((c) => c.end('hello')).listen(process.env.PORT)"`;
    const res = await probeStart(sandboxes, 'box', { start: tcp, port: port(), env: {}, waitS: 3 });
    expect(res.answered).toBe(false);
  });
});
