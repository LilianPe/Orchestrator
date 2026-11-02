import { describe, expect, it } from 'vitest';
import { cli, enabled, podman, useSandboxes } from './helpers.js';

/**
 * Isolation n° 1 (ORC-218): what --cap-drop ALL and no-new-privileges leave a process that tries to
 * leave its container through the runtime. Seccomp and the kernel's own refusals are n° 2.
 */
describe.skipIf(!enabled)(`runtime escape (${cli}, isolation n° 1)`, () => {
  const { create, sh } = useSandboxes('01');

  it('runs with no capability and no_new_privs', async () => {
    const { id } = await create();
    const status = (await sh(id, 'cat /proc/self/status')).stdout;
    expect(status).toMatch(/^CapEff:\s+0+$/m);
    expect(status).toMatch(/^CapPrm:\s+0+$/m);
    expect(status).toMatch(/^NoNewPrivs:\s+1$/m);
  });

  it('cannot mount, nor write /proc/sys', async () => {
    const { id } = await create();
    expect((await sh(id, 'mount -t tmpfs x /tmp')).code).not.toBe(0);
    expect((await sh(id, 'mount --bind /work /mnt')).code).not.toBe(0);
    const procSys = await sh(id, 'echo x > /proc/sys/kernel/domainname');
    expect(procSys.code).not.toBe(0);
    expect(procSys.stderr).toMatch(/read-only/i);
  });

  // Docker's default seccomp profile refuses a new user namespace without CAP_SYS_ADMIN. Podman's lets
  // it through to the kernel, whose answer depends on the host (sysctls, AppArmor): not asserted there,
  // a nested namespace owning nothing more than the container already does.
  it.skipIf(podman)('cannot create a user namespace', async () => {
    const { id } = await create();
    expect((await sh(id, 'unshare -U true')).code).not.toBe(0);
    expect((await sh(id, 'unshare -r true')).code).not.toBe(0);
  });

  it("sees only its own processes, pid 1 being the container's", async () => {
    const { id } = await create();
    expect((await sh(id, "tr '\\0' ' ' < /proc/1/cmdline")).stdout).toBe('sleep infinity');
    // sleep, the exec'd sh and its ls: a host's hundreds of processes would show here.
    const pids = (await sh(id, "ls /proc | grep -E '^[0-9]+$'")).stdout.split('\n');
    expect(pids.length).toBeLessThan(10);
  });
});
