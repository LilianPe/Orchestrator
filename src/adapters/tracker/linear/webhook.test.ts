import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { newTicketState, type FactoryEvent, type TicketState } from '../../../core/types.js';
import { SqliteStore } from '../../../store/sqlite-store.js';
import { createLinearIngest, type RetryPolicy } from './ingest.js';
import { loadWorkflow } from '../../../config/load-workflow.js';
import { FakeClock } from '../../../core/clock.js';
import { unroutedReason } from '../../../core/routing.js';
import { FakeTracker } from '../fake.js';
import { IssueNotFoundError } from '../types.js';
import { knownLabels, recordLabels, serial } from './labels.js';
import { reconcileOnce } from './reconcile.js';
import { deliveryKey, isFresh, isUsableWebhookSecret, mapLinearWebhook, stripMention, verifyLinearSignature, type MapContext } from './webhook.js';

const fx = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8'));
const NAMES: Record<string, string> = { 's-hr': 'Human Review', 's-ai': 'AI Review' };
const LOGICAL: Record<string, any> = { 'Human Review': 'human_review', 'AI Review': 'ai_review' };

function ctx(echoes: string[] = []): MapContext {
  return {
    projectsOfTeam: (k) => (k === 'REL' ? ['p'] : []),
    labelsOf: async () => [],
    ticket: async () => undefined,
    logicalFor: (_p, name) => LOGICAL[name] ?? null,
    stateNameById: (_t, id) => NAMES[id],
    stateTypeById: (_t, id) => (id === 's-x' ? 'canceled' : 'started'),
    labelNameById: (_t, id) => ({ 'l-bug': 'bug', 'l-resume': 'agent:reprendre' })[id],
    isEcho: (k) => echoes.includes(k),
    commands: () => ['retiens', 'fais-le'],
    now: () => 5000,
  };
}

