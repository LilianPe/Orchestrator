import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

  it('has no fingerprint outside a git worktree', async () => {
    const res = await runVerify(mkdtempSync(join(tmpdir(), 'factory-nogit-')), ['exit 1']);
    expect(res.tree).toBeUndefined();
  });
});
