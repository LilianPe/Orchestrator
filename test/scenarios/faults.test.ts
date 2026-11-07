import { describe, expect, it } from 'vitest';
import { TRUSTED, type FactoryEvent } from '../../src/core/types.js';
import { exportJournal } from '../../src/runtime/replay.js';
import { checkChain, FaultError, Faults, settled, type FaultSpec } from '../helpers/faults.js';
import { createHarness } from '../helpers/harness.js';

const LEASE_MS = 60_000;
const DEBOUNCE_MS = 180_000;

type Harness = ReturnType<typeof createHarness>;
type Step = { send: FactoryEvent } | { advance: number };

const event = (id: string, type: FactoryEvent['type'], payload: object): FactoryEvent =>
  ({ id, type, at: 0, projectId: 'p', ticketId: 'REL-1', payload }) as FactoryEvent;

/** A question in its own session (ORC-277). */
const ASK = event('m1', 'session.mentioned', { linearSessionId: 'ls-q', body: 'pourquoi ?', author: 'L' });

/** Delegation, a run, a reply in human review, its debounce, the feedback run. */
const STEPS: Step[] = [
  { send: event('d1', 'ticket.delegated', { linearSessionId: 'ls-1' }) },
  { send: event('p1', 'session.prompted', { linearSessionId: 'ls-1', body: 'boutons mal alignés', author: 'L' }) },
  { advance: DEBOUNCE_MS },
];

/** Moves the clock; a timer whose firing failed stays due, the daemon logs it, and its next tick fires it. */
async function advance(h: Harness, ms: number): Promise<void> {
  await h.advance(ms).catch((err: unknown) => {
    if (!(err instanceof FaultError)) throw err;
  });
}

/** Until nothing is left to do: the retries in backoff, the leases of a dead process. */
async function settle(h: Harness): Promise<void> {
  for (let i = 0; i < 20; i++) {
    // The retries of a failed processing are real timers of a few milliseconds.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await advance(h, LEASE_MS);
    if (await settled(h.store, 'p', ['REL-1'])) return;
  }
}

/**
 * Plays `steps`, then lets everything settle, as a producer would: an event not answered (the write
 * failed, the process died before answering) is sent again with the same id, as Linear resends a
 * webhook. A process killed by the fault, whichever step it hit, is replaced by another on the same
 * database (`restart({ mode: 'brutal' })`), which finishes the step: an event not answered is sent
 * again, a move of the clock is completed (the time passed already, its tick is played again).
 * Returns the ids of the events answered.
 */
async function drive(h: Harness, faults: Faults, steps: Step[]): Promise<Set<string>> {
  const acked = new Set<string>();
  const killed = faults.killed.then(() => 'killed' as const);
  let restarted = false;
  for (const step of [...steps, 'settle' as const]) {
    let after = false;
    for (;;) {
      const run = (async () => {
        if (step === 'settle') {
          await settle(h);
          return 'done' as const;
        }
        if ('advance' in step) {
          await advance(h, after ? 0 : step.advance);
          return 'done' as const;
        }
        try {
          await h.orch.accept({ ...step.send, at: h.clock.now() });
          acked.add(step.send.id);
        } catch (err) {
          if (!(err instanceof FaultError)) throw err;
          return 'unanswered' as const;
        }
        await h.orch.drained();
        return 'done' as const;
      })();
      const outcome = restarted ? await run : await Promise.race([run, killed]);
      if (outcome === 'killed') {
        restarted = true;
        after = true;
        await h.restart({ mode: 'brutal' });
        if (step === 'settle' || !('send' in step) || !acked.has(step.send.id)) continue;
      } else if (outcome === 'unanswered') continue;
      break;
    }
  }
  return acked;
}

async function scenario(spec?: FaultSpec, steps = STEPS) {
  const faults = new Faults(spec);
  const h = createHarness({
    faults,
    effectLeaseMs: LEASE_MS,
    processRetry: { attempts: 5, baseMs: 1 },
    effectRetry: { attempts: 3, baseMs: 1, capMs: 1 },
  });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
  h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }] }, { events: [{ kind: 'text', text: 'Corrigé.' }] });
  const acked = await drive(h, faults, steps);
  const report = await checkChain(h.store, { projectId: 'p', tickets: ['REL-1'], acked, calls: faults.calls });
  return { h, faults, acked, report };
}

