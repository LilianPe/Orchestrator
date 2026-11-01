import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FactoryEvent } from '../../../core/types.js';
import { SqliteStore } from '../../../store/sqlite-store.js';
import { createLinearIngest } from './ingest.js';
import { isFresh, isUsableWebhookSecret, mapLinearWebhook, stripMention, verifyLinearSignature, type MapContext } from './webhook.js';

const fx = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8'));
const NAMES: Record<string, string> = { 's-hr': 'Human Review', 's-ai': 'AI Review' };
const LOGICAL: Record<string, any> = { 'Human Review': 'human_review', 'AI Review': 'ai_review' };

function ctx(echoes: string[] = []): MapContext {
  return {
    projectIdForTeam: (k) => (k === 'REL' ? 'p' : undefined),
    logicalFor: (_p, name) => LOGICAL[name] ?? null,
    stateNameById: (_t, id) => NAMES[id],
    stateTypeById: (_t, id) => (id === 's-x' ? 'canceled' : 'started'),
    labelNameById: (_t, id) => ({ 'l-bug': 'bug', 'l-resume': 'agent:reprendre' })[id],
    isEcho: (k) => echoes.includes(k),
    commands: () => ['retiens', 'fais-le'],
    now: () => 5000,
  };
}

describe('signature', () => {
  it('accepts a valid HMAC and rejects others', () => {
    const raw = '{"a":1}';
    const sig = createHmac('sha256', 'sec').update(raw).digest('hex');
    expect(verifyLinearSignature(raw, sig, 'sec')).toBe(true);
    expect(verifyLinearSignature(raw, sig, 'other')).toBe(false);
    expect(verifyLinearSignature(raw, undefined, 'sec')).toBe(false);
    expect(verifyLinearSignature(raw, 'zz', 'sec')).toBe(false);
  });
  it('rejects everything when the secret is empty, even a signature computed with it', () => {
    const raw = '{"a":1}';
    for (const secret of ['', '  ']) {
      const sig = createHmac('sha256', secret).update(raw).digest('hex');
      expect(verifyLinearSignature(raw, sig, secret)).toBe(false);
    }
  });
  it('rejects instead of throwing when a hand-written secrets.json holds a non-string secret', () => {
    const raw = '{"a":1}';
    for (const secret of [12345, true, null]) {
      expect(isUsableWebhookSecret(secret)).toBe(false);
      expect(verifyLinearSignature(raw, 'ab', secret as unknown as string)).toBe(false);
    }
  });
  it('checks freshness', () => {
    expect(isFresh({ webhookTimestamp: 1000 }, 50_000)).toBe(true);
    expect(isFresh({ webhookTimestamp: 1000 }, 70_000)).toBe(false);
    expect(isFresh({}, 1000)).toBe(false);
  });
});

describe('stripMention', () => {
  it('removes plain and markdown mentions', () => {
    expect(stripMention('@factory  tu penses quoi ?')).toBe('tu penses quoi ?');
    expect(stripMention('[@factory](https://x) Retiens ça')).toBe('Retiens ça');
    expect(stripMention('sans mention')).toBe('sans mention');
  });
});

