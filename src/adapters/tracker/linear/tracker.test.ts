import { describe, expect, it } from 'vitest';
import { LinearApi, type FetchLike } from './api.js';
import { IssueNotFoundError } from '../types.js';
import { effectUuid, LinearTracker } from './tracker.js';

type Handler = (vars: Record<string, any>) => unknown;

function fakeLinear(handlers: Record<string, Handler>) {
  const calls: { op: string; vars: Record<string, any> }[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, any> };
    const op = /^(?:query|mutation)\s+(\w+)/.exec(query.trim())![1]!;
    calls.push({ op, vars: variables });
    const h = handlers[op];
    if (!h) return { ok: true, status: 200, json: async () => ({ errors: [{ message: `no handler for ${op}` }] }) };
    return { ok: true, status: 200, json: async () => ({ data: h(variables) }) };
  };
  return { api: new LinearApi(async () => 'tok', fetchImpl), calls };
}

const node = {
  id: 'uuid-1', identifier: 'REL-1', title: 'Export', description: 'Desc', url: 'https://linear.app/x/REL-1', priority: 2,
  createdAt: '2026-10-10T08:00:00.000Z', state: { id: 's-todo', name: 'Todo', type: 'unstarted' },
  labels: { nodes: [{ id: 'l1', name: 'bug' }] }, delegate: { id: 'app-1' }, team: { id: 't-1', key: 'REL' },
};
const states = { workflowStates: { nodes: [
  { id: 's-todo', name: 'Todo', type: 'unstarted', position: 0 },
  { id: 's-dev', name: 'In Progress', type: 'started', position: 1 },
] } };

