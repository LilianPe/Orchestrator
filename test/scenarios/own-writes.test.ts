import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { knownLabels, recordLabels } from '../../src/adapters/tracker/linear/labels.js';
import { reconcileOnce } from '../../src/adapters/tracker/linear/reconcile.js';
import { RECONCILE_MS } from '../../src/core/engine.js';
import type { FactoryEvent } from '../../src/core/types.js';
import { createHarness } from '../helpers/harness.js';
import { linearIngest } from '../helpers/linear-webhook.js';

const MEMBER = 'user-lilian';
/** The Linear id of the factory's app user, the actor of its own writes (`appUserId`). */
const APP = 'app';

/** A ticket delegated by a member, whose labels the factory has read (a pass before), its first run stopped at a cap: the factory puts `Bloqué` on it. */
async function blocked() {
  const h = createHarness({ authz: { githubLogins: { [MEMBER]: 'lilian-gh' } } });
  h.tracker.setTeamMembers('REL', [MEMBER]);
  h.forge.setRepoPermission('lilian-gh', 'write');
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.', delegateId: APP });
  await recordLabels(h.store, 'p', 'REL-1', [], 0);
  h.runner.enqueue({ outcome: 'limit' });
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: MEMBER });
  await h.orch.drained();
  expect(h.tracker.issues.get('REL-1')!.labels).toEqual(['Bloqué']);
  return h;
}

/** A signed issue webhook of REL-1's labels, `from` → `to` (label ids), done by `actor` at `at`. */
function labelsWebhook(actor: { id: string; name: string }, from: string[], to: string[], at: number) {
  const raw = JSON.stringify({
    type: 'Issue', action: 'update', webhookTimestamp: at, actor: { ...actor, type: 'user' },
    data: { id: 'u1', identifier: 'REL-1', number: 1, team: { key: 'REL' }, updatedAt: new Date(at).toISOString(), labelIds: to },
    updatedFrom: { labelIds: from },
  });
  return { raw, headers: { 'linear-signature': createHmac('sha256', 'inbox-test-secret').update(raw).digest('hex') } };
}

/** ORC-346: the factory knows its own label and status writes by who made them and by what it recorded, not by a 60 s window. */
describe("the factory's own writes in Linear (ORC-346)", () => {
  it('criterion 1: a label the factory set, its webhook lost, is no human change at the next 5-minute pass', async () => {
    const h = await blocked();
    await h.advance(RECONCILE_MS);
    const events: FactoryEvent[] = [];
    await reconcileOnce({ tracker: h.tracker, store: h.store, projects: [h.project], submit: (e) => events.push(e), clock: h.clock, log: () => {} });
    expect(events.filter((e) => e.type === 'label.changed' || e.type === 'status.changed')).toEqual([]);
    expect((await knownLabels(h.store, 'p', 'REL-1'))?.labels).toEqual(['Bloqué']);
  });

  it('criterion 2: a human who puts the same label back 30 s after the factory is heard', async () => {
    const h = await blocked();
    const accepted: FactoryEvent[] = [];
    const ingest = linearIngest(async (e) => (accepted.push(e), true), {
      now: () => h.clock.now(),
      ctx: {
        ticket: (p, id) => h.store.getTicket(p, id),
        labelNameById: (_t, id) => (id === 'l-blocked' ? 'Bloqué' : undefined),
        knownLabels: (p, id) => knownLabels(h.store, p, id),
        recordLabels: (p, id, labels, at) => recordLabels(h.store, p, id, labels, at),
        factoryActor: () => APP,
      },
    });
    const send = (w: { raw: string; headers: Record<string, string> }) => ingest(w.raw, w.headers);
    const lilian = { id: MEMBER, name: 'Lilian' };
    // The webhook of the factory's own write: no change of anyone's.
    await send(labelsWebhook({ id: APP, name: 'Factory' }, [], ['l-blocked'], h.clock.now()));
    await h.advance(20_000);
    await send(labelsWebhook(lilian, ['l-blocked'], [], h.clock.now()));
    await h.advance(10_000);
    await send(labelsWebhook(lilian, [], ['l-blocked'], h.clock.now()));
    expect(accepted.map((e) => [e.type, e.actor, e.payload])).toEqual([
      ['label.changed', MEMBER, { label: 'Bloqué', change: 'removed' }],
      ['label.changed', MEMBER, { label: 'Bloqué', change: 'added' }],
    ]);
  });
});
