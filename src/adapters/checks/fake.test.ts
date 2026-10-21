import { describe, expect, it } from 'vitest';
import { FakeCheckRunner } from './fake.js';

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