describe('LinearTracker', () => {
  it('maps an issue', async () => {
    const { api } = fakeLinear({ Issue: () => ({ issue: node }) });
    expect(await new LinearTracker(api, 'app-1').getIssue('REL-1')).toEqual({
      identifier: 'REL-1', title: 'Export', description: 'Desc', url: 'https://linear.app/x/REL-1', stateName: 'Todo', stateType: 'unstarted',
      labels: ['bug'], delegateId: 'app-1', teamKey: 'REL', priority: 2, createdAt: Date.parse('2026-10-10T08:00:00.000Z'),
    });
  });

  it('tells an issue Linear does not have from a read error', async () => {
    const answering = (errors: unknown[]): LinearApi =>
      new LinearApi(async () => 'tok', async () => ({ ok: true, status: 200, json: async () => ({ data: null, errors }) }));
    // What Linear answers for an unknown or deleted issue: an error, not `issue: null`.
    const notFound = { message: 'Entity not found: Issue', extensions: { type: 'invalid input', userPresentableMessage: 'Could not find referenced Issue.' } };
    await expect(new LinearTracker(answering([notFound]), 'app-1').getIssue('REL-9')).rejects.toBeInstanceOf(IssueNotFoundError);
    const { api } = fakeLinear({ Issue: () => ({ issue: null }) });
    await expect(new LinearTracker(api, 'app-1').getIssue('REL-9')).rejects.toBeInstanceOf(IssueNotFoundError);
    const other = new LinearTracker(answering([{ message: 'Rate limit exceeded' }]), 'app-1').getIssue('REL-9');
    await expect(other).rejects.toThrow('Rate limit exceeded');
    await expect(other).rejects.not.toBeInstanceOf(IssueNotFoundError);
    // An error about another entity than the issue is a read error too.
    const team = new LinearTracker(answering([{ message: 'Entity not found: Team' }]), 'app-1').getIssue('REL-9');
    await expect(team).rejects.not.toBeInstanceOf(IssueNotFoundError);
  });

  it('lists no issue in the trash among the delegated ones', async () => {
    const { api } = fakeLinear({ Delegated: () => ({ issues: { nodes: [node, { ...node, id: 'uuid-2', identifier: 'REL-2', trashed: true }] } }) });
    expect((await new LinearTracker(api, 'app-1').listDelegated('REL')).map((i) => i.identifier)).toEqual(['REL-1']);
  });

  it('takes an issue in the trash (deleted, kept 30 days by Linear) for one it does not have', async () => {
    const { api } = fakeLinear({ Issue: () => ({ issue: { ...node, trashed: true } }) });
    await expect(new LinearTracker(api, 'app-1').getIssue('REL-1')).rejects.toBeInstanceOf(IssueNotFoundError);
  });

  it('reads the active members of a team, every page (ORC-186)', async () => {
    const page = (ids: [string, boolean][], next: string | null) => ({
      teams: { nodes: [{ members: { nodes: ids.map(([id, active]) => ({ id, active })), pageInfo: { hasNextPage: next !== null, endCursor: next } } }] },
    });
    const { api, calls } = fakeLinear({
      TeamMembers: (v) => (v['after'] === null ? page([['u-1', true], ['u-gone', false]], 'c1') : page([['u-2', true]], null)),
    });
    expect(await new LinearTracker(api, 'app-1').teamMembers('REL')).toEqual(['u-1', 'u-2']);
    expect(calls.map((c) => c.vars)).toEqual([{ key: 'REL', after: null }, { key: 'REL', after: 'c1' }]);
  });

  it('fails on an unknown team rather than give it no member', async () => {
    const { api } = fakeLinear({ TeamMembers: () => ({ teams: { nodes: [] } }) });
    await expect(new LinearTracker(api, 'app-1').teamMembers('NOPE')).rejects.toThrow('Équipe Linear introuvable : NOPE');
  });

  it('moves by state name', async () => {
    const { api, calls } = fakeLinear({ Issue: () => ({ issue: node }), TeamStates: () => states, IssueUpdate: () => ({ issueUpdate: { success: true } }) });
    await new LinearTracker(api, 'app-1').moveTo('REL-1', 'In Progress');
    expect(calls.at(-1)).toEqual({ op: 'IssueUpdate', vars: { id: 'uuid-1', input: { stateId: 's-dev' } } });
  });

  it('fails clearly on an unknown state', async () => {
    const { api } = fakeLinear({ Issue: () => ({ issue: node }), TeamStates: () => states });
    await expect(new LinearTracker(api, 'app-1').moveTo('REL-1', 'Nope')).rejects.toThrow('Statut Linear introuvable : "Nope" (équipe REL)');
  });

  it('posts activities with ephemeral flag and action content', async () => {
    const { api, calls } = fakeLinear({ ActivityCreate: () => ({ agentActivityCreate: { success: true } }) });
    const t = new LinearTracker(api, 'app-1');
    await t.activity('as-1', { type: 'action', action: 'Bash', parameter: 'npm test', ephemeral: true });
    await t.activity('as-1', { type: 'response', body: 'Fini' });
    expect(calls.map((c) => c.vars)).toEqual([
      { input: { agentSessionId: 'as-1', content: { type: 'action', action: 'Bash', parameter: 'npm test' }, ephemeral: true } },
      { input: { agentSessionId: 'as-1', content: { type: 'response', body: 'Fini' } } },
    ]);
  });

  it('creates missing labels when adding them', async () => {
    const { api, calls } = fakeLinear({
      Issue: () => ({ issue: node }),
      TeamLabels: () => ({ issueLabels: { nodes: [{ id: 'l1', name: 'bug' }] } }),
      Team: () => ({ teams: { nodes: [{ id: 't-1', key: 'REL', name: 'Factory' }] } }),
      LabelCreate: (v) => ({ issueLabelCreate: { success: true, issueLabel: { id: 'l2', name: v.input.name } } }),
      IssueUpdate: () => ({ issueUpdate: { success: true } }),
    });
    await new LinearTracker(api, 'app-1').setLabels('REL-1', ['agent:stop'], ['bug']);
    expect(calls.find((c) => c.op === 'LabelCreate')!.vars).toEqual({ input: { name: 'agent:stop', teamId: 't-1', color: '#26b5ce' } });
    expect(calls.at(-1)!.vars).toEqual({ id: 'uuid-1', input: { addedLabelIds: ['l2'], removedLabelIds: ['l1'] } });
  });

  it('writes nothing when the labels already read as asked (a replayed effect, ORC-162)', async () => {
    const { api, calls } = fakeLinear({
      Issue: () => ({ issue: { ...node, labels: { nodes: [{ id: 'l1', name: 'bug' }, { id: 'l2', name: 'agent:pris' }] } } }),
      TeamLabels: () => ({ issueLabels: { nodes: [{ id: 'l1', name: 'bug' }, { id: 'l2', name: 'agent:pris' }] } }),
      IssueUpdate: () => ({ issueUpdate: { success: true } }),
    });
    const t = new LinearTracker(api, 'app-1');
    await t.setLabels('REL-1', ['agent:pris'], ['agent:attente']);
    expect(calls.map((c) => c.op)).toEqual(['Issue']);
    await t.setLabels('REL-1', ['agent:pris'], ['bug']);
    expect(calls.at(-1)).toEqual({ op: 'IssueUpdate', vars: { id: 'uuid-1', input: { addedLabelIds: [], removedLabelIds: ['l1'] } } });
  });

  it('takes off the other labels of the group of a label it adds, once (ORC-160)', async () => {
    const group = { id: 'g-prio' };
    let onIssue = [{ id: 'l1', name: 'bug' }, { id: 'l-low', name: 'prio:basse', parent: group }];
    const { api, calls } = fakeLinear({
      Issue: () => ({ issue: { ...node, labels: { nodes: onIssue } } }),
      TeamLabels: () => ({ issueLabels: { nodes: [{ id: 'l1', name: 'bug' }, { id: 'l-low', name: 'prio:basse', parent: group }, { id: 'l-high', name: 'prio:haute', parent: group }] } }),
      IssueUpdate: () => ({ issueUpdate: { success: true } }),
    });
    const t = new LinearTracker(api, 'app-1');
    await t.setLabels('REL-1', ['prio:haute'], []);
    expect(calls.at(-1)).toEqual({ op: 'IssueUpdate', vars: { id: 'uuid-1', input: { addedLabelIds: ['l-high'], removedLabelIds: ['l-low'] } } });
    // The final state reads as asked: a replay writes nothing.
    onIssue = [{ id: 'l1', name: 'bug' }, { id: 'l-high', name: 'prio:haute', parent: group }];
    const before = calls.length;
    await t.setLabels('REL-1', ['prio:haute'], []);
    expect(calls.slice(before).map((c) => c.op)).toEqual(['Issue']);
    // Both labels of the group on the ticket (set by hand before the group existed): the one asked stays.
    onIssue = [{ id: 'l-low', name: 'prio:basse', parent: group }, { id: 'l-high', name: 'prio:haute', parent: group }];
    await t.setLabels('REL-1', ['prio:haute'], []);
    expect(calls.at(-1)).toEqual({ op: 'IssueUpdate', vars: { id: 'uuid-1', input: { addedLabelIds: [], removedLabelIds: ['l-low'] } } });
    await expect(t.setLabels('REL-1', ['prio:basse', 'prio:haute'], [])).rejects.toThrow('"prio:basse" et "prio:haute"');
  });

  it('reads the team labels again before adding one, so a group made since the start counts (ORC-160)', async () => {
    let teamLabels: { id: string; name: string; parent?: { id: string } }[] = [{ id: 'l-low', name: 'prio:basse' }, { id: 'l-high', name: 'prio:haute' }];
    const { api, calls } = fakeLinear({
      Issue: () => ({ issue: { ...node, labels: { nodes: [{ id: 'l-low', name: 'prio:basse', parent: { id: 'g' } }] } } }),
      TeamStates: () => states,
      TeamLabels: () => ({ issueLabels: { nodes: teamLabels } }),
      IssueUpdate: () => ({ issueUpdate: { success: true } }),
    });
    const t = new LinearTracker(api, 'app-1');
    await t.warm('REL');
    teamLabels = teamLabels.map((l) => ({ ...l, parent: { id: 'g' } }));
    await t.setLabels('REL-1', ['prio:haute'], []);
    expect(calls.at(-1)).toEqual({ op: 'IssueUpdate', vars: { id: 'uuid-1', input: { addedLabelIds: ['l-high'], removedLabelIds: ['l-low'] } } });
  });

  it("keys an effect's comment by a client id and a marker, and finds it by either (ORC-162)", async () => {
    const { api, calls } = fakeLinear({
      Issue: () => ({ issue: node }),
      CommentCreate: () => ({ commentCreate: { success: true } }),
      EffectComment: () => ({ comments: { nodes: [{ id: 'c-9' }] } }),
    });
    const t = new LinearTracker(api, 'app-1');
    await t.comment('REL-1', 'Pris en charge.', 'REL-1:1:2');
    const id = effectUuid('comment', 'REL-1:1:2');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(calls.at(-1)).toEqual({
      op: 'CommentCreate',
      vars: { input: { issueId: 'uuid-1', id, body: 'Pris en charge.\n\n<!-- factory:effect=REL-1:1:2 -->' } },
    });
    expect(await t.findComment('REL-1', 'REL-1:1:2')).toBe('c-9');
    expect(calls.at(-1)).toEqual({ op: 'EffectComment', vars: { issueId: 'uuid-1', id, marker: '<!-- factory:effect=REL-1:1:2 -->' } });
    // Without an effect, a comment is written as before.
    await t.comment('REL-1', 'Budget atteint.');
    expect(calls.at(-1)!.vars).toEqual({ input: { issueId: 'uuid-1', body: 'Budget atteint.' } });
  });

  it("keys an effect's agent activity by a client id and finds it by that id (ORC-162)", async () => {
    let found: { id: string }[] = [];
    const { api, calls } = fakeLinear({
      ActivityCreate: () => ({ agentActivityCreate: { success: true } }),
      EffectActivity: () => ({ agentSession: { activities: { nodes: found } } }),
    });
    const t = new LinearTracker(api, 'app-1');
    const id = effectUuid('activity', 'REL-1:3:1');
    expect(id).not.toBe(effectUuid('comment', 'REL-1:3:1'));
    expect(await t.findActivity('as-1', 'REL-1:3:1')).toBeUndefined();
    await t.activity('as-1', { type: 'response', body: 'Fini' }, 'REL-1:3:1');
    found = [{ id }];
    expect(await t.findActivity('as-1', 'REL-1:3:1')).toBe(id);
    expect(calls.map((c) => c.vars)).toEqual([
      { sessionId: 'as-1', id },
      { input: { agentSessionId: 'as-1', content: { type: 'response', body: 'Fini' }, id } },
      { sessionId: 'as-1', id },
    ]);
  });

  it('does not link a URL the session already links (ORC-162)', async () => {
    const { api, calls } = fakeLinear({
      SessionLinks: () => ({ agentSession: { externalLinks: [{ label: 'Pull request', url: 'https://github.com/a/b/pull/1' }] } }),
      SessionUpdate: () => ({ agentSessionUpdate: { success: true } }),
    });
    const t = new LinearTracker(api, 'app-1');
    await t.addExternalUrl('as-1', 'Pull request', 'https://github.com/a/b/pull/1');
    expect(calls.map((c) => c.op)).toEqual(['SessionLinks']);
    await t.addExternalUrl('as-1', 'Pull request', 'https://github.com/a/b/pull/2');
    expect(calls.at(-1)).toEqual({ op: 'SessionUpdate', vars: { id: 'as-1', input: { addedExternalUrls: [{ label: 'Pull request', url: 'https://github.com/a/b/pull/2' }] } } });
  });

  it('ensureSetup creates only the missing states', async () => {
    const { api, calls } = fakeLinear({
      TeamStates: () => states,
      TeamLabels: () => ({ issueLabels: { nodes: [] } }),
      Team: () => ({ teams: { nodes: [{ id: 't-1', key: 'REL', name: 'Factory' }] } }),
      StateCreate: (v) => ({ workflowStateCreate: { success: true, workflowState: { id: 'x', name: v.input.name } } }),
      LabelCreate: (v) => ({ issueLabelCreate: { success: true, issueLabel: { id: 'y', name: v.input.name } } }),
    });
    const created = await new LinearTracker(api, 'app-1').ensureSetup(
      'REL',
      { todo: 'Todo', dev: 'In Progress', human_review: 'Human Review', ai_review: 'AI Review', ready: 'Ready to Merge', done: 'Done' },
      ['agent:reprendre'],
    );
    expect(created).toEqual(['Human Review', 'AI Review', 'Ready to Merge', 'Done', 'agent:reprendre']);
    expect(calls.find((c) => c.op === 'StateCreate')!.vars).toEqual({ input: { name: 'Human Review', teamId: 't-1', type: 'started', color: '#5e6ad2' } });
  });

  it('creates a session on an issue', async () => {
    const { api } = fakeLinear({
      Issue: () => ({ issue: node }),
      SessionOnIssue: () => ({ agentSessionCreateOnIssue: { success: true, agentSession: { id: 'as-9' } } }),
    });
    expect(await new LinearTracker(api, 'app-1').ensureSession('REL-1')).toBe('as-9');
  });

  it('surfaces GraphQL errors', async () => {
    const { api } = fakeLinear({});
    await expect(api.gql('query Missing { x }')).rejects.toThrow('no handler for Missing');
  });
});
