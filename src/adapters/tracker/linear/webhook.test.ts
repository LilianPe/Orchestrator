import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FactoryEvent } from '../../../core/types.js';
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
  it('maps a delegation', () => {
    expect(mapLinearWebhook(fx('session-created-delegation'), 'd1', ctx())).toEqual([
      { id: 'linear:d1', type: 'ticket.delegated', at: 5000, schemaVersion: 2, taint: 'trusted', projectId: 'p', ticketId: 'REL-1',
        payload: { linearSessionId: 'as-1', promptContext: '<issue identifier="REL-1">Export</issue>' } },
    ]);
  });
  it('maps a mention', () => {
    expect(mapLinearWebhook(fx('session-created-mention'), 'd2', ctx())[0]).toMatchObject({
      type: 'session.mentioned', payload: { linearSessionId: 'as-2', body: 'tu penses quoi de cette approche ?', author: 'Lilian' },
    });
  });
  it('maps a command', () => {
    expect(mapLinearWebhook(fx('session-created-command'), 'd3', ctx())[0]).toMatchObject({
      type: 'command', payload: { name: 'retiens', body: 'les agrégats côté serveur', linearSessionId: 'as-3' },
    });
  });
  it('maps a prompt and a stop', () => {
    expect(mapLinearWebhook(fx('session-prompted'), 'd4', ctx())[0]).toMatchObject({
      type: 'session.prompted', payload: { linearSessionId: 'as-1', body: 'les boutons sont mal alignés', author: 'Lilian' },
    });
    expect(mapLinearWebhook(fx('session-stop'), 'd5', ctx())[0]).toMatchObject({ type: 'session.stopped', payload: { linearSessionId: 'as-1' } });
  });
  it('maps a move and an added label', () => {
    const out = mapLinearWebhook(fx('issue-moved-labeled'), 'd6', ctx());
    expect(out).toEqual([
      { id: 'linear:d6', type: 'status.changed', at: 5000, schemaVersion: 2, taint: 'trusted', projectId: 'p', ticketId: 'REL-1', payload: { from: 'human_review', to: 'ai_review' } },
      { id: 'linear:d6:label:l-resume', type: 'label.changed', at: 5000, schemaVersion: 2, taint: 'trusted', projectId: 'p', ticketId: 'REL-1', payload: { label: 'agent:reprendre', change: 'added' } },
    ]);
  });
  it('keeps the label event id when the state change is an echo', () => {
    const out = mapLinearWebhook(fx('issue-moved-labeled'), 'd6', ctx(['state:REL-1:AI Review']));
    expect(out.map((e) => e.id)).toEqual(['linear:d6:label:l-resume']);
  });
  it('keeps the label event id when the label is renamed', () => {
    const renamed = { ...ctx(), labelNameById: (_t: string, id: string) => ({ 'l-bug': 'bug', 'l-resume': 'agent:resume' })[id] };
    const ids = (c: MapContext) => mapLinearWebhook(fx('issue-moved-labeled'), 'd6', c).map((e) => e.id);
    expect(ids(renamed)).toEqual(ids(ctx()));
  });
  it('drops echoes of our own writes', () => {
    expect(mapLinearWebhook(fx('issue-moved-labeled'), 'd7', ctx(['state:REL-1:AI Review', 'label:REL-1:agent:reprendre']))).toEqual([]);
  });
  it('ignores unknown teams', () => {
    const body = fx('session-prompted');
    body.agentSession.issue.identifier = 'OTHER-1';
    expect(mapLinearWebhook(body, 'd8', ctx())).toEqual([]);
  });
});

