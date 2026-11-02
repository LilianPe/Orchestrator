import { describe, expect, it } from 'vitest';
import { cli, enabled, useSandboxes } from './helpers.js';

/**
 * Isolation n° 2 (ORC-218): the kernel surface. The image has no keyctl nor strace, but perl-base is in
 * every Debian image: its `syscall` calls by number, so the probe needs the architecture's table.
 */
const KEYCTL: Record<string, number> = { x86_64: 250, aarch64: 219 };
const KEYCTL_GET_KEYRING_ID = 0;
const KEY_SPEC_SESSION_KEYRING = -3;
const EPERM = 1;

describe.skipIf(!enabled)(`kernel surface (${cli}, isolation n° 2)`, () => {
  const { create, sh } = useSandboxes('02');

  it('runs under a seccomp filter', async () => {
    const { id } = await create();
    expect((await sh(id, 'cat /proc/self/status')).stdout).toMatch(/^Seccomp:\s+2$/m);
  });

  it('is refused keyctl by seccomp: EPERM where the kernel would hand out the session keyring', async (ctx) => {
    const { id } = await create();
    const nr = KEYCTL[(await sh(id, 'uname -m')).stdout];
    // ponytail: an unknown architecture falls back on the seccomp mode above.
    if (nr === undefined) return ctx.skip();
    // Unfiltered, these arguments return the keyring's id (and create it if need be): only the filter answers -1 EPERM.
    // Module loading is not probed: without CAP_SYS_MODULE (n° 1) it is EPERM with or without seccomp.
    const r = await sh(id, `perl -e 'my $r = syscall(${nr}, ${KEYCTL_GET_KEYRING_ID}, ${KEY_SPEC_SESSION_KEYRING}, 1); print "$r ", $! + 0'`);
    expect(r.stdout).toBe(`-1 ${EPERM}`);
  });
});
