import { describe, expect, it } from 'vitest';
import { measureTicket } from '../../src/core/measures.js';
import { createHarness } from '../helpers/harness.js';
import { expectFirstRunMeasures, firstRun } from '../helpers/measures-scenario.js';

describe('measures of the MVP doc, from the first run (ORC-235)', () => {
  it('a full run on fake adapters writes every measure that has a source; the others stay empty', async () => {
    expectFirstRunMeasures(await firstRun(createHarness()));
  });

  it('a red CI and a reply in the dev session before the merge: not ready at the first try, whatever the agent says', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV.' });
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Mergeable au premier essai.' }] });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const pr = { number: 3, url: 'https://gh/pr/3', branch: 'factory/rel-1-export-csv' };
    await h.send('pr.checks_failed', { ...pr, failures: ['test'] });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'renomme la colonne', author: 'Lilian' });
    const before = await measureTicket(h.store, 'p', 'REL-1');
    // Not merged yet: no verdict on the first try, and no tokens reported by the runner.
    expect(before).toMatchObject({ mergedAt: null, firstTry: null, reworks: [], tokens: null, attemptsWithoutTokens: before.attempts });
    expect(before.messages.at(-1)).toMatchObject({ kind: 'instruction', linearSessionId: 'ls-1', answerMs: null });

    await h.send('pr.merged', pr);
    const m = await measureTicket(h.store, 'p', 'REL-1');
    expect(m.firstTry).toBe(false);
    expect(m.reworks.map((r) => r.cause)).toEqual(['pr.checks_failed', 'feedback']);
  });

  it('a running attempt has not failed to report its usage: it reports at its end (ORC-297)', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(await measureTicket(h.store, 'p', 'REL-1')).toMatchObject({ attempts: 1, attemptsWithoutTokens: 0, tokens: null });
  });

  it('a reply that relaunches a failed dev run and a human sending the ticket back to dev are reworks too', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV.' });
    h.runner.enqueue({ outcome: 'failure' }, {});
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'reprends', author: 'L' });
    await h.advance(180_000);
    await h.send('status.changed', { from: 'human_review', to: 'dev' });
    await h.send('pr.merged', { number: 3, url: 'https://gh/pr/3', branch: 'factory/rel-1-export-csv' });
    const m = await measureTicket(h.store, 'p', 'REL-1');
    expect(m.reworks.map((r) => r.cause)).toEqual(['feedback', 'sent_back']);
  });
});
