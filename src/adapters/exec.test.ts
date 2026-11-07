import { describe, expect, it } from 'vitest';
import { execCmd } from './exec.js';

describe('execCmd', () => {
  const print = (n: number) => ['-e', `process.stdout.write('x'.repeat(${n}))`];

  it('keeps an output under maxStdout whole', async () => {
    expect(await execCmd(process.execPath, print(1000), { maxStdout: 1000 })).toEqual({ stdout: 'x'.repeat(1000), stderr: '', code: 0 });
  });

  it('past maxStdout, kills the process and keeps nothing of its output', async () => {
    const r = await execCmd(process.execPath, print(1_000_000), { maxStdout: 1000 });
    expect(r).toMatchObject({ stdout: '', overflow: true });
  });
});
