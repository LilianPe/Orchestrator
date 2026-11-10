import { describe, expect, it } from 'vitest';
import type { OutboxEffect } from '../core/decision.js';
import type { OutboxRow, Store } from '../store/types.js';
import { EFFECT_REACH, OutboxExecutor } from './outbox.js';

/** One claimed row of `effect`, on project `p`. */
const row = (effect: OutboxEffect, projectId = 'p'): OutboxRow => ({ id: `REL-1:1:${effect.kind}`, projectId, ticketId: 'REL-1', eventId: 'e1', seq: 1, i: 0, effect, status: 'running', attempts: 1, lease: 'l1' });

/** An effect of each kind, as a decision writes it. */
const EFFECTS: OutboxEffect[] = [
  { kind: 'start_run', job: 'dev' },
  { kind: 'stop_run' },
  { kind: 'run_verify', runId: 'r1', job: 'dev' },
  { kind: 'publish', runId: 'r1', job: 'dev', sha: 'abc' },
  { kind: 'move', to: 'human_review' },
  { kind: 'labels', add: ['a'], remove: [] },
  { kind: 'comment', body: 'hello' },
  { kind: 'block_comment', block: { kind: 'failed', reason: 'r' } as never },
  { kind: 'ack', body: 'ok', linearSessionId: 's1' },
  { kind: 'activity', type: 'thought', body: 'hm' },
  { kind: 'post_output', style: 'summary', runId: 'r1' },
  { kind: 'review', runId: 'r1', lens: 'standard' as never, sha: 'abc', findings: [] },
  { kind: 'link_pr', url: 'https://github.test/pr/1' },
  { kind: 'reconcile' },
  { kind: 'merge', sha: 'abc' },
  { kind: 'take_over', runId: 'r1' },
  { kind: 'close_take_over' },
  { kind: 'publish_bundle', file: '/b', by: 'u' },
  { kind: 'after_merge', number: 1, url: 'https://github.test/pr/1', at: 0 },
  { kind: 'cleanup' },
  { kind: 'set_paused', paused: true },
  { kind: 'settle' },
];

/** An executor on a store that settles every claim, recording what it executed and what it kept instead. */
function executor(noEffect: (projectId: string) => boolean) {
  const executed: string[] = [];
  const kept: string[] = [];
  const store = { renewEffect: async () => true, completeEffect: async () => true, retryEffect: async () => true, failEffect: async () => true } as unknown as Store;
  const exec = new OutboxExecutor({
    store,
    log: () => {},
    retryIn: () => {},
    execute: async (r) => void executed.push(r.effect.kind),
    noEffect,
    keep: async (r) => void kept.push(r.effect.kind),
  });
  return { exec, executed, kept };
}

describe('the no-effect mode of the outbox (ORC-231)', () => {
  it('classifies every effect kind: what writes to Linear or GitHub is never left to a default', () => {
    expect(new Set(EFFECTS.map((e) => e.kind))).toEqual(new Set(Object.keys(EFFECT_REACH)));
    const writes = EFFECTS.filter((e) => EFFECT_REACH[e.kind] === 'outside').map((e) => e.kind);
    expect(writes).toEqual(expect.arrayContaining(['publish', 'move', 'labels', 'comment', 'block_comment', 'ack', 'activity', 'post_output', 'review', 'link_pr', 'merge', 'publish_bundle', 'after_merge', 'reconcile']));
    expect(EFFECTS.filter((e) => EFFECT_REACH[e.kind] === 'inside').map((e) => e.kind)).toEqual(['start_run', 'stop_run', 'run_verify', 'take_over', 'close_take_over', 'cleanup', 'set_paused', 'settle']);
  });

  it('for a project without effects, keeps every effect that reaches outside instead of executing it, and settles it done', async () => {
    const { exec, executed, kept } = executor((p) => p === 'p');
    for (const e of EFFECTS) expect(await exec.run(row(e))).toBe('done');
    expect(executed.sort()).toEqual(['cleanup', 'close_take_over', 'run_verify', 'set_paused', 'settle', 'start_run', 'stop_run', 'take_over']);
    expect(kept).toHaveLength(EFFECTS.length - executed.length);
    expect(kept).not.toContain('start_run');
  });

  it('another project executes everything, as before', async () => {
    const { exec, executed, kept } = executor((p) => p === 'ghost');
    for (const e of EFFECTS) await exec.run(row(e));
    expect(executed).toHaveLength(EFFECTS.length);
    expect(kept).toEqual([]);
  });

  it('a project without effects and nowhere to keep them: the effect fails, nothing is executed', async () => {
    const executed: string[] = [];
    const store = { renewEffect: async () => true, completeEffect: async () => true, retryEffect: async () => true, failEffect: async () => true } as unknown as Store;
    const exec = new OutboxExecutor({ store, log: () => {}, retryIn: () => {}, execute: async (r) => void executed.push(r.effect.kind), noEffect: () => true, retry: { attempts: 1, baseMs: 1, capMs: 1 } });
    expect(await exec.run(row({ kind: 'publish', runId: 'r1', job: 'dev', sha: 'abc' }))).toBe('dead');
    expect(executed).toEqual([]);
  });
});
