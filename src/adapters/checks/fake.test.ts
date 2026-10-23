import { describe, expect, it } from 'vitest';
import { describeCheckRunnerContract, type FailingCommand } from '../../../test/contracts/check-runner.contract.js';
import { FakeCheckRunner } from './fake.js';

describeCheckRunnerContract('FakeCheckRunner', () => {
  const fails: [FailingCommand, FailingCommand] = [
    { command: 'npm test', exitCode: 1, output: '1 test failed' },
    { command: 'npm run lint', exitCode: 2, output: 'lint: 2 errors' },
  ];
  // The slow command takes 1 s: it fails, without an exit code, only under a shorter timeout the fake passed on.
  const slow = 'npm run e2e';
  // Nothing starts in this folder, as when the real one is missing.
  const unstartableCwd = '/missing';
  let runs = 0;
  const counted = 'npm run count';
  const checks = new FakeCheckRunner(async (cwd, commands, timeoutMs) => {
    if (cwd === unstartableCwd) return { ok: false, failures: commands.map((command) => ({ command, exitCode: null, output: 'spawn ENOENT' })) };
    runs += commands.filter((c) => c === counted).length;
    const timedOut = timeoutMs !== undefined && timeoutMs < 1_000 ? [{ command: slow, exitCode: null, output: '' }] : [];
    const failed = commands.flatMap((c) => [...fails, ...timedOut].filter((f) => f.command === c));
    return { ok: failed.length === 0, failures: failed };
  });
  return { checks, cwd: '/w', pass: 'npm run build', fails, slow, unstartableCwd, counted: { command: counted, runs: async () => runs } };
});

describe('FakeCheckRunner', () => {
  it('passes by default and records each call', async () => {
    const c = new FakeCheckRunner();
    expect(await c.run('/w', ['npm test'])).toEqual({ ok: true, failures: [] });
    expect(c.calls).toEqual([{ cwd: '/w', commands: ['npm test'] }]);
  });

  it('replays queued results in order, then passes again', async () => {
    const c = new FakeCheckRunner();
    c.failNext('1 failed');
    c.failNext('2 failed');
    const a = await c.run('/w', ['npm test', 'npm run lint']);
    expect(a).toEqual({ ok: false, failures: [{ command: 'npm test', exitCode: 1, output: '1 failed' }] });
    expect((await c.run('/w', ['npm test'])).failures[0]!.output).toBe('2 failed');
    expect((await c.run('/w', ['npm test'])).ok).toBe(true);
  });

  it('holds the next check until released', async () => {
    const c = new FakeCheckRunner();
    const release = c.holdNext();
    let settled = false;
    const p = c.run('/w', ['npm test']).then((r) => ((settled = true), r));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(c.calls).toHaveLength(1);
    release({ ok: false, failures: [{ command: 'npm test', exitCode: 1, output: 'x' }] });
    expect((await p).ok).toBe(false);
  });

  it('falls back to the given verifier once the queue is empty, still recording the call', async () => {
    const fail = { ok: false, failures: [{ command: 'npm test', exitCode: 2, output: 'own' }] };
    const c = new FakeCheckRunner(async () => fail);
    c.failNext('queued');
    expect((await c.run('/w', ['npm test'])).failures[0]!.output).toBe('queued');
    expect(await c.run('/w', ['npm test'])).toEqual(fail);
    expect(c.calls).toHaveLength(2);
  });

  it('enqueues explicit results', async () => {
    const c = new FakeCheckRunner();
    const failures = [{ command: 'lint', exitCode: null, output: 'timeout' }];
    c.enqueue({ ok: false, failures });
    expect(await c.run('/w', ['lint'])).toEqual({ ok: false, failures });
  });
});
