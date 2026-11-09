import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeSandboxProvider } from '../adapters/sandbox/fake.js';
import { POSTGRES_DUMP, RELEASE_AGE_DAYS, runSealedSetup, sealSecrets, setupEnv, YARN1_NO_SCRIPTS } from './sealed-setup.js';
import { VERIFY_TIMEOUT_MS } from './verify.js';

const SECRET = 's3cr3t-value/with+chars';
const NOW = new Date('2026-11-04T12:00:00.000Z');

function tree(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'factory-seal-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe('sealSecrets', () => {
  it('purges every file holding the secret, as written or as a tool encodes it, and leaves the others', async () => {
    const root = tree({
      '.env': `TOKEN=${SECRET}\n`,
      'deep/er/.npmrc': `//r/:_authToken=${encodeURIComponent(SECRET)}\n`,
      'b64.txt': Buffer.from(SECRET).toString('base64'),
      'config.json': JSON.stringify({ token: 'pre"' + SECRET }),
      'src/kept.ts': 'export const a = 1;\n',
    });
    const purged = await sealSecrets([root], [SECRET]);
    expect(purged.sort()).toEqual([join(root, '.env'), join(root, 'b64.txt'), join(root, 'config.json'), join(root, 'deep/er/.npmrc')].sort());
    expect(purged.some((p) => existsSync(p))).toBe(false);
    expect(readFileSync(join(root, 'src/kept.ts'), 'utf8')).toContain('a = 1');
  });

  it.each(['', 'u:', 'us:', 'user:', 'a-longer-user:'])('finds the secret inside a base64 credential, after %j', async (prefix) => {
    const value = Buffer.from(`${prefix}${SECRET}`);
    const root = tree({ std: value.toString('base64'), url: value.toString('base64url'), suffixed: Buffer.from(`${prefix}${SECRET}:x`).toString('base64'), other: Buffer.from(`${prefix}not-the-value`).toString('base64') });
    expect((await sealSecrets([root], [SECRET])).map((p) => p.slice(root.length + 1)).sort()).toEqual(['std', 'suffixed', 'url']);
  });

  it("leaves the root's own .git, read-only for the setup, and a pack of its history whole; a nested one is looked at (ORC-317)", async () => {
    const root = tree({ '.git/objects/pack/pack-1.pack': SECRET, 'vendor/x/.git/config': SECRET, 'a.txt': 'clean' });
    expect(await sealSecrets([root], [SECRET])).toEqual([join(root, 'vendor/x/.git/config')]);
    expect(existsSync(join(root, '.git/objects/pack/pack-1.pack'))).toBe(true);
  });

  it('finds a secret across two read chunks of a large file', async () => {
    const before = Buffer.alloc(1024 * 1024 - 5, 'x');
    const root = tree({ 'big.bin': Buffer.concat([before, Buffer.from(SECRET), Buffer.alloc(100, 'y')]) });
    expect(await sealSecrets([root], [SECRET])).toEqual([join(root, 'big.bin')]);
  });

  it('never follows a link out of the tree', async () => {
    const outside = tree({ 'host.txt': SECRET });
    const root = tree({ 'kept.txt': 'x' });
    try {
      symlinkSync(join(outside, 'host.txt'), join(root, 'link'));
    } catch {
      return; // no symlink right on this host (Windows without developer mode)
    }
    expect(await sealSecrets([root], [SECRET])).toEqual([]);
    expect(existsSync(join(outside, 'host.txt'))).toBe(true);
  });

  it('purges a file it cannot read: what cannot be checked does not stay', async () => {
    const root = tree({ 'locked.txt': 'whatever' });
    chmodSync(join(root, 'locked.txt'), 0o000);
    const purged = await sealSecrets([root], [SECRET]);
    // Windows and root ignore the mode: the file is then read, and holds no secret.
    if (purged.length) expect(existsSync(join(root, 'locked.txt'))).toBe(false);
  });

  it('does nothing without a secret, nor on a missing tree', async () => {
    const root = tree({ 'a.txt': 'x' });
    expect(await sealSecrets([root], [])).toEqual([]);
    expect(await sealSecrets([root], [''])).toEqual([]);
    expect(await sealSecrets([join(root, 'missing')], [SECRET])).toEqual([]);
    expect(existsSync(join(root, 'a.txt'))).toBe(true);
  });
});

