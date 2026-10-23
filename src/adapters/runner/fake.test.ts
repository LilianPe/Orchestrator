import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../core/clock.js';
import { describeAgentRuntimeContract, drain, type AgentScript } from '../../../test/contracts/agent-runtime.contract.js';
import { FakeRunner, type FakeScript } from './fake.js';
import type { RunRequest } from './types.js';

const req = (runId: string): RunRequest => ({
  runId, cwd: '/w', prompt: 'p', claudeSessionId: 's', resume: false, model: 'sonnet',
  pluginDir: '/pack', settingsPath: '/pack/settings.json', readOnly: false, limits: { turns: 10, durationMs: 1000, usd: 1 }, env: {},
});

const scripts: Record<AgentScript, FakeScript> = {
  success: { events: [{ kind: 'text', text: 'PR ouverte.' }] },
  failure: { outcome: 'failure' },
  hang: { hold: true },
  chatty: { events: ['un', 'deux', 'trois'].map((text) => ({ kind: 'text', text })), turns: 3, hold: true },
};

describeAgentRuntimeContract(
  'FakeRunner',
  () => {
    const clock = new FakeClock();
    const runtime = new FakeRunner(clock);
    return {
      runtime,
      script: (name) => (runtime.enqueue(scripts[name]), {}),
      elapse: (ms) => (clock.advance(ms), runtime.tick()),
    };
  },
);

describe('FakeRunner', () => {
  it('replays a script and resolves with its outcome', async () => {
    const r = new FakeRunner();
    r.enqueue({ events: [{ kind: 'text', text: 'hello' }], outcome: 'success', costUsd: 0.2, turns: 2 });
    const h = r.start(req('r1'));
    expect(await drain(h.events)).toEqual([{ kind: 'text', text: 'hello' }]);
    expect(await h.done).toEqual({ outcome: 'success', costUsd: 0.2, turns: 2, lastText: 'hello' });
    expect(r.requests).toHaveLength(1);
  });

  it('ends a held run in limit once the simulated clock reaches its duration cap, not before', async () => {
    const clock = new FakeClock(5_000);
    const r = new FakeRunner(clock);
    r.enqueue({ hold: true, turns: 4 });
    const h = r.start(req('r1'));
    clock.advance(999);
    r.tick();
    r.enqueue({});
    expect((await r.start(req('r2')).done).outcome).toBe('success');
    clock.advance(1);
    r.tick();
    expect(await h.done).toMatchObject({ outcome: 'limit', turns: 4 });
  });

  it('ends a run whose scripted turns exceed its turn cap in limit, at the cap', async () => {
    const r = new FakeRunner();
    r.enqueue({ hold: true, turns: 11 }, { turns: 10 });
    expect(await r.start(req('over')).done).toMatchObject({ outcome: 'limit', turns: 10 });
    expect((await r.start(req('at')).done).outcome).toBe('success');
  });

  it('holds until released', async () => {
    const r = new FakeRunner();
    r.enqueue({ hold: true });
    const a = r.start(req('a'));
    r.release('a');
    expect((await a.done).outcome).toBe('success');
  });
});
