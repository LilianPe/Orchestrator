import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runVerify } from './verify.js';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-verify-'));
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  return dir;
}

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

  it('has no fingerprint outside a git worktree', async () => {
    const res = await runVerify(mkdtempSync(join(tmpdir(), 'factory-nogit-')), ['exit 1']);
    expect(res.tree).toBeUndefined();
  });
});
