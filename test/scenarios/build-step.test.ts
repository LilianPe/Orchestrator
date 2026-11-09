import { describe, expect, it } from 'vitest';
import type { Stagnation } from '../../src/core/types.js';
import { agentOutputKey } from '../../src/core/agent-output.js';
import { causeOf } from '../../src/core/block-cause.js';
import { createHarness } from '../helpers/harness.js';

function delegated() {
  const h = createHarness();
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  return h;
}

const loop: Stagnation = { kind: 'loop', command: 'npm test', failure: 'sha256:f', tree: 'abc', count: 3 };

describe('the build step (ORC-136)', () => {
  it('is launched with the effort, the turns and the stagnation bounds of the preset, the effort in its labels', async () => {
    const h = delegated();
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.advance(0);
    const req = h.runner.requests[0]!;
    expect(req).toMatchObject({ effort: 'medium', limits: { turns: 150 }, stagnation: { repeats: 3, silentMs: 30 * 60_000 } });
    expect((await h.store.getRun(req.runId))!.labels).toMatchObject({ effort: 'medium' });
  });

  it('a feedback run takes the turns of `fix`, a review those of `review`', async () => {
    const h = delegated();
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.advance(0);
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'reprends', author: 'L' });
    await h.advance(180_000);
    expect(h.runner.requests[1]).toMatchObject({ effort: 'medium', limits: { turns: 60 } });
    await h.send('status.changed', { from: 'human_review', to: 'ai_review' });
    await h.advance(0);
    expect(h.runner.requests[2]).toMatchObject({ effort: 'high', limits: { turns: 25 } });
  });

  it('stops at 150 turns: Bloqué on the cap, no run after it', async () => {
    const h = delegated();
    h.runner.enqueue({ turns: 151 });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.advance(600_000);
    expect(h.runner.requests).toHaveLength(1);
    const t = await h.ticket();
    // The turn cap is a budget (ORC-216): its own kind, under the cause `limit` in the Flow.
    expect(t).toMatchObject({ blocked: true, blockKind: 'budget', blockReason: 'The run dev spent its turn budget (max_turns of its step).' });
    expect(causeOf(t.blockKind)).toBe('limit');
  });

  it('three times the same command on the same failure, diff unchanged: Bloqué, cause « boucle », no run after it', async () => {
    const h = delegated();
    h.runner.enqueue({ outcome: 'limit', stagnation: loop });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.advance(600_000);
    expect(h.runner.requests).toHaveLength(1);
    const t = await h.ticket();
    expect(t.blocked).toBe(true);
    expect(causeOf(t.blockKind)).toBe('loop');
    expect((await h.tracker.getIssue('REL-1')).labels).toContain('Bloqué');
    expect(h.tracker.comments('REL-1').at(-1)).toContain('npm test');
  });

  it('the block is decided from the journal: the fact is in the journaled event', async () => {
    const h = delegated();
    h.runner.enqueue({ outcome: 'limit', stagnation: loop });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.advance(0);
    const journal = await h.store.ticketJournal('p', 'REL-1');
    expect(journal.find((e) => e.event.type === 'run.finished')!.event.payload).toMatchObject({ stagnation: loop, outcome: 'limit', attempt: 'timeout' });
    // Kept for recover(), on the end of the run.
    expect(await h.store.getRun(h.runner.requests[0]!.runId)).toMatchObject({ stagnation: loop });
  });

  it('a crash between the end of the attempt and its result changes nothing: recover() sends what the runner saw', async () => {
    const h = delegated();
    h.runner.enqueue({ hold: true, outcome: 'limit', stagnation: loop });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const runId = (await h.ticket()).activeRunId!;
    // The pump's steps up to the kill: the end of the attempt written, and no `run.finished`.
    await h.store.putRun({ ...(await h.store.getRun(runId))!, status: 'limit', endedAt: h.clock.now(), stagnation: loop });
    h.runner.forget(runId);
    await h.restart({ mode: 'brutal' });
    await h.orch.drained();
    expect(causeOf((await h.ticket()).blockKind)).toBe('loop');
  });

  it('a human reply relaunches a ticket blocked on a loop: the session resumes, nothing is counted against it', async () => {
    const h = delegated();
    h.runner.enqueue({ outcome: 'limit', stagnation: loop });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.advance(0);
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'essaie autrement', author: 'L' });
    await h.advance(0);
    expect(h.runner.requests).toHaveLength(2);
    expect(await h.ticket()).toMatchObject({ blocked: false });
  });

  it('a silent agent: Bloqué on it, the lease has nothing to say', async () => {
    const h = delegated();
    h.runner.enqueue({ outcome: 'limit', stagnation: { kind: 'silent', silentMs: 30 * 60_000 } });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.advance(600_000);
    expect(h.runner.requests).toHaveLength(1);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: true, blockReason: expect.stringContaining("has written nothing for 30 min") });
    expect(causeOf(t.blockKind)).toBe('limit');
  });

  it('a build that ends without a valid `submit_result` is a failure, not a success posted from its last text', async () => {
    const h = delegated();
    h.runner.enqueue({ hold: true, submit: false, events: [{ kind: 'text', text: 'Texte libre de fin.' }] });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const runId = (await h.ticket()).activeRunId!;
    await h.store.setMeta(agentOutputKey(runId), JSON.stringify({ status: 'done' }));
    h.runner.release(runId);
    await h.advance(0);
    const t = await h.ticket();
    expect(t).toMatchObject({ logical: 'dev', blocked: true });
    expect(causeOf(t.blockKind)).toBe('failed');
    expect(h.tracker.comments('REL-1').at(-1)).toContain('🔴 Blocked');
    expect(h.tracker.activities('ls-1').filter((a) => a.type === 'response')).toEqual([]);
  });

  it('a build that dies with its container is errored: blocked on the infrastructure, nothing sent back to the agent', async () => {
    const h = delegated();
    h.runner.enqueue({ fail: 'container gone' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.advance(600_000);
    expect(h.runner.requests).toHaveLength(1);
    const t = await h.ticket();
    expect(causeOf(t.blockKind)).toBe('infra');
    const journal = await h.store.ticketJournal('p', 'REL-1');
    expect(journal.find((e) => e.event.type === 'run.finished')!.event.payload).toMatchObject({ attempt: 'errored' });
  });
});
