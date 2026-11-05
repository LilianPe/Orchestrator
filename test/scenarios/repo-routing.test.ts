import { describe, expect, it } from 'vitest';
import { BLOCKED_LABEL } from '../../src/core/engine.js';
import { unroutedReason } from '../../src/core/routing.js';
import type { EventPayloads, EventType, FactoryEvent } from '../../src/core/types.js';
import { createHarness } from '../helpers/harness.js';

/**
 * A ticket's way out of its wait for a repo (ORC-291), on either store: SQLite keeps a copy of the ticket per
 * project, Postgres one row per ticket, which the project it goes to takes over.
 */
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
    expect((await h.store.getTicket('p', 'REL-1'))?.blockReason).toBe(unroutedReason(repos));
    expect(h.tracker.issues.get('REL-1')!.labels).toContain(BLOCKED_LABEL);
    return { h, to };
  }

  it('its label names the repo it waits in: a new delegation lifts the wait and starts the work there', async () => {
    const { h, to } = await waiting();
    await to('p', 'ticket.delegated', { linearSessionId: 's2' });
    expect(await h.store.getTicket('p', 'REL-1')).toMatchObject({ blocked: false, delegated: true });
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
