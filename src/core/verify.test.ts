import { describe, expect, it } from 'vitest';
import { runVerify } from './verify.js';

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
});
