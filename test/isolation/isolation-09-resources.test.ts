import { describe, expect, it } from 'vitest';
import { cli, enabled, useSandboxes } from './helpers.js';

/**
 * Isolation n° 9 (ORC-218): a fork bomb or a memory hog in one sandbox does not starve its neighbour.
 * The engine enforces the provider's limits through the container's cgroup (v2, delegated to the user
 * under rootless Podman): the defaults are read back from it, the exhaustion runs under small limits.
 */
describe.skipIf(!enabled)(`resource exhaustion (${cli}, isolation n° 9)`, () => {
  const defaults = useSandboxes('09');
  const small = useSandboxes('09-small', { limits: { pids: 64, memory: '128m', cpus: 1 } });

  it('caps every sandbox by default: 512 processes, 4 GiB and no swap, 2 cpus', async () => {
    const { id } = await defaults.create();
    expect((await defaults.sh(id, 'cat /sys/fs/cgroup/pids.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/cpu.max')).stdout.split('\n')).toEqual([
      '512',
      String(4 * 1024 ** 3),
      '0',
      '200000 100000',
    ]);
  });

  it('stops a fork bomb at its pids limit, the neighbour still answering', async () => {
    const a = await small.create();
    const b = await small.create();
    // More sleepers than the limit: the shell's forks start failing once it is reached.
    const bomb = await small.sh(a.id, 'for i in $(seq 200); do sleep 300 & done');
    expect(bomb.stderr).toMatch(/fork/i);
    const t = Date.now();
    expect((await small.provider.exec(b.id, ['true'])).code).toBe(0);
    expect(Date.now() - t).toBeLessThan(10_000);
  });

  it('OOM-kills a memory hog (137), the neighbour still answering', async () => {
    const a = await small.create();
    const b = await small.create();
    const hog = await small.sh(a.id, `node -e 'const a = []; for (;;) a.push(Buffer.alloc(16 << 20, 1))'`);
    expect(hog.code).toBe(137);
    expect((await small.provider.exec(b.id, ['true'])).code).toBe(0);
  });
});
