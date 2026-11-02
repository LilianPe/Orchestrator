import { describe, expect, it } from 'vitest';
import { cli, enabled, useSandboxes } from './helpers.js';

/**
 * Isolation n° 2 (ORC-218): the kernel surface. The image has no keyctl nor strace, but perl-base is in
 * every Debian image: its `syscall` calls by number, so the probes need the architecture's table.
 */
const SYSCALLS: Record<string, Record<string, number>> = {
  x86_64: { keyctl: 250, ptrace: 101, init_module: 175, finit_module: 313 },
  aarch64: { keyctl: 219, ptrace: 117, init_module: 105, finit_module: 273 },
};
const PTRACE_ATTACH = 16;

describe.skipIf(!enabled)(`kernel surface (${cli}, isolation n° 2)`, () => {
  const { create, sh } = useSandboxes('02');

  it('runs under a seccomp filter', async () => {
    const { id } = await create();
    expect((await sh(id, 'cat /proc/self/status')).stdout).toMatch(/^Seccomp:\s+2$/m);
  });

  it('is refused keyctl, ptrace of pid 1 and module loading', async (ctx) => {
    const { id } = await create();
    const table = SYSCALLS[(await sh(id, 'uname -m')).stdout];
    // ponytail: an unknown architecture falls back on the seccomp mode above and CapEff = 0 (n° 1).
    if (!table) return ctx.skip();
    const probe = async (args: string) => (await sh(id, `perl -e 'print syscall(${args})'`)).stdout;
    expect(await probe(`${table['keyctl']}, 0, 0, 0, 0, 0`)).toBe('-1');
    // Same uid as pid 1, so only seccomp or Yama stands in the way.
    expect(await probe(`${table['ptrace']}, ${PTRACE_ATTACH}, 1, 0, 0`)).toBe('-1');
    expect(await probe(`${table['init_module']}, 0, 0, 0`)).toBe('-1');
    expect(await probe(`${table['finit_module']}, 0, 0, 0`)).toBe('-1');
  });
});
