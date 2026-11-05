import { describe, expect, it } from 'vitest';
import { BLOCKED_LABEL } from '../../src/core/engine.js';
import { unroutedReason } from '../../src/core/routing.js';
import type { EventPayloads, EventType, FactoryEvent } from '../../src/core/types.js';
import { createHarness, harnessStoreKind } from '../helpers/harness.js';

/**
 * A ticket's way out of its wait for a repo (ORC-291), on either store: SQLite keeps a copy of the ticket per
 * project, Postgres one row per ticket, which the project it goes to takes over.
 */
describe('an event routed on a stale read, on Postgres\'s one row per ticket (ORC-291)', () => {
  it('never replaces the ticket another project holds: its row stays whole, the event is set aside, logged, repairable', async (ctx) => {
    if (harnessStoreKind() !== 'postgres') ctx.skip();
    const h = createHarness({ extraProjects: ['api'] });
    h.tracker.addIssue({ identifier: 'REL-1', delegateId: 'app', description: 'x'.repeat(40) });
    const accept = async (id: string, projectId: string, payload: EventPayloads['ticket.delegated']) => {
      await h.orch.accept({ id, type: 'ticket.delegated', at: h.clock.now(), projectId, ticketId: 'REL-1', actor: 'user-1', taint: 'trusted', payload } as FactoryEvent);
      await h.orch.drained();
    };
    // A signed delegation with `repo:api`: api holds the ticket, its run under way, its branch and PR written.
    await accept('signed', 'api', { linearSessionId: 's1' });
    await h.store.updateTicket('api', 'REL-1', (t) => ({ ...t, branch: 'factory/rel-1', prNumber: 7 }));
    const held = await h.store.getTicket('api', 'REL-1');
    expect(held).toMatchObject({ delegated: true, branch: 'factory/rel-1', prNumber: 7 });
    const calls = h.tracker.calls.length;

    // A pass that read Linear before the label was there: its delegation, unsigned, for the first repo.
    await accept('reconcile:unrouted:p:REL-1', 'p', { issue: { title: 'T', logical: 'todo', priority: 0 }, repos: ['p', 'api'] });

    expect(await h.store.getTicket('api', 'REL-1')).toEqual(held);
    expect(await h.store.getTicket('p', 'REL-1')).toBeUndefined();
    expect(await h.store.getDeadLetter('reconcile:unrouted:p:REL-1')).toMatchObject({ status: 'open', ticketId: 'REL-1', error: expect.stringContaining('api') });
    expect(h.logs.some((l) => l.level === 'error' && l.message.includes('reconcile:unrouted:p:REL-1') && l.message.includes('api'))).toBe(true);
    // Nothing of the refused decision reached Linear: neither the question nor the Bloqué label.
    expect(h.tracker.calls.slice(calls).filter((c) => c.method !== 'getIssue')).toEqual([]);

    // Replayed while api holds it, it is refused again; skipped, it is closed. The ticket never moves.
    await h.store.repairDeadLetter('reconcile:unrouted:p:REL-1', 'replay', 'user-1', h.clock.now());
    await h.orch.poll();
    await h.orch.drained();
    expect(await h.store.getDeadLetter('reconcile:unrouted:p:REL-1')).toMatchObject({ status: 'open', failures: 2 });
    expect(await h.store.getTicket('api', 'REL-1')).toEqual(held);
    await h.store.repairDeadLetter('reconcile:unrouted:p:REL-1', 'skip', 'user-1', h.clock.now());
    expect(await h.store.getDeadLetter('reconcile:unrouted:p:REL-1')).toMatchObject({ status: 'skipped' });
  });
});

describe('a ticket waiting for its repo, once a human chose it (ORC-291)', () => {
  const repos = ['p', 'api'];
  const signed = { actor: 'user-1', taint: 'trusted' as const };

  async function waiting() {
    const h = createHarness({ extraProjects: ['api'] });
    h.tracker.addIssue({ identifier: 'REL-1', delegateId: 'app', description: 'x'.repeat(40) });
    let seq = 0;
    const to = async <T extends EventType>(projectId: string, type: T, payload: EventPayloads[T]) => {
      await h.orch.accept({ id: `r-${++seq}`, type, at: h.clock.now(), projectId, ticketId: 'REL-1', ...signed, payload } as FactoryEvent);
      await h.orch.drained();
    };
    await to('p', 'ticket.delegated', { linearSessionId: 's1', repos });
    expect(await h.store.getTicket('p', 'REL-1')).toMatchObject({ blockReason: unroutedReason(repos), awaitingRepo: repos });
    expect(h.tracker.issues.get('REL-1')!.labels).toContain(BLOCKED_LABEL);
    return { h, to };
  }

  it('a delegation with the choice to make, on an issue deleted meanwhile, leaves no ticket and writes nothing to Linear (ORC-302)', async () => {
    const h = createHarness({ extraProjects: ['api'] });
    await h.orch.accept({ id: 'gone', type: 'ticket.delegated', at: h.clock.now(), projectId: 'p', ticketId: 'REL-9', ...signed, payload: { linearSessionId: 's1', repos } } as FactoryEvent);
    await h.orch.drained();
    expect(await h.store.getTicket('p', 'REL-9')).toBeUndefined();
    expect(h.tracker.calls.filter((c) => c.method !== 'getIssue')).toEqual([]);
    expect(h.runner.requests).toEqual([]);
  });

  it('its label names the repo it waits in: a new delegation lifts the wait and starts the work there', async () => {
    const { h, to } = await waiting();
    await to('p', 'ticket.delegated', { linearSessionId: 's2' });
    expect(await h.store.getTicket('p', 'REL-1')).toMatchObject({ blocked: false, delegated: true, awaitingRepo: null });
    expect(h.runner.requests).toHaveLength(1);
    expect(h.tracker.issues.get('REL-1')!.labels).not.toContain(BLOCKED_LABEL);
  });

  it('its label names another repo: the work starts there and the Bloqué label goes, with no pass needed', async () => {
    const { h, to } = await waiting();
    await to('api', 'ticket.delegated', { linearSessionId: 's2', waitedIn: 'p' });
    expect(await h.store.getTicket('api', 'REL-1')).toMatchObject({ blocked: false, delegated: true });
    expect(h.runner.requests).toHaveLength(1);
    expect(h.tracker.issues.get('REL-1')!.labels).not.toContain(BLOCKED_LABEL);
  });

  it('the wait lifted late, from a copy the store may no longer hold, leaves the ticket in its repo as it is', async () => {
    const { h, to } = await waiting();
    await to('api', 'ticket.delegated', { linearSessionId: 's2', waitedIn: 'p' });
    await to('p', 'ticket.undelegated', {});
    expect(await h.store.getTicket('api', 'REL-1')).toMatchObject({ blocked: false, delegated: true });
    expect(h.tracker.issues.get('REL-1')!.labels).not.toContain(BLOCKED_LABEL);
  });
});
