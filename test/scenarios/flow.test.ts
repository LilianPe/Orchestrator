import { describe, expect, it } from 'vitest';
import { EventBus } from '../../src/core/bus.js';
import { createApp } from '../../src/server/app.js';
import { createHarness } from '../helpers/harness.js';

type Harness = ReturnType<typeof createHarness>;

function flowOf(h: Harness) {
  const app = createApp({
    store: h.store, bus: new EventBus(), clock: h.clock, submit: () => undefined, isPaused: () => false, blockTicket: async () => undefined, askQuestion: async () => undefined,
    linearWebhook: () => ({ status: 200 }), githubWebhook: async () => ({ status: 200 }), linearConnected: () => true, tracker: h.tracker,
    capacity: () => ({ dev: { used: 0, total: 1 }, questions: { used: 0, total: 1 } }), transcriptsDir: '.',
  });
  return async () => {
    const res = await app.request('/api/flow');
    expect(res.status).toBe(200);
    return res.json();
  };
}

const TOKENS = { input: 1_000, output: 2_000, cacheRead: 30_000, cacheCreation: 4_000 };

describe('the Flux on the engine (ORC-297)', () => {
  it('a real ticket: blocked with its cause in Needs you, then in Working with its step, duration and measured tokens', async () => {
    const h = createHarness();
    const flow = flowOf(h);
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });

    // The first run fails: the ticket is blocked by the engine, for a cause the Flux names.
    h.runner.enqueue({ outcome: 'failure', tokens: TOKENS });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    let f = await flow();
    expect(f.working).toEqual([]);
    expect(f.needsYou.blocked).toEqual([{ cause: 'failed', tickets: [expect.objectContaining({ ticketId: 'REL-1', title: 'Export CSV', reason: 'Le run dev a échoué.' })] }]);

    // A human relaunches it: it leaves Needs you, and the tokens of the attempt that ended are shown.
    h.runner.enqueue({ hold: true });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'Réessaie.', author: 'Lilian' });
    await h.advance(5_000);
    f = await flow();
    expect(f.needsYou.blocked).toEqual([]);
    expect(f.working).toEqual([expect.objectContaining({ ticketId: 'REL-1', step: 'dev', stoppable: true, verifying: false, durationMs: 5_000, tokens: TOKENS, attemptsWithoutTokens: 0 })]);

    // Stop: back in Needs you, for the human's stop.
    await h.send('control.stop', {});
    f = await flow();
    expect(f.needsYou.blocked).toEqual([{ cause: 'stopped', tickets: [expect.objectContaining({ ticketId: 'REL-1' })] }]);
  });

  it('a restart during a run blocks nothing, and a launch that fails is infrastructure, in the words the shell writes', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.restart();
    const during = await flowOf(h)();
    // The step starts again by itself (ORC-220): nothing for a human.
    expect(during.needsYou.blocked).toEqual([]);

    h.tracker.addIssue({ identifier: 'REL-2', title: 'Import CSV', description: 'Importer les audits en CSV depuis la liste des audits.' });
    h.workspaces.prepare = async () => {
      throw new Error('git fetch a échoué');
    };
    await h.send('ticket.delegated', { linearSessionId: 'ls-2' }, 'REL-2');
    const launch = await flowOf(h)();
    expect(launch.needsYou.blocked[0].tickets.map((t: { ticketId: string; reason: string }) => [t.ticketId, t.reason.split(' : ')[0]])).toContainEqual(['REL-2', 'Erreur au lancement']);
    expect(launch.needsYou.blocked.map((g: { cause: string }) => g.cause)).toEqual(['infra']);
  });

  it('a ticket handed over to a human, then merged: from Human Review to Done', async () => {
    const h = createHarness();
    const flow = flowOf(h);
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
    h.runner.enqueue({ tokens: TOKENS });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    let f = await flow();
    expect(f.needsYou.humanReview).toEqual([expect.objectContaining({ ticketId: 'REL-1' })]);
    expect(f.done).toEqual([]);

    await h.send('status.changed', { from: 'human_review', to: 'ai_review' });
    await h.send('pr.merged', { number: 3, url: 'https://gh/pr/3', branch: 'factory/rel-1-export-csv' });
    f = await flow();
    expect(f.needsYou.humanReview).toEqual([]);
    expect(f.done).toEqual([expect.objectContaining({ ticketId: 'REL-1', prUrl: 'https://gh/pr/3' })]);
  });
});