describe('setupEnv', () => {
  it('cuts the install scripts of npm, pnpm and Yarn, and the source packages of pip and uv', () => {
    expect(setupEnv(NOW)).toMatchObject({
      npm_config_ignore_scripts: 'true',
      YARN_ENABLE_SCRIPTS: 'false',
      PIP_ONLY_BINARY: ':all:',
      UV_NO_BUILD: '1',
    });
  });

  it('runs no hook of the git dir an earlier agent could write', () => {
    expect(setupEnv(NOW)).toMatchObject({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false' });
  });

  it('never sets YARN_IGNORE_SCRIPTS: Yarn 4 refuses to run under it', () => {
    expect(setupEnv(NOW)).not.toHaveProperty('YARN_IGNORE_SCRIPTS');
  });

  it('refuses the versions younger than the release age, for each package manager in its own unit', () => {
    const cutoff = new Date(NOW.getTime() - RELEASE_AGE_DAYS * 86_400_000).toISOString();
    expect(setupEnv(NOW)).toMatchObject({
      npm_config_minimum_release_age: String(RELEASE_AGE_DAYS * 24 * 60),
      npm_config_before: cutoff,
      UV_EXCLUDE_NEWER: cutoff,
    });
  });
});

// A test that moves the clock past the cap (ORC-348) leaves it as it found it.
afterEach(() => {
  vi.useRealTimers();
});

describe('runSealedSetup', () => {
  const request = (workspacePath: string, over: Partial<Parameters<typeof runSealedSetup>[1]> = {}) => ({
    runId: 'r1',
    ticketId: 'REL-1',
    workspacePath,
    mounts: [{ host: '/repo/.git', target: '/repo/.git', readOnly: true }],
    commands: ['npm ci'],
    env: { NODE_ENV: 'test' },
    secrets: { NPM_TOKEN: SECRET },
    now: NOW,
    ...over,
  });

  it('runs in a sandbox of its own: the worktree, what it is told to mount, the network of the registries, and nothing else', async () => {
    const sandboxes = new FakeSandboxProvider();
    await runSealedSetup(sandboxes, request(tree({})));
    expect(sandboxes.created).toHaveLength(1);
    expect(sandboxes.created[0]).toMatchObject({ runId: 'r1-setup', ticketId: 'REL-1', network: 'limited', mounts: [{ host: '/repo/.git', target: '/repo/.git', readOnly: true }] });
  });

  it('gives the commands the hardening, the declared variables and the secrets, through the exec env alone', async () => {
    const sandboxes = new FakeSandboxProvider();
    await runSealedSetup(sandboxes, request(tree({})));
    expect(sandboxes.execs).toEqual([
      { id: 'sbx-1', argv: YARN1_NO_SCRIPTS, opts: { env: { HOME: setupEnv(NOW)['HOME']! } } },
      { id: 'sbx-1', argv: ['timeout', '900', 'bash', '--norc', '-c', 'npm ci'], opts: { env: { NODE_ENV: 'test', NPM_TOKEN: SECRET, ...setupEnv(NOW) } } },
    ]);
  });

  it('fails when the rc file of Yarn 1 cannot be written: its install scripts would run with the secrets', async () => {
    const sandboxes = new FakeSandboxProvider();
    sandboxes.execResult = (argv) => ({ stdout: '', stderr: 'read-only', code: argv === YARN1_NO_SCRIPTS ? 1 : 0 });
    await expect(runSealedSetup(sandboxes, request(tree({})))).rejects.toThrow('Yarn 1');
    expect(sandboxes.active()).toEqual([]);
  });

  it('the hardening wins over a variable of the same name', async () => {
    const sandboxes = new FakeSandboxProvider();
    await runSealedSetup(sandboxes, request(tree({}), { env: { npm_config_ignore_scripts: 'false' }, secrets: {} }));
    expect(sandboxes.execs.at(-1)!.opts!.env!['npm_config_ignore_scripts']).toBe('true');
  });

  it('destroys the container, then purges the disk', async () => {
    const root = tree({});
    const sandboxes = new FakeSandboxProvider();
    // What the commands leave behind them, written while the container lives.
    sandboxes.execResult = () => {
      writeFileSync(join(root, '.env'), SECRET);
      return { stdout: '', stderr: '', code: 0 };
    };
    const destroy = vi.spyOn(sandboxes, 'destroy').mockImplementation(async (id) => {
      expect(existsSync(join(root, '.env'))).toBe(true);
      sandboxes.destroyed.push(id);
    });
    expect(await runSealedSetup(sandboxes, request(root))).toEqual({ purged: [join(root, '.env')] });
    expect(destroy).toHaveBeenCalledOnce();
    expect(existsSync(join(root, '.env'))).toBe(false);
  });

  it('a failed command still destroys the container and purges the disk, and says which command', async () => {
    const root = tree({ '.env': SECRET });
    const sandboxes = new FakeSandboxProvider();
    sandboxes.execResult = (argv) => ({ stdout: '', stderr: 'boom', code: argv[0] === 'timeout' ? 1 : 0 });
    await expect(runSealedSetup(sandboxes, request(root, { commands: ['npm ci', 'never'] }))).rejects.toThrow('The worktree setup failed: npm ci');
    expect(sandboxes.execs.map((e) => e.argv.at(-1))).not.toContain('never');
    expect(sandboxes.active()).toEqual([]);
    expect(existsSync(join(root, '.env'))).toBe(false);
  });

  it('a command over its cap fails as a timeout', async () => {
    const sandboxes = new FakeSandboxProvider();
    // The factory's clock past the cap while the command runs: an expiry, as the factory sees one (ORC-348).
    sandboxes.execResult = (argv) => {
      if (argv[0] === 'timeout') vi.setSystemTime(Date.now() + VERIFY_TIMEOUT_MS);
      return { stdout: '', stderr: '', code: argv[0] === 'timeout' ? 124 : 0 };
    };
    await expect(runSealedSetup(sandboxes, request(tree({})))).rejects.toThrow('npm ci (timed out after 15 min)');
  });

  it('a command that exits 124 itself, before its cap, fails as itself, not as a timeout (ORC-348)', async () => {
    const sandboxes = new FakeSandboxProvider();
    sandboxes.execResult = (argv) => ({ stdout: '', stderr: '', code: argv[0] === 'timeout' ? 124 : 0 });
    await expect(runSealedSetup(sandboxes, request(tree({})))).rejects.toThrow(/^The worktree setup failed: npm ci$/);
  });

  it('fails when its container cannot be destroyed: a process that holds the secret could still write it', async () => {
    const sandboxes = new FakeSandboxProvider();
    vi.spyOn(sandboxes, 'destroy').mockRejectedValue(new Error('engine down'));
    await expect(runSealedSetup(sandboxes, request(tree({})))).rejects.toThrow('engine down');
  });

  describe("with the repository's services (ORC-309)", () => {
    const pg = { services: ['postgres'] };
    const dumps = (s: FakeSandboxProvider) => s.execs.filter((e) => e.argv[0] === 'pg_dumpall');

    it("opens the attempt's services, not the setup's own, and keeps them for the agent", async () => {
      const sandboxes = new FakeSandboxProvider();
      await runSealedSetup(sandboxes, request(tree({}), pg));
      expect(sandboxes.created[0]).toMatchObject({ runId: 'r1-setup', servicesOf: 'r1', requirements: { services: ['postgres'] } });
      expect(sandboxes.active()).toEqual([]);
      expect(sandboxes.activeServices()).toEqual(['svc-1']);
    });

    it('dumps the database once the setup container is gone, through the services own container', async () => {
      const sandboxes = new FakeSandboxProvider();
      let aliveAtDump: string[] = [];
      sandboxes.execResult = (argv) => {
        if (argv[0] === 'pg_dumpall') aliveAtDump = sandboxes.active().map((s) => s.id);
        return { stdout: 'COPY public.t (v) FROM stdin;\nclean\n', stderr: '', code: 0 };
      };
      await runSealedSetup(sandboxes, request(tree({}), pg));
      expect(dumps(sandboxes)).toEqual([{ id: 'svc-1', argv: POSTGRES_DUMP, opts: { cwd: '/' } }]);
      expect(aliveAtDump).toEqual([]);
    });

    it.each([
      ['as written', SECRET],
      ['in base64', Buffer.from(`user:${SECRET}`).toString('base64')],
      ['in a URL', encodeURIComponent(SECRET)],
    ])('a secret the setup wrote in the database (%s) fails it, without the value, and takes the services with it', async (_, spelling) => {
      const sandboxes = new FakeSandboxProvider();
      sandboxes.execResult = (argv) => ({ stdout: argv[0] === 'pg_dumpall' ? `COPY public.settings (v) FROM stdin;\n${spelling}\n` : '', stderr: '', code: 0 });
      const err = await runSealedSetup(sandboxes, request(tree({}), pg)).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('The worktree setup failed: a secret of the setup is in its database (NPM_TOKEN)');
      expect((err as Error).message).not.toContain(SECRET);
      expect(sandboxes.activeServices()).toEqual([]);
    });

    it('a database that cannot be dumped fails the setup: what cannot be checked does not stay', async () => {
      const sandboxes = new FakeSandboxProvider();
      sandboxes.execResult = (argv) => ({ stdout: '', stderr: argv[0] === 'pg_dumpall' ? 'connection refused' : '', code: argv[0] === 'pg_dumpall' ? 1 : 0 });
      await expect(runSealedSetup(sandboxes, request(tree({}), pg))).rejects.toThrow('could not be checked for the secrets (connection refused)');
      expect(sandboxes.activeServices()).toEqual([]);
    });

    it('without a secret there is nothing to find: no dump', async () => {
      const sandboxes = new FakeSandboxProvider();
      await runSealedSetup(sandboxes, request(tree({}), { ...pg, secrets: {} }));
      expect(dumps(sandboxes)).toEqual([]);
    });

    it('a failed command takes the services with it: no agent follows', async () => {
      const sandboxes = new FakeSandboxProvider();
      sandboxes.execResult = (argv) => ({ stdout: '', stderr: '', code: argv[0] === 'timeout' ? 1 : 0 });
      await expect(runSealedSetup(sandboxes, request(tree({}), pg))).rejects.toThrow('npm ci');
      expect(sandboxes.activeServices()).toEqual([]);
    });

    it('a backend that gives no services container to check fails the setup', async () => {
      const sandboxes = new FakeSandboxProvider();
      const create = sandboxes.create.bind(sandboxes);
      sandboxes.create = async (req) => ({ ...(await create(req)), services: undefined });
      await expect(runSealedSetup(sandboxes, request(tree({}), pg))).rejects.toThrow('cannot be checked');
    });
  });
});
