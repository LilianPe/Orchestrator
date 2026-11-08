import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXEC_TIMEOUT_MS, execCmd, TIMED_OUT } from './exec.js';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === 'win32')('execCmd with a deadline', () => {
  it('kills the command and what it started past the deadline: a stalled ssh under git dies with it', async () => {
    const started = Date.now();
    // A child that starts a grandchild and waits for it, as git waits for ssh; the grandchild prints its pid first.
    const r = await execCmd('sh', ['-c', 'sleep 30 & echo $!; wait'], { timeoutMs: 200 });
    expect(r.code).toBe(TIMED_OUT);
    expect(Date.now() - started).toBeLessThan(5_000);
    const grandchild = Number(r.stdout.trim());
    expect(grandchild).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(grandchild)).toBe(false);
  });

  it('gives the code of a command that ended before the deadline, even when what it left holds its output past it', async () => {
    const started = Date.now();
    // It exits at once; its background child keeps the pipe open until the deadline kills the group.
    const r = await execCmd('sh', ['-c', 'sleep 30 & exit 3'], { timeoutMs: 300 });
    expect(r.code).toBe(3);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  // `setsid` is Linux's: elsewhere nothing would hold the output, and the test would pass without the fix.
  it.skipIf(process.platform !== 'linux')('answers at the deadline for a command that ended before it, when what holds its output left its group', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-exec-'));
    const pidFile = join(dir, 'holder.pid');
    const started = Date.now();
    try {
      // Its child in a session of its own, holding stdout: the group's kill misses it, and 'close' never comes.
      const r = await execCmd('sh', ['-c', `setsid sh -c 'echo $$ > ${pidFile}; exec sleep 30' & exit 0`], { timeoutMs: 300 });
      expect(r.code).toBe(0);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
      } catch {
        // Not started, or already gone.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('gives every command a deadline by default: one that never returns is killed with its group at it (ORC-344)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-exec-'));
    const pidFile = join(dir, 'grandchild.pid');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = execCmd('sh', ['-c', `sleep 3000 & echo $! > ${pidFile}; wait`]);
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.waitFor(() => expect(readFileSync(pidFile, 'utf8').trim()).not.toBe(''));
      const grandchild = Number(readFileSync(pidFile, 'utf8'));
      await vi.advanceTimersByTimeAsync(DEFAULT_EXEC_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).code).toBe(TIMED_OUT);
      await vi.waitFor(() => expect(alive(grandchild)).toBe(false));
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a command that ends in time as it is', async () => {
    expect(await execCmd('sh', ['-c', 'echo ok'], { timeoutMs: 5_000 })).toEqual({ stdout: 'ok\n', stderr: '', code: 0 });
  });
});

describe('execCmd with maxStdout', () => {
  const print = (n: number) => ['-e', `process.stdout.write('x'.repeat(${n}))`];

  it('keeps an output under maxStdout whole', async () => {
    expect(await execCmd(process.execPath, print(1000), { maxStdout: 1000 })).toEqual({ stdout: 'x'.repeat(1000), stderr: '', code: 0 });
  });

  it('past maxStdout, kills the process and keeps nothing of its output', async () => {
    const r = await execCmd(process.execPath, print(1_000_000), { maxStdout: 1000 });
    expect(r).toMatchObject({ stdout: '', overflow: true });
  });
});
