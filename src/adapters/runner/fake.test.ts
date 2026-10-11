import { describe, expect, it } from 'vitest';
import { FakeRunner } from './fake.js';
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

describe('FakeRunner', () => {
  it('replays a script and resolves with its outcome', async () => {
    const r = new FakeRunner();
    r.enqueue({ events: [{ kind: 'text', text: 'hello' }], outcome: 'success', costUsd: 0.2, turns: 2 });
    const h = r.start(req('r1'));
    expect(await collect(h.events)).toEqual([{ kind: 'text', text: 'hello' }]);
    expect(await h.done).toEqual({ outcome: 'success', costUsd: 0.2, turns: 2, lastText: 'hello' });
    expect(r.requests).toHaveLength(1);
  });

  it('holds until released, and stop yields stopped', async () => {
    const r = new FakeRunner();
    r.enqueue({ hold: true }, { hold: true });
    const a = r.start(req('a'));
    const b = r.start(req('b'));
    r.release('a');
    expect((await a.done).outcome).toBe('success');
    b.stop();
    expect((await b.done).outcome).toBe('stopped');
  });
});