describe('mapLinearWebhook', () => {
  it('maps a delegation', async () => {
    expect(await mapLinearWebhook(fx('session-created-delegation'), 'd1', ctx())).toEqual([
      { id: 'linear:d1', type: 'ticket.delegated', at: 5000, schemaVersion: 3, taint: 'trusted', actor: 'user-lilian', projectId: 'p', ticketId: 'REL-1',
        payload: { linearSessionId: 'as-1', promptContext: '<issue identifier="REL-1">Export</issue>' } },
    ]);
  });
  it('maps a mention', async () => {
    expect((await mapLinearWebhook(fx('session-created-mention'), 'd2', ctx()))[0]).toMatchObject({
      type: 'session.mentioned', payload: { linearSessionId: 'as-2', body: 'tu penses quoi de cette approche ?', author: 'Lilian' },
    });
  });
  it('maps a command', async () => {
    expect((await mapLinearWebhook(fx('session-created-command'), 'd3', ctx()))[0]).toMatchObject({
      type: 'command', payload: { name: 'retiens', body: 'les agrégats côté serveur', linearSessionId: 'as-3' },
    });
  });
  it('maps a prompt and a stop', async () => {
    expect((await mapLinearWebhook(fx('session-prompted'), 'd4', ctx()))[0]).toMatchObject({
      type: 'session.prompted', payload: { linearSessionId: 'as-1', body: 'les boutons sont mal alignés', author: 'Lilian' },
    });
    expect((await mapLinearWebhook(fx('session-stop'), 'd5', ctx()))[0]).toMatchObject({ type: 'session.stopped', payload: { linearSessionId: 'as-1' } });
  });
  it('maps a move and an added label', async () => {
    const out = await mapLinearWebhook(fx('issue-moved-labeled'), 'd6', ctx());
    expect(out).toEqual([
      { id: 'linear:d6', type: 'status.changed', at: 5000, schemaVersion: 3, taint: 'trusted', actor: 'user-lilian', projectId: 'p', ticketId: 'REL-1', payload: { from: 'human_review', to: 'ai_review' } },
      { id: 'linear:d6:label:l-resume', type: 'label.changed', at: 5000, schemaVersion: 3, taint: 'trusted', actor: 'user-lilian', projectId: 'p', ticketId: 'REL-1', payload: { label: 'agent:reprendre', change: 'added' } },
    ]);
  });
  it('keeps the label event id when the state change is an echo', async () => {
    const out = await mapLinearWebhook(fx('issue-moved-labeled'), 'd6', ctx(['state:REL-1:AI Review']));
    expect(out.map((e) => e.id)).toEqual(['linear:d6:label:l-resume']);
  });
  it('keeps the label event id when the label is renamed', async () => {
    const renamed = { ...ctx(), labelNameById: (_t: string, id: string) => ({ 'l-bug': 'bug', 'l-resume': 'agent:resume' })[id] };
    const ids = async (c: MapContext) => (await mapLinearWebhook(fx('issue-moved-labeled'), 'd6', c)).map((e) => e.id);
    expect(await ids(renamed)).toEqual(await ids(ctx()));
  });
  it('drops echoes of our own writes', async () => {
    expect(await mapLinearWebhook(fx('issue-moved-labeled'), 'd7', ctx(['state:REL-1:AI Review', 'label:REL-1:agent:reprendre']))).toEqual([]);
  });
  it('drops echoes found by an asynchronous lookup, as the store answers', async () => {
    const echoes = ['state:REL-1:AI Review', 'label:REL-1:agent:reprendre'];
    const c = { ...ctx(), isEcho: async (k: string) => echoes.includes(k) };
    expect(await mapLinearWebhook(fx('issue-moved-labeled'), 'd9', c)).toEqual([]);
  });
  it('drops a label change the factory already knows, caught up by the reconciliation first (ORC-185)', async () => {
    const removed = { ...fx('issue-moved-labeled'), data: { ...fx('issue-moved-labeled').data, labelIds: ['l-resume'] }, updatedFrom: { labelIds: ['l-bug'] } };
    const known = (labels: string[] | undefined) => ({ ...ctx(), knownLabels: async () => labels });
    expect(await mapLinearWebhook(removed, 'd11', known(['agent:reprendre']))).toEqual([]);
    expect((await mapLinearWebhook(removed, 'd11', known(['bug']))).map((e) => e.payload)).toEqual([
      { label: 'agent:reprendre', change: 'added' },
      { label: 'bug', change: 'removed' },
    ]);
    expect(await mapLinearWebhook(removed, 'd11', known(undefined))).toHaveLength(2);
  });

  it('maps a removed label as label.changed, and drops the echo of a removal the factory made (ORC-160)', async () => {
    const removed = { ...fx('issue-moved-labeled'), data: { ...fx('issue-moved-labeled').data, labelIds: ['l-resume'] }, updatedFrom: { labelIds: ['l-bug'] } };
    expect(await mapLinearWebhook(removed, 'd10', ctx())).toEqual([
      { id: 'linear:d10:label:l-resume', type: 'label.changed', at: 5000, schemaVersion: 3, taint: 'trusted', actor: 'user-lilian', projectId: 'p', ticketId: 'REL-1', payload: { label: 'agent:reprendre', change: 'added' } },
      { id: 'linear:d10:label:l-bug', type: 'label.changed', at: 5000, schemaVersion: 3, taint: 'trusted', actor: 'user-lilian', projectId: 'p', ticketId: 'REL-1', payload: { label: 'bug', change: 'removed' } },
    ]);
    // An addition's echo does not hide a removal of the same label, nor the other way round.
    expect((await mapLinearWebhook(removed, 'd10', ctx(['label-removed:REL-1:bug']))).map((e) => e.payload)).toEqual([{ label: 'agent:reprendre', change: 'added' }]);
    expect((await mapLinearWebhook(removed, 'd10', ctx(['label:REL-1:bug']))).map((e) => e.payload)).toEqual([
      { label: 'agent:reprendre', change: 'added' },
      { label: 'bug', change: 'removed' },
    ]);
  });

  it('marks a move to a state of type canceled (ORC-170)', async () => {
    const body = fx('issue-moved-labeled');
    body.data = { ...body.data, stateId: 's-x', state: { id: 's-x', name: 'Canceled', type: 'canceled' }, labelIds: body.updatedFrom.labelIds };
    const [e] = await mapLinearWebhook(body, 'k', ctx());
    expect(e).toMatchObject({ type: 'status.changed', payload: { from: 'human_review', to: null, cancelled: true } });
  });

  it('reads the canceled type from the cache when the payload carries no state object', async () => {
    const body = fx('issue-moved-labeled');
    const { state: _s, ...data } = body.data;
    body.data = { ...data, stateId: 's-x', labelIds: body.updatedFrom.labelIds };
    const [e] = await mapLinearWebhook(body, 'k', { ...ctx(), stateNameById: (_t, id) => ({ ...NAMES, 's-x': 'Canceled' })[id] });
    expect(e).toMatchObject({ type: 'status.changed', payload: { to: null, cancelled: true } });
  });

  describe('signed actor and taint (ORC-160)', () => {
    it.each([
      ['session-created-delegation', 'ticket.delegated'],
      ['session-created-mention', 'session.mentioned'],
      ['session-created-command', 'command'],
      ['session-prompted', 'session.prompted'],
      ['session-stop', 'session.stopped'],
      ['issue-moved-labeled', 'status.changed'],
    ])('trusts %s written by a workspace user and carries their Linear id', async (name, type) => {
      expect((await mapLinearWebhook(fx(name), 'k', ctx()))[0]).toMatchObject({ type, actor: 'user-lilian', taint: 'trusted' });
    });

    it('marks a reply without a signed user id untrusted, the name quoted in it notwithstanding', async () => {
      const body = fx('session-prompted');
      body.agentActivity.user = { name: 'Lilian' };
      const [e] = await mapLinearWebhook(body, 'k', ctx());
      expect(e).toMatchObject({ type: 'session.prompted', taint: 'untrusted', payload: { author: 'Lilian' } });
      expect(e).not.toHaveProperty('actor');
    });

    it("names a reply without a user after no one else: not after the session's first comment", async () => {
      const body = fx('session-prompted');
      delete body.agentActivity.user;
      body.agentSession.comment = { id: 'c1', body: '@factory', user: { id: 'user-lilian', name: 'Lilian' } };
      expect((await mapLinearWebhook(body, 'k', ctx()))[0]).toMatchObject({ taint: 'untrusted', payload: { author: 'Humain' } });
    });

    it('marks a mention that came through a bot or from outside the workspace untrusted', async () => {
      for (const extra of [{ botActor: { name: 'Slack' } }, { externalUser: { name: 'client@example.com' } }]) {
        const body = fx('session-created-mention');
        Object.assign(body.agentSession.comment, extra);
        // The user id the comment carries is not lent to text a bot relayed: no actor for ORC-186 to authorize.
        const [e] = await mapLinearWebhook(body, 'k', ctx());
        expect(e).toMatchObject({ type: 'session.mentioned', taint: 'untrusted' });
        expect(e).not.toHaveProperty('actor');
      }
      const anonymous = fx('session-created-mention');
      delete anonymous.agentSession.comment.user;
      expect((await mapLinearWebhook(anonymous, 'k', ctx()))[0]).toMatchObject({ type: 'session.mentioned', taint: 'untrusted' });
    });

    it('marks an issue change made by an integration or an OAuth app untrusted, and one without an actor', async () => {
      for (const actor of [{ id: 'int-1', type: 'Integration', name: 'Jira' }, { id: 'app-2', type: 'OauthClient', name: 'Zapier' }]) {
        const out = await mapLinearWebhook({ ...fx('issue-moved-labeled'), actor }, 'k', ctx());
        expect(out.map((e) => [e.type, e.taint, e.actor])).toEqual([
          ['status.changed', 'untrusted', undefined],
          ['label.changed', 'untrusted', undefined],
        ]);
      }
      const { actor: _, ...noActor } = fx('issue-moved-labeled');
      expect((await mapLinearWebhook(noActor, 'k', ctx())).map((e) => e.taint)).toEqual(['untrusted', 'untrusted']);
    });

    it('takes the user id Linear gives as a bare field when the user object is absent', async () => {
      const body = fx('session-prompted');
      body.agentActivity = { ...body.agentActivity, user: undefined, userId: 'user-2' };
      expect((await mapLinearWebhook(body, 'k', ctx()))[0]).toMatchObject({ actor: 'user-2', taint: 'trusted' });
    });
  });

  it('ignores unknown teams', async () => {
    const body = fx('session-prompted');
    body.agentSession.issue.identifier = 'OTHER-1';
    expect(await mapLinearWebhook(body, 'd8', ctx())).toEqual([]);
  });
});