describe('a Linear team no project takes (ORC-171)', () => {
  const noTeam = (name: string) => {
    const body = fx(name);
    if (body.agentSession) body.agentSession.issue.identifier = 'ZZZ-1';
    if (body.data) {
      body.data.identifier = 'ZZZ-1';
      if (body.data.team) body.data.team.key = 'ZZZ';
    }
    return body;
  };
  const first: MapContext = { ...ctx(), firstProject: () => 'first' };

  it('sends its delegation to the first project, naming the team, with the signed actor, and the ack its session is owed', async () => {
    expect(await mapLinearWebhook(noTeam('session-created-delegation'), 'd1', first)).toEqual([
      {
        id: 'linear:d1', type: 'ticket.delegated', at: 5000, schemaVersion: 3, taint: 'trusted', actor: 'user-lilian', projectId: 'first', ticketId: 'ZZZ-1',
        payload: { linearSessionId: 'as-1', promptContext: '<issue identifier="REL-1">Export</issue>', ack: true, noRepo: 'ZZZ' },
      },
    ]);
  });

  it('reads no label: a repo: label names a repo of its own team only, and this team has none', async () => {
    const labelsOf = vi.fn(async () => ['repo:first']);
    const [event] = await mapLinearWebhook(noTeam('session-created-delegation'), 'd1', { ...first, labelsOf });
    expect(event).toMatchObject({ projectId: 'first', payload: { noRepo: 'ZZZ' } });
    expect(labelsOf).not.toHaveBeenCalled();
  });

  describe('once a project takes it', () => {
    const noRepoRow = { ...newTicketState('first', 'ZZZ-1', 'T', 'todo', 0), delegated: true, blocked: true, awaitingRepo: [] };
    const taken = (stored: TicketState[], team = ['zzz']): MapContext => ({
      ...first,
      projectsOfTeam: (k) => (k === 'ZZZ' ? team : []),
      ticket: async (p, id) => stored.find((t) => t.projectId === p && t.ticketId === id),
    });

    it('its delegation goes to that project and says where it waited, with its ack', async () => {
      const [event] = await mapLinearWebhook(noTeam('session-created-delegation'), 'd1', taken([noRepoRow]));
      expect(event).toMatchObject({ projectId: 'zzz', payload: { ack: true, waitedIn: 'first' } });
      expect((event!.payload as { noRepo?: string }).noRepo).toBeUndefined();
    });

    it('names no wait for a ticket that had none, nor for an event that is no delegation', async () => {
      const [fresh] = await mapLinearWebhook(noTeam('session-created-delegation'), 'd1', taken([]));
      expect(fresh!.payload).not.toHaveProperty('waitedIn');
      const [mention] = await mapLinearWebhook(noTeam('session-created-mention'), 'd2', taken([noRepoRow]));
      expect(mention!.payload).not.toHaveProperty('waitedIn');
    });

    it('still asks for the repo when that team has several, the wait named too', async () => {
      const [event] = await mapLinearWebhook(noTeam('session-created-delegation'), 'd1', taken([noRepoRow], ['zzz', 'yyy']));
      expect(event).toMatchObject({ projectId: 'zzz', payload: { ack: true, repos: ['zzz', 'yyy'], waitedIn: 'first' } });
    });
  });

  it.each(['session-created-mention', 'session-created-command', 'session-prompted', 'session-stop', 'issue-moved-labeled'])('still drops %s: only a delegation asks for a repo', async (name) => {
    expect(await mapLinearWebhook(noTeam(name), 'd2', first)).toEqual([]);
  });

  it('drops the delegation too with no project at all to wait under', async () => {
    expect(await mapLinearWebhook(noTeam('session-created-delegation'), 'd3', ctx())).toEqual([]);
  });

  it('leaves a known team as it was', async () => {
    expect(await mapLinearWebhook(fx('session-created-delegation'), 'd4', first)).toMatchObject([{ projectId: 'p', payload: { ack: true } }]);
  });
});

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
        payload: { linearSessionId: 'as-1', promptContext: '<issue identifier="REL-1">Export</issue>', ack: true } },
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
  it('maps /refreeze as a command whatever the workflow declares (ORC-131)', async () => {
    const body = fx('session-created-command');
    body.agentSession.comment.body = '[@factory](https://linear.app/x/profiles/factory) /refreeze le test de l’export était faux';
    expect((await mapLinearWebhook(body, 'd3', ctx()))[0]).toMatchObject({
      type: 'command', actor: 'user-lilian', payload: { name: '/refreeze', body: 'le test de l’export était faux', linearSessionId: 'as-3', ack: true },
    });
  });
  it('maps /refreeze answered in a session as the command, not as feedback that relaunches the agent (ORC-131)', async () => {
    const body = fx('session-prompted');
    body.agentActivity.content.body = '/refreeze le test était faux';
    expect((await mapLinearWebhook(body, 'd3', ctx()))[0]).toMatchObject({
      type: 'command', payload: { name: '/refreeze', body: 'le test était faux', linearSessionId: 'as-1', author: 'Lilian' },
    });
  });
  it('maps a prompt and a stop', async () => {
    expect((await mapLinearWebhook(fx('session-prompted'), 'd4', ctx()))[0]).toMatchObject({
      type: 'session.prompted', payload: { linearSessionId: 'as-1', body: 'les boutons sont mal alignés', author: 'Lilian' },
    });
    expect((await mapLinearWebhook(fx('session-stop'), 'd5', ctx()))[0]).toMatchObject({ type: 'session.stopped', payload: { linearSessionId: 'as-1' } });
  });
  describe('classifies a message at its arrival, journaled with it (ORC-180, ORC-336)', () => {
    const reply = (text: string, c: MapContext = ctx()) => {
      const body = fx('session-prompted');
      body.agentActivity.content.body = text;
      return mapLinearWebhook(body, 'd', c);
    };
    const mention = (text: string, c: MapContext = ctx()) => {
      const body = fx('session-created-mention');
      body.agentSession.comment.body = text;
      return mapLinearWebhook(body, 'd', c);
    };
    /** Through the ingest, with a fake small model that answers `verdict` (or rejects) and records what it was asked. */
    const model = (verdict: 'instruction' | 'question' | Error) => {
      const asked: string[] = [];
      const logs: string[] = [];
      const accepted: FactoryEvent[] = [];
      const ingest = createLinearIngest({
        secret: () => 'sec',
        ctx: ctx(),
        accept: async (e) => void accepted.push(e),
        log: (m) => void logs.push(m),
        classify: async (b) => {
          asked.push(b);
          if (verdict instanceof Error) throw verdict;
          return verdict;
        },
        deliveries: new SqliteStore(':memory:'),
      });
      let n = 0;
      const send = async (body: any) => {
        const raw = JSON.stringify({ ...body, webhookTimestamp: 5000 });
        accepted.length = 0;
        expect(await ingest(raw, { 'linear-signature': createHmac('sha256', 'sec').update(raw).digest('hex') })).toEqual({ status: 200 });
        await ingest.settled();
        return accepted;
      };
      const sendReply = (text: string) => {
        const body = fx('session-prompted');
        body.agentActivity.content.body = text;
        body.agentActivity.id = `act-${n++}`;
        return send(body);
      };
      const sendMention = (text: string) => {
        const body = fx('session-created-mention');
        body.agentSession.comment.body = text;
        return send(body);
      };
      return { asked, logs, send, reply: sendReply, mention: sendMention };
    };

    it.each(['Le tri doit être décroissant', 'Please switch the sort to descending'])('an instruction without a verb of a list, %j, is one when the model says so', async (text) => {
      const m = model('instruction');
      expect((await m.reply(text))[0]).toMatchObject({ payload: { body: text, ack: true, kind: 'instruction' } });
      expect(m.asked).toEqual([text]);
    });

    it('an instruction with a question mark is one when the model says so', async () => {
      const m = model('instruction');
      expect((await m.reply('corrige le tri, ok ?'))[0]).toMatchObject({ payload: { kind: 'instruction' } });
      expect((await m.mention('[@factory](https://linear.app/x/profiles/factory) Could you switch the sort?'))[0]).toMatchObject({ payload: { kind: 'instruction' } });
      // Masked and without its mention, as the event carries it.
      expect(m.asked).toEqual(['corrige le tri, ok ?', 'Could you switch the sort?']);
    });

    it('/stop, /status, /refreeze and a workflow command are commands, the model never asked', async () => {
      const m = model('question');
      expect((await m.reply('/stop'))[0]).toMatchObject({ payload: { kind: 'command' } });
      expect((await m.reply('[@factory](https://linear.app/x/profiles/factory) /status'))[0]).toMatchObject({ payload: { kind: 'command' } });
      expect((await m.reply('/refreeze'))[0]).toMatchObject({ type: 'command' });
      const body = fx('session-created-command');
      body.agentSession.comment.body = '[@factory](https://linear.app/x/profiles/factory) retiens ceci';
      expect((await m.send(body))[0]).toMatchObject({ type: 'command', payload: { kind: 'command' } });
      expect(m.asked).toEqual([]);
    });

    it('a model that fails leaves the fallback rule, the message keeps its ack, and the reason is logged once', async () => {
      const m = model(new Error('timed out after 6000 ms'));
      expect((await m.reply('corrige le tri, ok ?'))[0]).toMatchObject({ payload: { ack: true, kind: 'question' } });
      expect((await m.reply('Le tri doit être décroissant'))[0]).toMatchObject({ payload: { ack: true, kind: 'instruction' } });
      expect(m.logs).toEqual([expect.stringContaining('no verdict (timed out after 6000 ms)')]);
    });

    it.each([
      ['et pour mobile ?', 'question'],
      ['boutons mal alignés', 'instruction'],
      ['corrige le tri', 'instruction'],
      ['/status', 'command'],
      ['/stop', 'command'],
    ])('a reply %j is a %s, to acknowledge', async (text, kind) => {
      expect((await reply(text))[0]).toMatchObject({ type: 'session.prompted', payload: { body: text, ack: true, kind } });
    });

    it('a command opened by a mention is read without it', async () => {
      expect((await reply('[@factory](https://linear.app/x/profiles/factory) /stop'))[0]).toMatchObject({ payload: { body: '/stop', kind: 'command' } });
    });

    it('a mention is classified without the mention', async () => {
      expect((await mention('[@factory](https://linear.app/x/profiles/factory) corrige le tri'))[0]).toMatchObject({ type: 'session.mentioned', payload: { body: 'corrige le tri', kind: 'instruction' } });
      expect((await mention('[@factory](https://linear.app/x/profiles/factory) pourquoi ?'))[0]).toMatchObject({ payload: { kind: 'question' } });
    });

    it('a command is one as well, kept apart', async () => {
      const body = fx('session-created-command');
      body.agentSession.comment.body = '[@factory](https://linear.app/x/profiles/factory) retiens ceci';
      expect((await mapLinearWebhook(body, 'd', ctx()))[0]).toMatchObject({ type: 'command', payload: { kind: 'command' } });
    });

    it('masks a secret before the message reaches the journal, and says it did', async () => {
      const token = `ghp_${'a'.repeat(36)}`;
      const [masked] = await reply(`corrige, voici le jeton ${token}`);
      expect(JSON.stringify(masked)).not.toContain(token);
      expect(masked).toMatchObject({ payload: { body: 'corrige, voici le jeton [masked]', kind: 'instruction', masked: true } });
      const [opened] = await mention(`[@factory](https://linear.app/x/profiles/factory) ${token} ?`);
      expect(JSON.stringify(opened)).not.toContain(token);
      expect(opened).toMatchObject({ payload: { masked: true } });
      expect((await reply('corrige le tri'))[0]!.payload).not.toHaveProperty('masked');
    });

    it('an unsigned message keeps its taint, whatever its class', async () => {
      const body = fx('session-prompted');
      body.agentActivity = { ...body.agentActivity, userId: undefined, user: undefined, content: { body: 'corrige le tri' } };
      expect((await mapLinearWebhook(body, 'd', ctx()))[0]).toMatchObject({ taint: 'untrusted', payload: { kind: 'instruction' } });
    });
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
    const known = (labels: string[] | undefined) => ({ ...ctx(), knownLabels: async () => (labels ? { labels, at: 0 } : undefined) });
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

  describe('a team with several repos (ORC-291)', () => {
    const twoRepos = (labels: string[], o: { read?: string[]; stored?: TicketState[] } = {}): MapContext => ({
      ...ctx(),
      projectsOfTeam: (k) => (k === 'REL' ? ['web', 'api'] : []),
      labelsOf: async (id) => (o.read?.push(id), labels),
      ticket: async (p, id) => o.stored?.find((t) => t.projectId === p && t.ticketId === id),
    });
    const held = { ...newTicketState('web', 'REL-1', 'T', 'dev', 0), delegated: true };

    it('sends a delegation of a ticket no project holds to the repo its repo: label names, read from Linear', async () => {
      const read: string[] = [];
      expect(await mapLinearWebhook(fx('session-created-delegation'), 'd1', twoRepos(['repo:api'], { read }))).toMatchObject([{ type: 'ticket.delegated', projectId: 'api' }]);
      expect(read).toEqual(['REL-1']);
    });

    it('sends everything about a ticket a project holds to that project, whatever its labels, without reading Linear', async () => {
      const read: string[] = [];
      for (const name of ['session-created-delegation', 'session-prompted', 'issue-moved-labeled']) {
        const out = await mapLinearWebhook(fx(name), 'd', twoRepos(['repo:api'], { read, stored: [held] }));
        expect(out.map((e) => e.projectId)).toContain('web');
        expect(out.map((e) => e.projectId)).not.toContain('api');
      }
      expect(read).toEqual([]);
    });

    it('brings the ack and the routing together: the trigger keeps its ack whichever way it is routed', async () => {
      const choose = await mapLinearWebhook(fx('session-created-delegation'), 'd1', twoRepos([]));
      expect(choose).toMatchObject([{ projectId: 'web', payload: { ack: true, repos: ['web', 'api'] } }]);
      const named = await mapLinearWebhook(fx('session-created-mention'), 'd2', twoRepos(['repo:api']));
      expect(named).toMatchObject([{ projectId: 'api', payload: { ack: true } }]);
      const replied = await mapLinearWebhook(fx('session-prompted'), 'd3', twoRepos(['repo:api']));
      expect(replied).toMatchObject([{ projectId: 'api', payload: { ack: true, kind: 'instruction' } }]);
    });

    it('a delegation to the repo its label names says where the ticket waited', async () => {
      const stored = [{ ...newTicketState('web', 'REL-1', 'T', 'todo', 0), delegated: true, blocked: true, blockReason: unroutedReason(['web', 'api']), awaitingRepo: ['web', 'api'] }];
      expect(await mapLinearWebhook(fx('session-created-delegation'), 'd1', twoRepos(['repo:api'], { stored }))).toMatchObject([{ projectId: 'api', payload: { waitedIn: 'web' } }]);
    });

    it('without a label, a new session goes to the first repo with the choice to make', async () => {
      expect(await mapLinearWebhook(fx('session-created-delegation'), 'd1', twoRepos(['bug']))).toMatchObject([
        { type: 'ticket.delegated', projectId: 'web', payload: { linearSessionId: 'as-1', repos: ['web', 'api'] } },
      ]);
      expect(await mapLinearWebhook(fx('session-created-mention'), 'd2', twoRepos([]))).toMatchObject([{ type: 'session.mentioned', projectId: 'web', payload: { repos: ['web', 'api'] } }]);
    });

    it('drops an issue change on a ticket no project knows, without reading Linear: there is nothing to route', async () => {
      const labelsOf = async (): Promise<string[]> => {
        throw new Error('Linear down');
      };
      expect(await mapLinearWebhook(fx('issue-moved-labeled'), 'd6', { ...twoRepos([]), labelsOf })).toEqual([]);
    });

    it('a reply or a stop on a ticket whose delegation is still in the inbox follows it by its label: no project stores it yet, and it must not be lost', async () => {
      expect(await mapLinearWebhook(fx('session-prompted'), 'd4', twoRepos(['repo:api']))).toMatchObject([{ projectId: 'api' }]);
      const stop = { ...fx('session-prompted'), agentActivity: { ...fx('session-prompted').agentActivity, signal: 'stop' } };
      expect(await mapLinearWebhook(stop, 'd5', twoRepos(['repo:api']))).toMatchObject([{ type: 'session.stopped', projectId: 'api' }]);
    });

    it('a reply in a question session goes to the copy of the ticket that opened it, whichever the store lists first', async () => {
      const session = fx('session-prompted').agentSession.id;
      const stored = [newTicketState('web', 'REL-1', 'T', 'todo', 0), { ...newTicketState('api', 'REL-1', 'T', 'todo', 0), questionSessionIds: [session] }];
      expect(await mapLinearWebhook(fx('session-prompted'), 'd4', twoRepos(['repo:web'], { stored }))).toMatchObject([{ projectId: 'api' }]);
    });

    it('a reply in a session on a ticket that still names no repo gets the question again: nothing runs in a repo picked by default', async () => {
      const session = fx('session-prompted').agentSession.id;
      const stored = [{ ...newTicketState('web', 'REL-1', 'T', 'todo', 0), questionSessionIds: [session] }];
      expect(await mapLinearWebhook(fx('session-prompted'), 'd4', twoRepos([], { stored }))).toMatchObject([{ projectId: 'web', payload: { repos: ['web', 'api'] } }]);
    });

    it('a stop in the session of a delegation still in the inbox follows its label, past the copy where the ticket waited', async () => {
      const stored = [{ ...newTicketState('web', 'REL-1', 'T', 'todo', 0), delegated: true, blocked: true, blockReason: unroutedReason(['web', 'api']), awaitingRepo: ['web', 'api'], linearSessionId: 'older' }];
      const stop = { ...fx('session-prompted'), agentActivity: { ...fx('session-prompted').agentActivity, signal: 'stop' } };
      expect(await mapLinearWebhook(stop, 'd5', twoRepos(['repo:api'], { stored }))).toMatchObject([{ type: 'session.stopped', projectId: 'api' }]);
    });

    it('a delegation of an issue deleted meanwhile is written for the journal, not sent back by Linear forever', async () => {
      const labelsOf = async (): Promise<string[]> => {
        throw new IssueNotFoundError('REL-1');
      };
      expect(await mapLinearWebhook(fx('session-created-delegation'), 'd1', { ...twoRepos([]), labelsOf })).toMatchObject([{ type: 'ticket.delegated', projectId: 'web' }]);
      const down = async (): Promise<string[]> => {
        throw new Error('Linear down');
      };
      await expect(mapLinearWebhook(fx('session-created-delegation'), 'd1', { ...twoRepos([]), labelsOf: down })).rejects.toThrow('Linear down');
    });

    it('marks a label added that names another repo of the team, and only then', async () => {
      const naming = (name: string, projects: string[]) => ({ ...twoRepos([], { stored: [held] }), projectsOfTeam: () => projects, labelNameById: (_t: string, id: string) => (id === 'l-resume' ? name : 'bug') });
      const labels = async (c: MapContext) => (await mapLinearWebhook(fx('issue-moved-labeled'), 'd', c)).filter((e) => e.type === 'label.changed').map((e) => e.payload);
      expect(await labels(naming('repo:api', ['web', 'api']))).toEqual([{ label: 'repo:api', change: 'added', otherRepo: true }]);
      expect(await labels(naming('repo:other', ['web', 'api']))).toEqual([{ label: 'repo:other', change: 'added' }]);
    });
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

  describe('the small model after the answer, outside the serial turn (ORC-336)', () => {
    const reply = (id: string, text: string, issue = { id: 'u1', identifier: 'REL-1' }) => {
      const body = fx('session-prompted');
      body.agentActivity = { ...body.agentActivity, id, content: { type: 'prompt', body: text } };
      body.agentSession.issue = { ...body.agentSession.issue, ...issue };
      return signed({ ...body, webhookTimestamp: 5000 });
    };
    const moved = (id: string, identifier: string) =>
      signed({ ...fx('issue-moved-labeled'), data: { ...fx('issue-moved-labeled').data, id, identifier, updatedAt: `2026-10-15T10:00:0${id.length}.000Z` }, webhookTimestamp: 5000 });
    const slow = (ms: number, asked: string[] = []) => async (b: string) => {
      asked.push(b);
      await new Promise((r) => setTimeout(r, ms));
      return 'instruction' as const;
    };
    const fast = { baseMs: 5, maxMs: 20, horizonMs: 200 };
    const setup = (
      classify: (b: string) => Promise<'instruction' | 'question'>,
      o: { store?: SqliteStore; accept?: (e: FactoryEvent) => Promise<unknown>; c?: MapContext; retry?: RetryPolicy } = {},
    ) => {
      const accepted: string[] = [];
      const logs: string[] = [];
      const store = o.store ?? new SqliteStore(':memory:');
      const ingest = createLinearIngest({
        secret: () => 'sec',
        ctx: o.c ?? ctx(),
        accept: o.accept ?? (async (e) => void accepted.push(`${e.ticketId} ${e.type}`)),
        log: (m) => void logs.push(m),
        classify,
        deliveries: store,
        retry: o.retry ?? fast,
      });
      const send = ({ raw, sig }: { raw: string; sig: string }) => ingest(raw, { 'linear-signature': sig });
      return { accepted, logs, send, ingest, store };
    };

    it('answers a message at once, before the model: the answer never waits on it', async () => {
      const { accepted, send, ingest, store } = setup(slow(400));
      const t = Date.now();
      expect(await send(reply('a1', 'premier'))).toEqual({ status: 200 });
      expect(Date.now() - t).toBeLessThan(200);
      expect(accepted).toEqual([]);
      expect(await store.pendingDeliveries()).toHaveLength(1);
      await ingest.settled();
      expect(accepted).toEqual(['REL-1 session.prompted']);
      expect(await store.pendingDeliveries()).toEqual([]);
    });

    it('two slow classifications run side by side, and keep their order', async () => {
      const { accepted, send, ingest } = setup(slow(300));
      const t = Date.now();
      await Promise.all([send(reply('a1', 'premier')), send(reply('a2', 'second'))]);
      await ingest.settled();
      expect(Date.now() - t).toBeLessThan(550);
      expect(accepted).toEqual(['REL-1 session.prompted', 'REL-1 session.prompted']);
    });

    it('a webhook of another issue behind them is not delayed; one of the same issue keeps its place, by its stable id', async () => {
      const { accepted, send, ingest } = setup(slow(400), { c: { ...ctx(), projectsOfTeam: (k) => (['REL', 'OPS'].includes(k) ? ['p'] : []) } });
      await send(reply('a1', 'premier'));
      // The same issue, moved to another team meanwhile: its identifier changed, its id did not.
      await send(reply('a2', 'second', { id: 'u1', identifier: 'OPS-7' }));
      const t = Date.now();
      expect(await send(moved('u2', 'REL-2'))).toEqual({ status: 200 });
      expect(Date.now() - t).toBeLessThan(200);
      expect(accepted).toEqual(['REL-2 status.changed', 'REL-2 label.changed']);
      // Behind the issue's messages: kept, answered, then written after them.
      expect(await send(moved('u1', 'REL-1'))).toEqual({ status: 200 });
      await ingest.settled();
      expect(accepted.slice(2)).toEqual(['REL-1 session.prompted', 'OPS-7 session.prompted', 'REL-1 status.changed', 'REL-1 label.changed']);
    });

    it('a redelivered webhook asks no model again, while it is kept or once it is in the inbox', async () => {
      const asked: string[] = [];
      const store = new SqliteStore(':memory:');
      const { send, ingest } = setup(slow(100, asked), { store, accept: (e) => store.appendInbox(e) });
      const once = reply('a1', 'nouveau');
      await Promise.all([send(once), send(once)]);
      await ingest.settled();
      await send(once);
      await ingest.settled();
      expect(asked).toEqual(['nouveau']);
    });

    it('runs at most 4 classifications at once: the next message gets the fallback rule at once', async () => {
      const asked: string[] = [];
      const kinds: unknown[] = [];
      const { send, ingest, logs } = setup(slow(300, asked), { accept: async (e) => void kinds.push((e.payload as { kind?: string }).kind) });
      await Promise.all([1, 2, 3, 4, 5].map((k) => send(reply(`a${k}`, `message ${k} ?`, { id: `u${k}`, identifier: `REL-${k}` }))));
      await ingest.settled();
      expect(asked).toHaveLength(4);
      expect(kinds.sort()).toEqual(['instruction', 'instruction', 'instruction', 'instruction', 'question']);
      expect(logs).toEqual([expect.stringContaining('4 classifications already running')]);
    });

    it('asks no model for a command, a routed project\'s own command, or a webhook no project takes', async () => {
      const asked: string[] = [];
      const { send, ingest, accepted } = setup(slow(10, asked));
      await send(reply('a1', '/status'));
      const command = fx('session-created-command');
      command.agentSession.comment.body = '[@factory](https://linear.app/x/profiles/factory) retiens ceci';
      await send(signed({ ...command, webhookTimestamp: 5000 }));
      await send(reply('a3', 'pour une équipe sans projet', { id: 'z1', identifier: 'ZZZ-1' }));
      await ingest.settled();
      expect(asked).toEqual([]);
      expect(accepted).toEqual(['REL-1 session.prompted', 'REL-1 command']);
    });

    it('a stop between the answer and the inbox loses nothing: the next start writes what was kept', async () => {
      const store = new SqliteStore(':memory:');
      const first = setup(async () => new Promise<never>(() => {}), { store });
      // Answered and kept; the daemon stops before the model answers.
      expect(await first.send(reply('a1', 'corrige le tri'))).toEqual({ status: 200 });
      expect(await store.pendingDeliveries()).toHaveLength(1);
      const events: FactoryEvent[] = [];
      const next = setup(async () => 'question', { store, accept: async (e) => void events.push(e), c: { ...ctx(), now: () => 999_999 } });
      expect(await next.ingest.resume()).toBe(1);
      await next.ingest.settled();
      // Classified at its new start, timed at its first arrival, and no longer kept.
      expect(events).toMatchObject([{ id: 'linear:activity:a1', at: 5000, payload: { body: 'corrige le tri', kind: 'question' } }]);
      expect(await store.pendingDeliveries()).toEqual([]);
    });

    it('a write that fails is tried again with backoff, the delivery kept until it is written', async () => {
      let fails = 3;
      const events: string[] = [];
      const { send, ingest, store, logs } = setup(async () => 'instruction', {
        accept: async (e) => {
          if (fails-- > 0) throw new Error('disk');
          events.push(e.id);
        },
      });
      await send(reply('a1', 'corrige'));
      await ingest.settled();
      expect(events).toEqual(['linear:activity:a1']);
      expect(logs).toEqual([1, 2, 3].map((k) => expect.stringContaining(`inbox write failed (try ${k})`)));
      expect(await store.pendingDeliveries()).toEqual([]);
    });

    it('a blip of the store on the inbox lookup or the kept row removal strands nothing', async () => {
      const inner = new SqliteStore(':memory:');
      let blips = 2;
      const blip = <T>(f: () => Promise<T>) => () => (blips-- > 0 ? Promise.reject(new Error('connection reset')) : f());
      const store = Object.assign(Object.create(inner) as SqliteStore, {
        inboxHas: (id: string) => blip(() => inner.inboxHas(id))(),
        deleteDelivery: (key: string) => blip(() => inner.deleteDelivery(key))(),
      });
      const { send, ingest, accepted, logs } = setup(async () => 'instruction', { store });
      await send(reply('a1', 'corrige'));
      await ingest.settled();
      expect(accepted).toEqual(['REL-1 session.prompted']);
      expect(logs.some((l) => l.includes('inbox lookup failed'))).toBe(true);
      expect(await inner.pendingDeliveries()).toEqual([]);
    });

    it('past the horizon a delivery is set aside, loudly, and a redelivery of it is written', async () => {
      let down = true;
      const events: string[] = [];
      const { send, ingest, store, logs } = setup(async () => 'instruction', {
        accept: async (e) => {
          if (down) throw new Error('disk');
          events.push(e.id);
        },
      });
      const once = reply('a1', 'corrige');
      await send(once);
      await ingest.settled();
      expect(events).toEqual([]);
      expect(logs.at(-1)).toMatch(/^ERROR: webhook activity:a1 set aside/);
      expect(await store.pendingDeliveries()).toEqual([]);
      expect(await store.getMeta('delivery-aside:activity:a1')).toContain('corrige');
      // Linear sends it again: no longer kept, so taken afresh.
      down = false;
      await send(once);
      await ingest.settled();
      expect(events).toEqual(['linear:activity:a1']);
    });

    it('a redelivery of a row still kept but not being delivered delivers it again, timed at its first arrival', async () => {
      const store = new SqliteStore(':memory:');
      const { raw } = reply('a1', 'corrige');
      await store.receiveDelivery('activity:a1', JSON.stringify({ raw, at: 4000 }));
      const events: FactoryEvent[] = [];
      const { send, ingest } = setup(async () => 'question', { store, accept: async (e) => void events.push(e) });
      expect(await send(reply('a1', 'corrige'))).toEqual({ status: 200 });
      await ingest.settled();
      expect(events).toMatchObject([{ id: 'linear:activity:a1', at: 4000, payload: { kind: 'question' } }]);
    });

    it('resume sets an unreadable row aside and goes on with the others', async () => {
      const store = new SqliteStore(':memory:');
      await store.receiveDelivery('bad', '{not json');
      await store.receiveDelivery('activity:a1', JSON.stringify({ raw: reply('a1', 'corrige').raw, at: 5000 }));
      const { ingest, accepted, logs } = setup(async () => 'instruction', { store });
      expect(await ingest.resume()).toBe(2);
      await ingest.settled();
      expect(accepted).toEqual(['REL-1 session.prompted']);
      expect(logs).toEqual([expect.stringMatching(/^ERROR: webhook bad set aside.*unreadable/)]);
      expect(await store.pendingDeliveries()).toEqual([]);
      expect(await store.getMeta('delivery-aside:bad')).toBe('{not json');
    });

    it('resumed deliveries wait for a slot instead of taking the fallback rule', async () => {
      const store = new SqliteStore(':memory:');
      for (const k of [1, 2, 3, 4, 5, 6]) {
        await store.receiveDelivery(`activity:a${k}`, JSON.stringify({ raw: reply(`a${k}`, `message ${k} ?`, { id: `u${k}`, identifier: `REL-${k}` }).raw, at: 5000 }));
      }
      const asked: string[] = [];
      const kinds: unknown[] = [];
      const { ingest } = setup(slow(50, asked), { store, accept: async (e) => void kinds.push((e.payload as { kind?: string }).kind) });
      await ingest.resume();
      await ingest.settled();
      expect(asked).toHaveLength(6);
      expect(kinds).toEqual(Array(6).fill('instruction'));
    });

    it('once closed, a webhook gets 503 and the retries stop short, what is not written left kept', async () => {
      const { send, ingest, store } = setup(async () => 'instruction', {
        accept: async () => Promise.reject(new Error('disk')),
        retry: { baseMs: 10_000, maxMs: 10_000, horizonMs: 3_600_000 },
      });
      await send(reply('a1', 'corrige'));
      await new Promise((r) => setTimeout(r, 50));
      ingest.close();
      const t = Date.now();
      await ingest.settled();
      expect(Date.now() - t).toBeLessThan(1_000);
      expect(await store.pendingDeliveries()).toHaveLength(1);
      expect(await send(reply('a2', 'trop tard'))).toEqual({ status: 503 });
    });

    it("takes the event's time at the webhook's arrival, before the model's wait", async () => {
      let now = 5000;
      const events: FactoryEvent[] = [];
      const { send, ingest } = setup(async () => ((now = 9000), 'question'), { accept: async (e) => void events.push(e), c: { ...ctx(), now: () => now } });
      await send(reply('a1', 'pourquoi'));
      await ingest.settled();
      expect(events[0]).toMatchObject({ at: 5000, payload: { kind: 'question' } });
    });

    it('without a model, a message is written before its answer, as before', async () => {
      const accepted: string[] = [];
      const ingest = createLinearIngest({ secret: () => 'sec', ctx: ctx(), accept: async (e) => void accepted.push(e.type), log: () => {} });
      const { raw, sig } = reply('a1', 'corrige');
      expect(await ingest(raw, { 'linear-signature': sig })).toEqual({ status: 200 });
      expect(accepted).toEqual(['session.prompted']);
    });
  });

  it('writes a delegation to the inbox, then answers 200; it writes nothing to Linear, the ack is an effect of its decision (ORC-147, ORC-171)', async () => {
    const { store, ids } = inbox();
    const ingest = createLinearIngest({ secret: () => 'sec', ctx: { ...ctx(), now: () => 2000 }, accept: (e) => store.appendInbox(e), log: () => {} });
    const { raw, sig } = signed(fx('session-created-delegation'));
    expect(await ingest(raw, { 'linear-signature': sig })).toEqual({ status: 200 });
    expect(await ids()).toHaveLength(1);
  });

  it('records the labels an issue webhook reads, echoes included, once its events are in the inbox (ORC-185)', async () => {
    const recorded: unknown[][] = [];
    const body = { ...fx('issue-moved-labeled'), webhookTimestamp: 2000 };
    // `lost` was added by a webhook that never came: this one only adds agent:reprendre, so `lost` stays unknown.
    const c = { ...ctx(['label:REL-1:agent:reprendre']), now: () => 2000, knownLabels: async () => ({ labels: ['bug'], at: 0 }), recordLabels: async (...a: unknown[]) => void recorded.push(a) };
    const { raw, sig } = signed(body);
    const ok = createLinearIngest({ secret: () => 'sec', ctx: c, accept: async () => true, log: () => {} });
    expect(await ok(raw, { 'linear-signature': sig })).toEqual({ status: 200 });
    expect(recorded).toEqual([['p', 'REL-1', ['bug', 'agent:reprendre'], Date.parse(body.data.updatedAt)]]);
    recorded.length = 0;
    // A lost label in the full list is not recorded: the reconciliation still reports it.
    const withLost = { ...body, data: { ...body.data, labelIds: ['l-bug', 'l-resume', 'l-lost'] }, updatedFrom: { labelIds: ['l-bug', 'l-lost'] }, webhookTimestamp: 2000 };
    const s2 = signed(withLost);
    const lost = createLinearIngest({ secret: () => 'sec', ctx: { ...c, labelNameById: (_t: string, id: string) => ({ 'l-bug': 'bug', 'l-resume': 'agent:reprendre', 'l-lost': 'lost' })[id] }, accept: async () => true, log: () => {} });
    expect(await lost(s2.raw, { 'linear-signature': s2.sig })).toEqual({ status: 200 });
    expect(recorded).toEqual([['p', 'REL-1', ['bug', 'agent:reprendre'], Date.parse(body.data.updatedAt)]]);
    recorded.length = 0;
    const failing = createLinearIngest({ secret: () => 'sec', ctx: c, accept: async () => Promise.reject(new Error('disk')), log: () => {} });
    expect(await failing(raw, { 'linear-signature': sig })).toEqual({ status: 500 });
    // Not in the inbox: Linear sends it again, and it must not be taken for a change already known then.
    expect(recorded).toEqual([]);
  });

  it('a reconciliation pass that runs while a webhook writes its label change waits for it: the change is reported once (ORC-185)', async () => {
    const { store, accept, ids } = inbox();
    const body = { ...fx('issue-moved-labeled'), webhookTimestamp: 2000 };
    const updatedAt = Date.parse(body.data.updatedAt);
    await store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'ai_review', 1), delegated: true });
    await recordLabels(store, 'p', 'REL-1', ['bug'], updatedAt - 1000);
    const tracker = new FakeTracker();
    tracker.addIssue({ identifier: 'REL-1', delegateId: 'app', stateName: 'AI Review', labels: ['bug', 'agent:reprendre'], updatedAt });
    const labelsTurn = serial();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const c = {
      ...ctx(),
      now: () => 2000,
      knownLabels: (pid: string, id: string) => knownLabels(store, pid, id),
      recordLabels: (pid: string, id: string, labels: string[], at: number) => recordLabels(store, pid, id, labels, at),
    };
    const ingest = createLinearIngest({ secret: () => 'sec', ctx: c, serial: labelsTurn, accept: async (e) => (await gate, accept(e)), log: () => {} });
    const { raw, sig } = signed(body);
    const webhook = ingest(raw, { 'linear-signature': sig });
    await new Promise((r) => setTimeout(r, 10));
    const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../../../packs/standard') });
    const reconciled = reconcileOnce({
      tracker, store, projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }], serial: labelsTurn,
      submit: (e) => store.appendInbox(e), clock: new FakeClock(2000), log: () => {},
    });
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await webhook).toEqual({ status: 200 });
    await reconciled;
    expect((await ids()).filter((id) => id.includes('label'))).toHaveLength(1);
  });

  it('in a team with several repos, a label webhook and a pass under way report one change, once, for the repo holding the ticket (ORC-291)', async () => {
    const { store, accept, ids } = inbox();
    const body = { ...fx('issue-moved-labeled'), webhookTimestamp: 2000 };
    const updatedAt = Date.parse(body.data.updatedAt);
    await store.putTicket({ ...newTicketState('web', 'REL-1', 'T', 'todo', 1) });
    await store.putTicket({ ...newTicketState('api', 'REL-1', 'T', 'ai_review', 1), delegated: true });
    await recordLabels(store, 'web', 'REL-1', ['old'], 1);
    await recordLabels(store, 'api', 'REL-1', ['bug'], updatedAt - 1000);
    const tracker = new FakeTracker();
    tracker.addIssue({ identifier: 'REL-1', delegateId: 'app', stateName: 'AI Review', labels: ['bug', 'agent:reprendre'], updatedAt });
    const labelsTurn = serial();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const c: MapContext = {
      ...ctx(),
      projectsOfTeam: (k) => (k === 'REL' ? ['web', 'api'] : []),
      ticket: (p, id) => store.getTicket(p, id),
      now: () => 2000,
      knownLabels: (pid, id) => knownLabels(store, pid, id),
      recordLabels: (pid, id, labels, at) => recordLabels(store, pid, id, labels, at),
    };
    const seen: FactoryEvent[] = [];
    const write = (e: FactoryEvent) => (seen.push(e), accept(e));
    const ingest = createLinearIngest({ secret: () => 'sec', ctx: c, serial: labelsTurn, accept: async (e) => (await gate, write(e)), log: () => {} });
    const { raw, sig } = signed(body);
    const webhook = ingest(raw, { 'linear-signature': sig });
    await new Promise((r) => setTimeout(r, 10));
    const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../../../packs/standard') });
    const projects = ['web', 'api'].map((id) => ({ id, repoPath: `/${id}`, teamKey: 'REL', workflow }));
    const reconciled = reconcileOnce({ tracker, store, projects, serial: labelsTurn, submit: write, clock: new FakeClock(2000), log: () => {} });
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await webhook).toEqual({ status: 200 });
    await reconciled;
    expect((await ids()).filter((id) => id.includes('label'))).toHaveLength(1);
    expect(seen.filter((e) => e.type === 'label.changed').map((e) => e.projectId)).toEqual(['api']);
    expect((await knownLabels(store, 'api', 'REL-1'))?.labels).toEqual(['agent:reprendre', 'bug']);
    expect(await knownLabels(store, 'web', 'REL-1')).toEqual({ labels: ['old'], at: 1 });
  });

  it('a label webhook come after a newer one still adds its change to the known labels: the reconciliation does not report it again (ORC-185)', async () => {
    const { store, ids } = inbox();
    const base = fx('issue-moved-labeled');
    await store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'ai_review', 1), delegated: true });
    await recordLabels(store, 'p', 'REL-1', [], 5);
    const c = {
      ...ctx(),
      now: () => 2000,
      knownLabels: (pid: string, id: string) => knownLabels(store, pid, id),
      recordLabels: (pid: string, id: string, labels: string[], at: number) => recordLabels(store, pid, id, labels, at),
    };
    const ingest = createLinearIngest({ secret: () => 'sec', ctx: c, accept: (e) => store.appendInbox(e), log: () => {} });
    // W1 (bug added at 10) arrives after W2 (agent:reprendre added at 20).
    const w = (updatedAt: number, labelIds: string[], from: string[]) =>
      signed({ ...base, webhookTimestamp: 2000, data: { ...base.data, updatedAt: new Date(updatedAt).toISOString(), labelIds }, updatedFrom: { labelIds: from } });
    for (const { raw, sig } of [w(20, ['l-bug', 'l-resume'], ['l-bug']), w(10, ['l-bug'], [])]) expect(await ingest(raw, { 'linear-signature': sig })).toEqual({ status: 200 });
    expect(await knownLabels(store, 'p', 'REL-1')).toEqual({ labels: ['agent:reprendre', 'bug'], at: 20 });
    const tracker = new FakeTracker();
    tracker.addIssue({ identifier: 'REL-1', delegateId: 'app', stateName: 'AI Review', labels: ['bug', 'agent:reprendre'], updatedAt: 20 });
    const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../../../packs/standard') });
    await reconcileOnce({ tracker, store, projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }], submit: (e) => store.appendInbox(e), clock: new FakeClock(2000), log: () => {} });
    expect((await ids()).filter((id) => id.startsWith('reconcile:label'))).toEqual([]);
  });

  it('the labels a pass records on a delegation found again wait for a webhook recording under way: a newer reading is not overwritten (ORC-185)', async () => {
    const { store } = inbox();
    const base = fx('issue-moved-labeled');
    await store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'ai_review', 1), delegated: false });
    await recordLabels(store, 'p', 'REL-1', ['bug'], 10);
    const labelsTurn = serial();
    const c = {
      ...ctx(),
      now: () => 2000,
      knownLabels: (pid: string, id: string) => knownLabels(store, pid, id),
      recordLabels: (pid: string, id: string, labels: string[], at: number) => recordLabels(store, pid, id, labels, at),
    };
    const ingest = createLinearIngest({ secret: () => 'sec', ctx: c, serial: labelsTurn, accept: (e) => store.appendInbox(e), log: () => {} });
    const { raw, sig } = signed({ ...base, webhookTimestamp: 2000, data: { ...base.data, updatedAt: new Date(30).toISOString(), labelIds: ['l-bug', 'l-resume'] }, updatedFrom: { labelIds: ['l-bug'] } });
    // The pass reads the kept labels, then the webhook comes before it writes its own reading.
    let webhook: Promise<unknown> | undefined;
    const passStore = Object.create(store) as SqliteStore;
    passStore.getMeta = async (k: string) => {
      const v = await store.getMeta(k);
      if (k.startsWith('linear-labels:') && !webhook) {
        webhook = ingest(raw, { 'linear-signature': sig });
        await new Promise((r) => setTimeout(r, 20));
      }
      return v;
    };
    const tracker = new FakeTracker();
    tracker.addIssue({ identifier: 'REL-1', delegateId: 'app', stateName: 'AI Review', labels: ['bug'], updatedAt: 20 });
    const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../../../packs/standard') });
    await reconcileOnce({ tracker, store: passStore, projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }], serial: labelsTurn, submit: (e) => store.appendInbox(e), clock: new FakeClock(2000), log: () => {} });
    await webhook;
    expect(await knownLabels(store, 'p', 'REL-1')).toEqual({ labels: ['agent:reprendre', 'bug'], at: 30 });
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

  it('answers 500 when the inbox write fails, and takes the webhook Linear sends again', async () => {
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
      log: (m) => logs.push(m),
    });
    const { raw, sig } = signed(fx('session-created-delegation'));
    expect(await ingest(raw, { 'linear-signature': sig })).toEqual({ status: 500 });
    expect(logs.join('\n')).toContain('database down');
    down = false;
    expect(await ingest(raw, { 'linear-signature': sig })).toEqual({ status: 200 });
    expect(await ids()).toHaveLength(1);
  });

  function make(store?: SqliteStore) {
    const box = inbox(store);
    const ingest = createLinearIngest({
      secret: () => 'sec',
      ctx: { ...ctx(), now: () => 1000 },
      accept: box.accept,
      log: () => {},
    });
    const send = async (body: unknown, headers: Record<string, string> = {}) => {
      const { raw, sig } = signed(body);
      expect(await ingest(raw, { ...headers, 'linear-signature': sig })).toEqual({ status: 200 });
    };
    return { ids: box.ids, send, store: box.store };
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

  it('does not write again a webhook replayed within the freshness window', async () => {
    const { ids, send } = make();
    await send(fx('session-created-delegation'), { 'linear-delivery': 'd1' });
    await send(fx('session-created-delegation'), { 'linear-delivery': 'forged' });
    await send({ ...fx('session-created-delegation'), webhookTimestamp: 1500 });
    expect(await ids()).toHaveLength(1);
  });

  it('drops a replay after a restart: the dedup is the inbox key, not process memory', async () => {
    const before = make();
    await before.send(fx('session-created-delegation'));
    await before.store.markInboxProcessed((await before.ids())[0]!);
    // A new ingest (a restarted daemon) over the same store.
    const after = make(before.store);
    await after.send({ ...fx('session-created-delegation'), webhookTimestamp: 1500 });
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
    const ingest = createLinearIngest({ secret: () => 'sec', ctx: { ...ctx(), now: () => 999_999 }, accept, log: () => {} });
    const { raw, sig } = signed(fx('session-prompted'));
    expect(await ingest(raw, { 'linear-signature': 'bad' })).toEqual({ status: 401 });
    expect(await ingest(raw, { 'linear-signature': sig })).toEqual({ status: 401 });
    expect(accept).not.toHaveBeenCalled();
  });

  it('rejects a fresh webhook forged with an empty secret', async () => {
    const accept = vi.fn(async () => true);
    const ingest = createLinearIngest({ secret: () => '', ctx: { ...ctx(), now: () => 2000 }, accept, log: () => {} });
    const raw = JSON.stringify(fx('session-prompted'));
    const forged = createHmac('sha256', '').update(raw).digest('hex');
    expect(await ingest(raw, { 'linear-signature': forged })).toEqual({ status: 401 });
    expect(accept).not.toHaveBeenCalled();
  });
});

