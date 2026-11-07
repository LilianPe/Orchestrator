import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
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
      const res = await runVerify(process.cwd(), ['echo boom >&2; exit 3']);
      vi.unstubAllEnvs();
      expect(res.failures[0]!.output).toBe('boom\n');
    });

    it.each([
      ['setup in a sandbox', cappedCommand],
      ['verify in a sandbox', verifyCommand],
    ])('%s', (_, argv) => {
      const [cmd, ...args] = argv('echo boom >&2; exit 3');
      const r = spawnSync(cmd!, args, { env: { ...systemEnv(process.env), HOME: home() }, encoding: 'utf8' });
      expect(r.status).toBe(3);
      expect(r.stdout + r.stderr).toBe('boom\n');
    });
  });

  // Not on Windows: the output of its `bash` does not come back here, as for the test above.
  it.skipIf(process.platform === 'win32')('gives its commands no credential of the daemon: they run what the agent wrote (ORC-211)', async () => {
    vi.stubEnv('ORG_REGISTRY_TOKEN', 'repo-secret');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'claude-token');
    vi.stubEnv('GH_TOKEN', 'gh-token');
    vi.stubEnv('SSH_AUTH_SOCK', '/ssh-agent');
    vi.stubEnv('LANG', 'C');
    const res = await runVerify(process.cwd(), ['echo "[$ORG_REGISTRY_TOKEN$CLAUDE_CODE_OAUTH_TOKEN$GH_TOKEN$SSH_AUTH_SOCK|$LANG]"; exit 1']);
    vi.unstubAllEnvs();
    expect(res.failures[0]!.output).toContain('[|C]');
  });

  it.skipIf(process.platform === 'win32')('gives its commands the variables the repository declares', async () => {
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
    // No git config of the machine: a global ignore often lists `.claude/settings.local.json`, whose write would show nowhere (ORC-324).
    const config = mkdtempSync(join(tmpdir(), 'factory-config-'));
    writeFileSync(join(config, 'gitconfig'), '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(config, 'gitconfig'));
    vi.stubEnv('XDG_CONFIG_HOME', config);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
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

  it('has no fingerprint outside a git worktree', async () => {
    const res = await runVerify(mkdtempSync(join(tmpdir(), 'factory-nogit-')), ['exit 1']);
    expect(res.tree).toBeUndefined();
  });
});
