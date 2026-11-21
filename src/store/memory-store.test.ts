import { describe, expect, it } from 'vitest';
import { storeContract } from '../../test/helpers/store-suite.js';
import type { FactoryEvent } from '../core/types.js';
import { MemoryStore } from './memory-store.js';
import type { DecisionRequest } from './types.js';

// The shared Store contract, also run on PgStore (test/integration/pg-store.test.ts).
describe('MemoryStore', () => {
  storeContract(() => new MemoryStore());

  it('holds back an effect in backoff by its clock, and hands it out once that clock passes', async () => {
    let now = 1_000;
    const s = new MemoryStore(() => now);
    const event = { id: 'e1', type: 'ticket.delegated', at: 1, projectId: 'p', ticketId: 'REL-1', payload: { linearSessionId: 'ls' } } as FactoryEvent;
    await s.appendInbox(event);
    const req: DecisionRequest = {
      event,
      workflow: { hash: '', definition: {} },
      decide: () => ({ effects: [{ kind: 'comment', body: 'x' }], timers: [], clearTimers: false }),
    };
    expect(await s.decide(req)).toMatchObject({ status: 'committed', effectIds: ['REL-1:1:1'] });
    const claimed = await s.claimEffect('p', 'REL-1', 60_000);
    if (!claimed || claimed === 'busy') throw new Error('not claimed');
    expect(await s.retryEffect(claimed.id, claimed.lease!, 'down', 500)).toBe(true);
    now = 1_499;
    expect(await s.claimEffect('p', 'REL-1', 60_000)).toBe('busy');
    now = 1_500;
    expect(await s.claimEffect('p', 'REL-1', 60_000)).toMatchObject({ id: 'REL-1:1:1', attempts: 2 });
  });

  it('hands out copies: a row read and changed by its caller is not changed in the store', async () => {
    const s = new MemoryStore();
    await s.setMeta('k', 'v');
    const t = { projectId: 'p', ticketId: 'REL-1', title: 'T', logical: 'todo' } as never;
    await s.putTicket(t);
    const read = (await s.getTicket('p', 'REL-1'))!;
    read.title = 'changed';
    expect((await s.getTicket('p', 'REL-1'))!.title).toBe('T');
  });
});
