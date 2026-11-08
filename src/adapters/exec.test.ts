import { describe, expect, it } from 'vitest';
import { execCmd, TIMED_OUT } from './exec.js';

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

  it('answers at the deadline for a command that ended before it, when what holds its output left its group', async () => {
    const started = Date.now();
    // Its child in a session of its own, holding stdout: the group's kill misses it, and 'close' never comes.
    const r = await execCmd('sh', ['-c', 'setsid sleep 30 & echo $!; exit 0'], { timeoutMs: 300 });
    try {
      expect(r.code).toBe(0);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      try {
        process.kill(Number(r.stdout.trim()), 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }, 10_000);

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
