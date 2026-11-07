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

  it('leaves a command that ends in time as it is', async () => {
    expect(await execCmd('sh', ['-c', 'echo ok'], { timeoutMs: 5_000 })).toEqual({ stdout: 'ok\n', stderr: '', code: 0 });
  });
});
