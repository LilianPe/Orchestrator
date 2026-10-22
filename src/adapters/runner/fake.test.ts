import { describe, expect, it } from 'vitest';
import { describeAgentRuntimeContract, type AgentScript } from '../../../test/contracts/agent-runtime.contract.js';
import { FakeRunner, type FakeScript } from './fake.js';
import type { RunRequest, RunStreamEvent } from './types.js';

const req = (runId: string): RunRequest => ({
  runId, cwd: '/w', prompt: 'p', claudeSessionId: 's', resume: false, model: 'sonnet',
  pluginDir: '/pack', settingsPath: '/pack/settings.json', readOnly: false, limits: { turns: 10, durationMs: 1000, usd: 1 }, env: {},
});

async function collect(it: AsyncIterable<RunStreamEvent>): Promise<RunStreamEvent[]> {
  const out: RunStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const scripts: Record<AgentScript, FakeScript> = {
  success: { events: [{ kind: 'text', text: 'PR ouverte.' }] },
  failure: { outcome: 'failure' },
  hang: { hold: true },
  chatty: { events: ['un', 'deux', 'trois'].map((text) => ({ kind: 'text', text })), hold: true },
};

describeAgentRuntimeContract(
  'FakeRunner',
  () => {
    const runtime = new FakeRunner();
    return { runtime, script: (name) => (runtime.enqueue(scripts[name]), {}) };
  },
  ['duration-limit', 'turn-limit'],
);

describe('FakeRunner', () => {
  it('replays a script and resolves with its outcome', async () => {
    const r = new FakeRunner();
    r.enqueue({ events: [{ kind: 'text', text: 'hello' }], outcome: 'success', costUsd: 0.2, turns: 2 });
    const h = r.start(req('r1'));
    expect(await collect(h.events)).toEqual([{ kind: 'text', text: 'hello' }]);
    expect(await h.done).toEqual({ outcome: 'success', costUsd: 0.2, turns: 2, lastText: 'hello' });
    expect(r.requests).toHaveLength(1);
  });

  it('holds until released', async () => {
    const r = new FakeRunner();
    r.enqueue({ hold: true });
    const a = r.start(req('a'));
    r.release('a');
    expect((await a.done).outcome).toBe('success');
  });
});