/** Each point of the chain, cut by an error (`throw`) and by the death of the process (`kill`). */
const CASES: { label: string; spec: Omit<FaultSpec, 'mode'> }[] = [
  { label: 'webhook accept', spec: { point: 'webhook.accept' } },
  { label: 'inbox write', spec: { point: 'inbox.write', match: (i) => i.id === 'd1' } },
  { label: 'decision, before decide', spec: { point: 'decide.before' } },
  { label: 'decision, after decide, before the commit', spec: { point: 'decide.after' } },
  { label: 'decision, after the commit', spec: { point: 'decide.commit' } },
  { label: 'decision of a run result, after decide, before the commit', spec: { point: 'decide.after', match: (i) => i.eventType === 'run.finished' } },
  { label: 'outbox claim', spec: { point: 'outbox.claim' } },
  { label: 'effect, before its external call', spec: { point: 'effect.before' } },
  { label: 'run launch, before the runner starts it', spec: { point: 'effect.before', match: (i) => i.method === 'start' } },
  { label: 'idempotent effect (move), after its external call', spec: { point: 'effect.after', match: (i) => i.method === 'moveTo' } },
  { label: 'run launch, before its run is written', spec: { point: 'run.write' } },
  { label: 'run launch, its run written, before the runner starts it', spec: { point: 'run.written' } },
  { label: 'run launch, after the runner started it', spec: { point: 'effect.after', match: (i) => i.method === 'start' } },
  { label: 'effect completion', spec: { point: 'effect.complete' } },
  { label: 'timer firing, before its transaction', spec: { point: 'timer.fire' } },
  { label: 'timer firing, after its commit', spec: { point: 'timer.fired' } },
  { label: 'run result write', spec: { point: 'run.result' } },
  { label: 'run result, written, unanswered', spec: { point: 'inbox.write', match: (i) => i.eventType === 'run.finished' } },
  // Late in the scenario: the feedback run's result and output, while the clock moves.
  { label: 'decision of the second run result, after the commit', spec: { point: 'decide.commit', match: (i) => i.eventType === 'run.finished', nth: 2 } },
  { label: 'completion of the second run output', spec: { point: 'effect.complete', match: (i) => i.effect === 'post_output', nth: 2 } },
];