describe('ingest', () => {
  function signed(body: unknown) {
    const raw = JSON.stringify(body);
    return { raw, sig: createHmac('sha256', 'sec').update(raw).digest('hex') };
  }

  it('acks then submits a delegation', () => {
    const order: string[] = [];
    const ingest = createLinearIngest({
      secret: () => 'sec',
      ctx: { ...ctx(), now: () => 2000 },
      submit: (e: FactoryEvent) => void order.push(`submit:${e.type}`),
      ack: async (s) => void order.push(`ack:${s}`),
      log: () => {},
    });
    const { raw, sig } = signed(fx('session-created-delegation'));
    expect(ingest(raw, { 'linear-signature': sig })).toEqual({ status: 200 });
    expect(order).toEqual(['ack:as-1', 'submit:ticket.delegated']);
  });

  function make() {
    const ids: string[] = [];
    const acks: string[] = [];
    const ingest = createLinearIngest({
      secret: () => 'sec',
      ctx: { ...ctx(), now: () => 1000 },
      submit: (e: FactoryEvent) => void ids.push(e.id),
      ack: async (s) => void acks.push(s),
      log: () => {},
    });
    const send = (body: unknown, headers: Record<string, string> = {}) => {
      const { raw, sig } = signed(body);
      expect(ingest(raw, { ...headers, 'linear-signature': sig })).toEqual({ status: 200 });
    };
    return { ids, acks, send };
  }

  // A fresh ingest per call: the ids that reach the store, without the in-memory replay guard.
  function idsOf(body: unknown, headers?: Record<string, string>): string[] {
    const { ids, send } = make();
    send(body, headers);
    return ids;
  }

  it.each(['session-prompted', 'session-created-delegation', 'issue-moved-labeled'])(
    'derives %s event ids from the signed body only',
    (name) => {
      const first = idsOf(fx(name), { 'linear-delivery': 'd1' });
      expect(first.length).toBeGreaterThan(0);
      expect(idsOf(fx(name), { 'linear-delivery': 'forged' })).toEqual(first);
      expect(idsOf(fx(name))).toEqual(first);
      expect(idsOf({ ...fx(name), webhookTimestamp: 1500 })).toEqual(first);
    },
  );

  it('gives distinct ids to two different webhooks', () => {
    const prompted = fx('session-prompted');
    const moved = fx('issue-moved-labeled');
    const ids = [
      ...idsOf(prompted),
      ...idsOf({ ...prompted, agentActivity: { ...prompted.agentActivity, id: 'aa-2' } }),
      ...idsOf(moved),
      ...idsOf({ ...moved, data: { ...moved.data, updatedAt: '2026-10-15T10:00:01.000Z' } }),
    ];
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the fallback id when Linear resends with a new webhookTimestamp', () => {
    const { agentActivity: _, ...noActivityId } = fx('session-prompted');
    const body = { ...noActivityId, agentActivity: { content: { body: 'x' } } };
    const first = idsOf(body);
    expect(first.length).toBe(1);
    expect(idsOf({ ...body, webhookTimestamp: 1500 })).toEqual(first);
  });

  it('neither acks nor submits again a webhook replayed within the freshness window', () => {
    const { ids, acks, send } = make();
    send(fx('session-created-delegation'), { 'linear-delivery': 'd1' });
    send(fx('session-created-delegation'), { 'linear-delivery': 'forged' });
    send({ ...fx('session-created-delegation'), webhookTimestamp: 1500 });
    expect(acks).toEqual(['as-1']);
    expect(ids).toHaveLength(1);
  });

  it('still drops a replay that is fresh when a later webhook purges the guard', () => {
    let now = 1000;
    const ids: string[] = [];
    const ingest = createLinearIngest({
      secret: () => 'sec',
      ctx: { ...ctx(), now: () => now },
      submit: (e: FactoryEvent) => void ids.push(e.id),
      ack: async () => {},
      log: () => {},
    });
    const send = (body: unknown) => {
      const { raw, sig } = signed(body);
      return ingest(raw, { 'linear-signature': sig });
    };
    const first = fx('session-prompted');
    send(first);
    now = 60_000;
    send({ ...first, webhookTimestamp: 60_000, agentActivity: { ...first.agentActivity, id: 'aa-2' } });
    now = 61_000;
    expect(send(first)).toEqual({ status: 200 });
    expect(ids).toHaveLength(2);
  });

  it('rejects a bad signature and a stale body', () => {
    const submit = vi.fn();
    const ingest = createLinearIngest({ secret: () => 'sec', ctx: { ...ctx(), now: () => 999_999 }, submit, ack: async () => {}, log: () => {} });
    const { raw, sig } = signed(fx('session-prompted'));
    expect(ingest(raw, { 'linear-signature': 'bad' })).toEqual({ status: 401 });
    expect(ingest(raw, { 'linear-signature': sig })).toEqual({ status: 401 });
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects a fresh webhook forged with an empty secret', () => {
    const submit = vi.fn();
    const ingest = createLinearIngest({ secret: () => '', ctx: { ...ctx(), now: () => 2000 }, submit, ack: async () => {}, log: () => {} });
    const raw = JSON.stringify(fx('session-prompted'));
    const forged = createHmac('sha256', '').update(raw).digest('hex');
    expect(ingest(raw, { 'linear-signature': forged })).toEqual({ status: 401 });
    expect(submit).not.toHaveBeenCalled();
  });
});