describe('ingest', () => {
  function signed(body: unknown) {
    const raw = JSON.stringify(body);
    return { raw, sig: createHmac('sha256', 'sec').update(raw).digest('hex') };
  }

  /** An inbox on the SQLite store, as the daemon has it without FACTORY_DATABASE_URL. */
  function inbox(store = new SqliteStore(':memory:')) {
    return {
      store,
      accept: (e: FactoryEvent) => store.appendInbox(e),
      ids: async () => (await store.pendingInbox(100)).map((e) => e.id),
    };
  }

  it('writes a delegation to the inbox, then acks, then answers 200 (ORC-147)', async () => {
    const order: string[] = [];
    const { store, ids } = inbox();
    const ingest = createLinearIngest({
      secret: () => 'sec',
      ctx: { ...ctx(), now: () => 2000 },
      accept: async (e) => {
        const fresh = await store.appendInbox(e);
        order.push(`inbox:${e.type}`);
        return fresh;
      },
      ack: async (s) => void order.push(`ack:${s}`),
      log: () => {},
    });
    const { raw, sig } = signed(fx('session-created-delegation'));
    expect(await ingest(raw, { 'linear-signature': sig })).toEqual({ status: 200 });
    expect(order).toEqual(['inbox:ticket.delegated', 'ack:as-1']);
    expect(await ids()).toHaveLength(1);
  });

  it('records the labels an issue webhook reads, echoes included, once its events are in the inbox (ORC-185)', async () => {
    const recorded: unknown[][] = [];
    const body = { ...fx('issue-moved-labeled'), webhookTimestamp: 2000 };
    // `lost` was added by a webhook that never came: this one only adds agent:reprendre, so `lost` stays unknown.
    const c = { ...ctx(['label:REL-1:agent:reprendre']), now: () => 2000, knownLabels: async () => ['bug'], recordLabels: async (...a: unknown[]) => void recorded.push(a) };
    const { raw, sig } = signed(body);
    const ok = createLinearIngest({ secret: () => 'sec', ctx: c, accept: async () => true, ack: async () => {}, log: () => {} });
    expect(await ok(raw, { 'linear-signature': sig })).toEqual({ status: 200 });
    expect(recorded).toEqual([['p', 'REL-1', ['bug', 'agent:reprendre'], Date.parse(body.data.updatedAt)]]);
    recorded.length = 0;
    // A lost label in the full list is not recorded: the reconciliation still reports it.
    const withLost = { ...body, data: { ...body.data, labelIds: ['l-bug', 'l-resume', 'l-lost'] }, updatedFrom: { labelIds: ['l-bug', 'l-lost'] }, webhookTimestamp: 2000 };
    const s2 = signed(withLost);
    const lost = createLinearIngest({ secret: () => 'sec', ctx: { ...c, labelNameById: (_t: string, id: string) => ({ 'l-bug': 'bug', 'l-resume': 'agent:reprendre', 'l-lost': 'lost' })[id] }, accept: async () => true, ack: async () => {}, log: () => {} });
    expect(await lost(s2.raw, { 'linear-signature': s2.sig })).toEqual({ status: 200 });
    expect(recorded).toEqual([['p', 'REL-1', ['bug', 'agent:reprendre'], Date.parse(body.data.updatedAt)]]);
    recorded.length = 0;
    const failing = createLinearIngest({ secret: () => 'sec', ctx: c, accept: async () => Promise.reject(new Error('disk')), ack: async () => {}, log: () => {} });
    expect(await failing(raw, { 'linear-signature': sig })).toEqual({ status: 500 });
    // Not in the inbox: Linear sends it again, and it must not be taken for a change already known then.
    expect(recorded).toEqual([]);
  });

  it('acks with the id of the event, so the daemon can record when (ORC-235)', async () => {
    const acked: [string, string][] = [];
    const { store } = inbox();
    const ingest = createLinearIngest({
      secret: () => 'sec',
      ctx: { ...ctx(), now: () => 2000 },
      accept: (e) => store.appendInbox(e),
      ack: async (sessionId, eventId) => void acked.push([sessionId, eventId]),
      log: () => {},
    });
    const delegation = signed(fx('session-created-delegation'));
    expect(await ingest(delegation.raw, { 'linear-signature': delegation.sig })).toEqual({ status: 200 });
    expect(acked).toEqual((await store.pendingInbox(10)).map((e) => ['as-1', e.id]));
  });

  it('answers only once the inbox write is committed', async () => {
    let commit!: () => void;
    const committed = new Promise<void>((r) => (commit = r));
    const { store, ids } = inbox();
    const ingest = createLinearIngest({
      secret: () => 'sec',
      ctx: { ...ctx(), now: () => 2000 },
      accept: async (e) => {
        await committed;
        return store.appendInbox(e);
      },
      ack: async () => {},
      log: () => {},
    });
    const { raw, sig } = signed(fx('session-created-delegation'));
    let answered: { status: number } | undefined;
    const response = ingest(raw, { 'linear-signature': sig }).then((r) => (answered = r));
    await new Promise((r) => setTimeout(r, 10));
    expect(answered).toBeUndefined();
    expect(await ids()).toEqual([]);
    commit();
    await response;
    expect(answered).toEqual({ status: 200 });
    expect(await ids()).toHaveLength(1);
  });

  it('answers 500 without acking when the inbox write fails, and takes the webhook Linear sends again', async () => {
    const acks: string[] = [];
    const logs: string[] = [];
    const { store, ids } = inbox();
    let down = true;
    const ingest = createLinearIngest({
      secret: () => 'sec',
      ctx: { ...ctx(), now: () => 2000 },
      accept: async (e) => {
        if (down) throw new Error('database down');
        return store.appendInbox(e);
      },
      ack: async (s) => void acks.push(s),
      log: (m) => logs.push(m),
    });
    const { raw, sig } = signed(fx('session-created-delegation'));
    expect(await ingest(raw, { 'linear-signature': sig })).toEqual({ status: 500 });
    expect(acks).toEqual([]);
    expect(logs.join('\n')).toContain('database down');
    down = false;
    expect(await ingest(raw, { 'linear-signature': sig })).toEqual({ status: 200 });
    expect(acks).toEqual(['as-1']);
    expect(await ids()).toHaveLength(1);
  });

  function make(store?: SqliteStore) {
    const acks: string[] = [];
    const box = inbox(store);
    const ingest = createLinearIngest({
      secret: () => 'sec',
      ctx: { ...ctx(), now: () => 1000 },
      accept: box.accept,
      ack: async (s) => void acks.push(s),
      log: () => {},
    });
    const send = async (body: unknown, headers: Record<string, string> = {}) => {
      const { raw, sig } = signed(body);
      expect(await ingest(raw, { ...headers, 'linear-signature': sig })).toEqual({ status: 200 });
    };
    return { ids: box.ids, acks, send, store: box.store };
  }

  // A fresh inbox per call: the ids that reach the store.
  async function idsOf(body: unknown, headers?: Record<string, string>): Promise<string[]> {
    const { ids, send } = make();
    await send(body, headers);
    return ids();
  }

  it.each(['session-prompted', 'session-created-delegation', 'issue-moved-labeled'])(
    'derives %s event ids from the signed body only',
    async (name) => {
      const first = await idsOf(fx(name), { 'linear-delivery': 'd1' });
      expect(first.length).toBeGreaterThan(0);
      expect(await idsOf(fx(name), { 'linear-delivery': 'forged' })).toEqual(first);
      expect(await idsOf(fx(name))).toEqual(first);
      expect(await idsOf({ ...fx(name), webhookTimestamp: 1500 })).toEqual(first);
    },
  );

  it('gives distinct ids to two different webhooks', async () => {
    const prompted = fx('session-prompted');
    const moved = fx('issue-moved-labeled');
    const ids = [
      ...(await idsOf(prompted)),
      ...(await idsOf({ ...prompted, agentActivity: { ...prompted.agentActivity, id: 'aa-2' } })),
      ...(await idsOf(moved)),
      ...(await idsOf({ ...moved, data: { ...moved.data, updatedAt: '2026-10-15T10:00:01.000Z' } })),
    ];
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the fallback id when Linear resends with a new webhookTimestamp', async () => {
    const { agentActivity: _, ...noActivityId } = fx('session-prompted');
    const body = { ...noActivityId, agentActivity: { content: { body: 'x' } } };
    const first = await idsOf(body);
    expect(first.length).toBe(1);
    expect(await idsOf({ ...body, webhookTimestamp: 1500 })).toEqual(first);
  });

  it('neither acks nor writes again a webhook replayed within the freshness window', async () => {
    const { ids, acks, send } = make();
    await send(fx('session-created-delegation'), { 'linear-delivery': 'd1' });
    await send(fx('session-created-delegation'), { 'linear-delivery': 'forged' });
    await send({ ...fx('session-created-delegation'), webhookTimestamp: 1500 });
    expect(acks).toEqual(['as-1']);
    expect(await ids()).toHaveLength(1);
  });

  it('drops a replay after a restart: the dedup is the inbox key, not process memory', async () => {
    const before = make();
    await before.send(fx('session-created-delegation'));
    await before.store.markInboxProcessed((await before.ids())[0]!);
    // A new ingest (a restarted daemon) over the same store.
    const after = make(before.store);
    await after.send({ ...fx('session-created-delegation'), webhookTimestamp: 1500 });
    expect(after.acks).toEqual([]);
    expect(await after.ids()).toEqual([]);
  });

  it('keeps the taint and the actor of an event through the inbox, as decide reads them (ORC-160)', async () => {
    const { store, send } = make();
    const body = fx('session-prompted');
    body.agentActivity.user = { name: 'Lilian' };
    await send(body);
    await send(fx('issue-moved-labeled'));
    expect((await store.pendingInbox(100)).map((e) => [e.type, e.taint, e.actor])).toEqual([
      ['session.prompted', 'untrusted', undefined],
      ['status.changed', 'trusted', 'user-lilian'],
      ['label.changed', 'trusted', 'user-lilian'],
    ]);
  });

  it('writes once when the same webhook arrives twice while the echo lookup is pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { accept, ids } = inbox();
    const ingest = createLinearIngest({
      secret: () => 'sec',
      ctx: { ...ctx(), now: () => 1000, isEcho: async () => (await gate, false) },
      accept,
      ack: async () => {},
      log: () => {},
    });
    const { raw, sig } = signed(fx('issue-moved-labeled'));
    const both = Promise.all([ingest(raw, { 'linear-signature': sig }), ingest(raw, { 'linear-signature': sig })]);
    release();
    expect(await both).toEqual([{ status: 200 }, { status: 200 }]);
    expect(await ids()).toEqual(['linear:issue:u1:2026-10-15T10:00:00.000Z', 'linear:issue:u1:2026-10-15T10:00:00.000Z:label:l-resume']);
  });

  it('writes two webhooks in arrival order even when the echo lookup of the first is slower', async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const { accept, ids } = inbox();
    const ingest = createLinearIngest({
      secret: () => 'sec',
      // The first webhook moves the ticket to AI Review, the second to Human Review; only the first lookup waits.
      ctx: { ...ctx(), now: () => 1000, isEcho: async (k: string) => (k === 'state:REL-1:AI Review' ? (await slow, false) : false) },
      accept,
      ack: async () => {},
      log: () => {},
    });
    const moved = fx('issue-moved-labeled');
    const first = { ...moved, updatedFrom: { stateId: 's-hr' } };
    const second = {
      ...moved,
      data: { ...moved.data, updatedAt: '2026-10-15T10:00:01.000Z', stateId: 's-hr', state: { id: 's-hr', name: 'Human Review' } },
      updatedFrom: { stateId: 's-ai' },
    };
    const a = signed(first);
    const b = signed(second);
    const both = Promise.all([ingest(a.raw, { 'linear-signature': a.sig }), ingest(b.raw, { 'linear-signature': b.sig })]);
    await new Promise((r) => setTimeout(r, 10));
    expect(await ids()).toEqual([]);
    release();
    await both;
    expect(await ids()).toEqual(['linear:issue:u1:2026-10-15T10:00:00.000Z', 'linear:issue:u1:2026-10-15T10:00:01.000Z']);
  });

  it('answers 500 to a webhook whose echo lookup failed, and keeps ingesting', async () => {
    let fail = true;
    const { accept, ids } = inbox();
    const ingest = createLinearIngest({
      secret: () => 'sec',
      ctx: { ...ctx(), now: () => 1000, isEcho: async () => { if (fail) throw new Error('store down'); return false; } },
      accept,
      ack: async () => {},
      log: () => {},
    });
    const { raw, sig } = signed(fx('issue-moved-labeled'));
    expect(await ingest(raw, { 'linear-signature': sig })).toEqual({ status: 500 });
    fail = false;
    expect(await ingest(raw, { 'linear-signature': sig })).toEqual({ status: 200 });
    expect(await ids()).toHaveLength(2);
  });

  it('rejects a bad signature and a stale body', async () => {
    const accept = vi.fn(async () => true);
    const ingest = createLinearIngest({ secret: () => 'sec', ctx: { ...ctx(), now: () => 999_999 }, accept, ack: async () => {}, log: () => {} });
    const { raw, sig } = signed(fx('session-prompted'));
    expect(await ingest(raw, { 'linear-signature': 'bad' })).toEqual({ status: 401 });
    expect(await ingest(raw, { 'linear-signature': sig })).toEqual({ status: 401 });
    expect(accept).not.toHaveBeenCalled();
  });

  it('rejects a fresh webhook forged with an empty secret', async () => {
    const accept = vi.fn(async () => true);
    const ingest = createLinearIngest({ secret: () => '', ctx: { ...ctx(), now: () => 2000 }, accept, ack: async () => {}, log: () => {} });
    const raw = JSON.stringify(fx('session-prompted'));
    const forged = createHmac('sha256', '').update(raw).digest('hex');
    expect(await ingest(raw, { 'linear-signature': forged })).toEqual({ status: 401 });
    expect(accept).not.toHaveBeenCalled();
  });
});