describe('a comment on the ticket as the reply to a block (ORC-196)', () => {
  const comment = (data: object = {}, patch: object = {}) => ({
    type: 'Comment', action: 'create', webhookTimestamp: 1000, actor: { id: 'user-lilian', type: 'user', name: 'Lilian' },
    data: { id: 'c1', body: 'Prends le point-virgule', issue: { id: 'u1', identifier: 'REL-1' }, ...data }, ...patch,
  });
  const blocked = (over: Partial<TicketState> = {}): MapContext => ({ ...ctx(), ticket: async () => ({ ...newTicketState('p', 'REL-1', 'T', 'dev', 0), delegated: true, blocked: true, ...over }) });

  it('a signed comment on a blocked ticket is a reply: journaled with its actor, its roles still to resolve', async () => {
    expect(await mapLinearWebhook(comment(), 'c1', blocked())).toEqual([
      { id: 'linear:c1', type: 'ticket.commented', at: 5000, schemaVersion: 3, taint: 'trusted', actor: 'user-lilian', projectId: 'p', ticketId: 'REL-1', payload: { body: 'Prends le point-virgule', author: 'Lilian', kind: 'instruction' } },
    ]);
  });

  it.each<[string, string, string]>([
    ['a direction', 'Corrige le tri', 'instruction'],
    ['a question', 'Lequel ?', 'question'],
    ['a command, not a reply that relaunches', '/stop', 'command'],
  ])('classifies a comment as a session\'s message: %s', async (_what, body, kind) => {
    expect((await mapLinearWebhook(comment({ body }), 'c1', blocked()))[0]!.payload).toEqual({ body, author: 'Lilian', kind });
  });

  it('masks a secret before the journal, and says so for the author to hear', async () => {
    const body = 'Le jeton ghp_0123456789abcdefghijABCDEFGHIJ012345 marche';
    const [e] = await mapLinearWebhook(comment({ body }), 'c1', blocked());
    expect(JSON.stringify(e)).not.toContain('ghp_0123456789');
    expect(e!.payload).toMatchObject({ masked: true });
  });

  it('a thread under the block\'s comment is a reply too', async () => {
    expect(await mapLinearWebhook(comment({ parentId: 'c0' }), 'c1', blocked())).toHaveLength(1);
  });

  it('a reply in an agent session is the session\'s: its comment is not journaled a second time', async () => {
    expect(await mapLinearWebhook(comment({ agentSessionId: 'as-1' }), 'c1', blocked())).toEqual([]);
    expect(await mapLinearWebhook(comment({ agentSession: { id: 'as-1' } }), 'c1', blocked())).toEqual([]);
  });

  it('a session reply and the comment Linear writes for it share one delivery key: the inbox keeps the first', () => {
    const prompted = { ...fx('session-prompted'), agentActivity: { ...fx('session-prompted').agentActivity, sourceCommentId: 'c1' } };
    expect(deliveryKey(prompted)).toBe(deliveryKey(comment()));
    expect(deliveryKey(fx('session-prompted'))).toBe('activity:aa-1');
  });

  it.each<[string, object, object]>([
    ['the factory\'s own comment, signed by its app', {}, { actor: { id: 'app', type: 'oauthClient', name: 'factory' } }],
    ['the factory\'s own comment, whichever actor is named', { body: 'Bloqué\n\n<!-- factory:effect=p:1:0 -->' }, {}],
    ['a comment synced from Slack', { botActor: { name: 'Slack' } }, {}],
    ['an external user\'s', { externalUserId: 'e1' }, {}],
    ['a mention: it opens its own session', { body: '@factory reprends' }, {}],
    ['a word to someone else', { body: '@alice tu regardes ?' }, {}],
    ['/refreeze: no instruction for the agent', { body: '/refreeze' }, {}],
    ['an edit', {}, { action: 'update' }],
    ['an empty body', { body: '  ' }, {}],
  ])('drops %s', async (_what, data, patch) => {
    expect(await mapLinearWebhook(comment(data, patch), 'c1', blocked())).toEqual([]);
  });

  it('a comment on a ticket that waits for no reply, or that no project tracks, is not journaled', async () => {
    expect(await mapLinearWebhook(comment(), 'c1', blocked({ blocked: false }))).toEqual([]);
    expect(await mapLinearWebhook(comment(), 'c1', ctx())).toEqual([]);
  });

  it('a mention further in the text stays a reply', async () => {
    expect(await mapLinearWebhook(comment({ body: 'Oui, voir @alice' }), 'c1', blocked())).toHaveLength(1);
  });

  it('a team no project takes: nothing', async () => {
    expect(await mapLinearWebhook(comment({ issue: { id: 'u1', identifier: 'ZZZ-1' } }), 'c1', blocked())).toEqual([]);
  });
});
