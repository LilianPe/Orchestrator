import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { systemEnv } from '../adapters/exec.js';
import { verifyCommand } from './clean-verify.js';
import { cappedCommand, runVerify } from './verify.js';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-verify-'));
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  return dir;
}

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim();

describe('runVerify', () => {
  it('passes when every command exits 0', async () => {
    expect(await runVerify(process.cwd(), ['true', 'echo ok'])).toEqual({ ok: true, failures: [] });
  });

  it('collects failures with output and keeps going', async () => {
    const res = await runVerify(process.cwd(), ['echo boom >&2; exit 3', 'true', 'exit 1']);
    expect(res.ok).toBe(false);
    expect(res.failures).toEqual([
      { command: 'echo boom >&2; exit 3', exitCode: 3, output: 'boom\n' },
      { command: 'exit 1', exitCode: 1, output: '' },
    ]);
  });

  describe('loads no login profile: what the machine prints there is not the command output (ORC-324)', () => {
    function home(): string {
      const dir = mkdtempSync(join(tmpdir(), 'factory-home-'));
      for (const file of ['.bash_profile', '.profile', '.bashrc', '.bash_logout']) writeFileSync(join(dir, file), `printf 'from ${file}\\n'; printf 'err ${file}\\n' >&2\n`);
      return dir;
    }

    it('on the host', async () => {
      vi.stubEnv('HOME', home());
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      // Outside git: the failure has no fingerprint to take, of a whole repository.
      const res = await runVerify(mkdtempSync(join(tmpdir(), 'factory-nogit-')), ['echo boom >&2; exit 3']);
      expect(res.failures[0]!.output).toBe('boom\n');
    });

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

  it('gives its commands no credential of the daemon: they run what the agent wrote (ORC-211)', async () => {
    vi.stubEnv('ORG_REGISTRY_TOKEN', 'repo-secret');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'claude-token');
    vi.stubEnv('GH_TOKEN', 'gh-token');
    vi.stubEnv('SSH_AUTH_SOCK', '/ssh-agent');
    vi.stubEnv('LANG', 'C');
    const res = await runVerify(process.cwd(), ['echo "[$ORG_REGISTRY_TOKEN$CLAUDE_CODE_OAUTH_TOKEN$GH_TOKEN$SSH_AUTH_SOCK|$LANG]"; exit 1']);
    vi.unstubAllEnvs();
    expect(res.failures[0]!.output).toContain('[|C]');
  });

  it('gives its commands the variables the repository declares', async () => {
    const res = await runVerify(process.cwd(), ['echo "[$API_URL]"; exit 1'], undefined, { API_URL: 'https://api' });
    expect(res.failures[0]!.output).toContain('[https://api]');
  });

  it('times out', async () => {
    const res = await runVerify(process.cwd(), ['sleep 5'], 200);
    expect(res.failures[0]).toMatchObject({ command: 'sleep 5', exitCode: null });
  });

  it('resolves with a failure when cwd does not exist', async () => {
    const res = await runVerify('/nonexistent-factory-dir', ['true']);
    expect(res.ok).toBe(false);
    expect(res.failures[0]).toMatchObject({ command: 'true', exitCode: null });
  });

  it('kills compound commands promptly on timeout', async () => {
    const t = Date.now();
    const res = await runVerify(process.cwd(), ['sleep 5; true'], 200);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(res.failures[0]).toMatchObject({ command: 'sleep 5; true', exitCode: null });
  });

  it('fingerprints the worktree of a failed check, the same while nothing changes (ORC-187)', async () => {
    const dir = repo();
    const first = await runVerify(dir, ['exit 1']);
    const again = await runVerify(dir, ['exit 1']);
    expect(first.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(again.tree).toBe(first.tree);
    writeFileSync(join(dir, 'b.txt'), 'new file\n');
    expect((await runVerify(dir, ['exit 1'])).tree).not.toBe(first.tree);
  });

  it('leaves the index of the worktree untouched', async () => {
    const dir = repo();
    await runVerify(dir, ['exit 1']);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })).toBe('?? a.txt\n');
  });

  it('writes no object into the repository', async () => {
    const dir = repo();
    const objects = () => execFileSync('git', ['count-objects'], { cwd: dir, encoding: 'utf8' });
    const before = objects();
    writeFileSync(join(dir, 'c.txt'), 'more\n');
    expect((await runVerify(dir, ['exit 1'])).tree).toBeDefined();
    expect(objects()).toBe(before);
  });

  // `indexAt` within the second of the file: git trusts no entry as recent as its index, whatever the file's stat says.
  // The ctime cannot be set back, and it is not what the protection is about: `core.trustctime` takes it out of the comparison.
  // `touch`: `utimes` takes a double, too coarse for the last row. Not on Windows: a plain `copyFileSync` already keeps the date there.
  it.skipIf(process.platform === 'win32').each([
    ['at the start of its second', '000000000'],
    ['at the end of its second, where a `Date` rounds up', '999600000'],
    ['in its last nanoseconds, where `mtimeMs` rounds up', '999999950'],
  ])('sees an edit of the same size, with the same date, in the second of an index dated %s (ORC-318)', async (_, indexAt) => {
    const dir = repo();
    git(dir, 'config', 'core.trustctime', 'false');
    const second = Math.floor(Date.now() / 1000) - 100;
    utimesSync(join(dir, 'a.txt'), second, second);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    execFileSync('touch', ['-d', `@${second}.${indexAt}`, join(dir, '.git', 'index')]);
    const committed = git(dir, 'rev-parse', 'HEAD^{tree}');
    expect((await runVerify(dir, ['exit 1'])).tree).toBe(committed);
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    utimesSync(join(dir, 'a.txt'), second, second);
    expect((await runVerify(dir, ['exit 1'])).tree).not.toBe(committed);
  });

  it('reads a sparse worktree: what it hides is no deletion, a file written where it hides is a change (ORC-318)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-verify-'));
    git(dir, 'init', '-q');
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), '{}\n');
    writeFileSync(join(dir, '.claude', 'CLAUDE.md'), 'c\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    git(dir, 'sparse-checkout', 'set', '--no-cone', '/*', '!/.claude/*', '/.claude/CLAUDE.md');
    expect((await runVerify(dir, ['exit 1'])).tree).toBe(git(dir, 'rev-parse', 'HEAD^{tree}'));
    writeFileSync(join(dir, '.claude', 'settings.local.json'), 'one\n');
    const made = (await runVerify(dir, ['exit 1'])).tree;
    expect(made).toMatch(/^[0-9a-f]{40}$/);
    expect(made).not.toBe(git(dir, 'rev-parse', 'HEAD^{tree}'));
    expect(git(dir, 'ls-files', '-t', '.claude')).toBe('H .claude/CLAUDE.md\nS .claude/settings.json');
  });

  // What the agent writes in `.git/config` runs when the fingerprint is read: a clean filter without the daemon's
  // credentials, an fsmonitor not at all (ORC-319). Not on Windows: the hook is a POSIX script.
  it.skipIf(process.platform === 'win32')('runs no fsmonitor of the agent, and its clean filter without the daemon env (ORC-319)', async () => {
    const dir = repo();
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    const out = mkdtempSync(join(tmpdir(), 'factory-leak-'));
    const hook = join(out, 'fsmonitor.sh');
    writeFileSync(hook, `#!/bin/sh\nenv > '${join(out, 'fsmonitor')}'\nexit 1\n`, { mode: 0o755 });
    git(dir, 'config', 'core.fsmonitor', hook);
    git(dir, 'config', 'filter.leak.clean', `env > '${join(out, 'filter')}'; cat`);
    writeFileSync(join(dir, '.gitattributes'), '* filter=leak\n');
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    vi.stubEnv('FACTORY_DAEMON_TOKEN', 'daemon-secret');
    onTestFinished(() => void vi.unstubAllEnvs());
    expect((await runVerify(dir, ['exit 1'])).tree).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(out, 'fsmonitor'))).toBe(false);
    const filterEnv = readFileSync(join(out, 'filter'), 'utf8');
    expect(filterEnv).toContain('PATH=');
    expect(filterEnv).not.toContain('daemon-secret');
  });

  it('says why the fingerprint of a worktree could not be read (ORC-319)', async () => {
    const dir = repo();
    // The filter prints first, then git fails: the warning names git's error, not what the filter printed to forge a line.
    git(dir, 'config', 'filter.broken.clean', `printf 'forged\\033[2K\\rfactoryd: ok\\n' >&2; false`);
    git(dir, 'config', 'filter.broken.required', 'true');
    writeFileSync(join(dir, '.gitattributes'), '* filter=broken\n');
    const warn = vi.fn();
    expect((await runVerify(dir, ['exit 1'], undefined, {}, warn)).tree).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/^unreadable worktree fingerprint: fatal: .*filter.*; the loop guard does not see this failure\.$/);
    expect(warn.mock.calls[0]![0]).not.toMatch(/forged|[\x00-\x1f]/);
  });

  it('has no fingerprint outside a git worktree', async () => {
    const res = await runVerify(mkdtempSync(join(tmpdir(), 'factory-nogit-')), ['exit 1']);
    expect(res.tree).toBeUndefined();
  });
});