describe('fault injection at each point of the chain (ORC-163)', () => {
  it('without a fault: the scenario goes through, and the checker finds nothing', async () => {
    const { h, acked, report, faults } = await scenario();
    expect([...acked]).toEqual(['d1', 'p1']);
    expect(report).toEqual({ violations: [], atLeastOnce: [] });
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
    expect(h.runner.requests.map((r) => r.prompt.split('\n')[0])).toEqual(['/factory:dev', '/factory:feedback']);
    expect(faults.calls.filter((c) => c.row).map((c) => `${c.kind}:${c.method}`)).toMatchInlineSnapshot(`
      [
        "start_run:moveTo",
        "start_run:start",
        "start_run:activity",
        "move:moveTo",
        "post_output:activity",
        "start_run:start",
        "start_run:activity",
        "post_output:activity",
      ]
    `);
  });

  describe.each(['throw', 'kill'] as const)('%s', (mode) => {
    it.each(CASES)('at $label: no event lost, no visible effect doubled, the journal replays', async ({ spec }) => {
      const { acked, report, faults } = await scenario({ ...spec, mode });
      expect(faults.fired).toMatchObject({ point: spec.point, mode });
      expect([...acked].sort()).toEqual(['d1', 'p1']);
      expect(report.violations).toEqual([]);
      expect(report.atLeastOnce).toEqual([]);
    });

    /**
     * The outbox is at least once: a cut between the external call and the completion runs the
     * effect again. The replay finds the activity its first execution posted (ORC-162) and posts
     * nothing more.
     */
    it('at a visible effect (post_output), after its external call: posted once (ORC-162)', async () => {
      const { report, faults } = await scenario({ point: 'effect.after', mode, match: (i) => i.effect === 'post_output' });
      expect(faults.fired).toMatchObject({ point: 'effect.after', mode });
      expect(report.violations).toEqual([]);
      expect(report.atLeastOnce).toEqual([]);
    });
  });

  /**
   * ORC-277, found by the chaos (seed 31 on Postgres): a question's run cut after it started is not a
   * ticket's run, so recover() blocks nothing and posts « reposez la question ». The start taken up
   * again past its lease finds the run its mark names, written before the runner started it, and
   * launches nothing: the question is asked once, and the only answer is the invitation to ask again.
   */
  it('kill at a question run launch, after the runner started it: asked once (ORC-277)', async () => {
    const { h, report, faults } = await scenario({ point: 'effect.after', mode: 'kill', match: (i) => i.method === 'start' }, [{ send: ASK }]);
    expect(faults.fired).toMatchObject({ point: 'effect.after', mode: 'kill' });
    expect(report.violations).toEqual([]);
    expect(report.atLeastOnce).toEqual([]);
    expect(h.runner.requests).toHaveLength(1);
    expect(h.tracker.activities('ls-q')).toEqual([
      { type: 'error', body: expect.stringContaining('Ask the question again') as unknown },
    ]);
  });

  /**
   * ORC-277, the other side: a question's launch cut before its run is written. Its mark names a run
   * that was never written, so nothing was launched: recover() has no run to settle and tells nobody
   * to ask again, and the start taken up again launches the question once.
   */
  it('kill at a question run launch, before its run is written: launched once, no invitation to ask again (ORC-277)', async () => {
    const { h, report, faults } = await scenario({ point: 'run.write', mode: 'kill' }, [{ send: ASK }]);
    expect(faults.fired).toMatchObject({ point: 'run.write', mode: 'kill' });
    expect(report.violations).toEqual([]);
    expect(report.atLeastOnce).toEqual([]);
    expect(h.runner.requests).toHaveLength(1);
    expect(JSON.stringify(h.tracker.activities('ls-q'))).not.toContain('Ask the question again');
  });

  /**
   * The same cut on a dev start. Was (ORC-277): the ticket blocked, a notice, nothing launched. Now (ORC-220): the
   * ticket holds a run nothing launched, recover() lets go of it, and the start taken up again past its lease
   * launches it, with no human and no notice. Never a ticket left delegated with no run: it reaches its review.
   */
  it('kill at a dev run launch, before its run is written: launched once by the start taken up again (ORC-220)', async () => {
    const { h, report, faults } = await scenario({ point: 'run.write', mode: 'kill' }, [STEPS[0]!]);
    expect(faults.fired).toMatchObject({ point: 'run.write', mode: 'kill' });
    expect(report.violations).toEqual([]);
    expect(report.atLeastOnce).toEqual([]);
    expect(h.runner.requests).toHaveLength(1);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: false, logical: 'human_review' });
    expect(t.activeRunId).toBeUndefined();
    expect(JSON.stringify(h.tracker.activities('ls-1'))).not.toContain('restarted');
    expect((await h.tracker.getIssue('REL-1')).labels).not.toContain('Bloqué');
  });

  /**
   * Past the launch: the run is written, its start marked. New with ORC-220: the mark still stops the start taken up
   * again (never twice for one row), and it is `run.lost` that starts the step, by an outbox row of its own.
   */
  it.each(['run.written', 'effect.after'] as const)('kill at a dev run launch, at %s: the step starts again under its own row, never twice under one (ORC-220)', async (point) => {
    const { h, report, faults } = await scenario({ point, mode: 'kill', match: (i) => point === 'run.written' || i.method === 'start' }, [STEPS[0]!]);
    expect(faults.fired).toMatchObject({ point, mode: 'kill' });
    expect(report.violations).toEqual([]);
    expect(report.atLeastOnce).toEqual([]);
    expect(await h.ticket()).toMatchObject({ blocked: false, logical: 'human_review' });
    const rows = (await h.store.listEffects('p', 'REL-1')).filter((r) => r.effect.kind === 'start_run');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.effect).toMatchObject({ relaunchOf: expect.any(String) });
  });

  /**
   * ORC-277 through the queue: a question queued while the factory is paused, handed out at the
   * resume and cut once its run is written, before it left the queue. Handed out again after its
   * lease, its own mark names the run: not launched, and « reposez la question » is the only answer.
   */
  it('kill at a queued question launch, its run written, before it left the queue: not launched again (ORC-277)', async () => {
    const control = (id: string, type: 'control.pause' | 'control.resume') => ({ ...TRUSTED, id, type, at: 0, projectId: '*', payload: {} }) as FactoryEvent;
    const { h, report, faults } = await scenario({ point: 'run.written', mode: 'kill' }, [
      { send: control('g1', 'control.pause') },
      { send: ASK },
      { send: control('g2', 'control.resume') },
    ]);
    expect(faults.fired).toMatchObject({ point: 'run.written', mode: 'kill' });
    // The checker reads project p's journals; the controls are the installation's (`*`), journaled there once.
    expect(report.violations.filter((v) => !/^lost: g[12] /.test(v))).toEqual([]);
    expect((await exportJournal(h.store, '*')).entries.map((e) => e.event.id).filter((id) => /^g/.test(id))).toEqual(['g1', 'g2']);
    expect(report.atLeastOnce).toEqual([]);
    // Its lease expires, and the daemon's tick hands it out again.
    h.clock.advance(LEASE_MS + 1);
    await h.orch.tick();
    await h.orch.drained();
    expect(h.runner.requests).toHaveLength(0);
    expect(h.tracker.activities('ls-q')).toEqual([{ type: 'error', body: expect.stringContaining('Ask the question again') as unknown }]);
    expect(await h.store.listQueue()).toEqual([]);
  });
});
