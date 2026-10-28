import { describe, expect, it } from 'vitest';
import type { FactoryEvent } from '../../src/core/types.js';
import { checkChain, FaultError, Faults, type FaultSpec } from '../helpers/faults.js';
import { createHarness } from '../helpers/harness.js';

const LEASE_MS = 60_000;
const DEBOUNCE_MS = 180_000;

type Harness = ReturnType<typeof createHarness>;
type Step = { send: FactoryEvent } | { advance: number };

const event = (id: string, type: FactoryEvent['type'], payload: object): FactoryEvent =>
  ({ id, type, at: 0, projectId: 'p', ticketId: 'REL-1', payload }) as FactoryEvent;

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
    const effects = await h.store.listEffects('p');
    const busy = effects.some((r) => r.status === 'pending' || r.status === 'running');
    if (!busy && (await h.store.pendingInbox(1)).length === 0) return;
  }
}

/**
 * Plays `STEPS` as a producer would: an event not answered (the write failed, the process died
 * before answering) is sent again with the same id, as Linear resends a webhook. A process killed by
 * the fault is replaced by another on the same database (`restart({ mode: 'brutal' })`). Returns the
 * ids of the events answered.
 */
async function drive(h: Harness, faults: Faults): Promise<Set<string>> {
  const acked = new Set<string>();
  const killed = faults.killed.then(() => 'killed' as const);
  let restarted = false;
  for (const step of STEPS) {
    for (;;) {
      const run = (async () => {
        if ('advance' in step) {
          await advance(h, step.advance);
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
        await h.restart({ mode: 'brutal' });
        if ('send' in step && !acked.has(step.send.id)) continue;
      } else if (outcome === 'unanswered') continue;
      break;
    }
  }
  await settle(h);
  return acked;
}

async function scenario(spec?: FaultSpec) {
  const faults = new Faults(spec);
  const h = createHarness({
    faults,
    effectLeaseMs: LEASE_MS,
    processRetry: { attempts: 5, baseMs: 1 },
    effectRetry: { attempts: 3, baseMs: 1, capMs: 1 },
  });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
  h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }] }, { events: [{ kind: 'text', text: 'Corrigé.' }] });
  const acked = await drive(h, faults);
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
  { label: 'run launch, after the runner started it', spec: { point: 'effect.after', match: (i) => i.method === 'start' } },
  { label: 'effect completion', spec: { point: 'effect.complete' } },
  { label: 'timer firing, before its transaction', spec: { point: 'timer.fire' } },
  { label: 'timer firing, after its commit', spec: { point: 'timer.fired' } },
  { label: 'run result write', spec: { point: 'run.result' } },
  { label: 'run result, written, unanswered', spec: { point: 'inbox.write', match: (i) => i.eventType === 'run.finished' } },
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
     * Known gap, ORC-162 (#57): the outbox is at least once, and a cut between the external call and
     * the completion runs the effect again. A run's output posted twice in Linear is a visible double
     * until each effect is idempotent. Becomes an `it` once ORC-162 is merged.
     */
    it.fails('at a visible effect (post_output), after its external call: posted twice until ORC-162', async () => {
      const { report, faults } = await scenario({ point: 'effect.after', mode, match: (i) => i.effect === 'post_output' });
      expect(faults.fired).toMatchObject({ point: 'effect.after', mode });
      expect(report.violations).toEqual([]);
      expect(report.atLeastOnce).toEqual([]);
    });
  });
});
