import { describe, expect, it } from 'vitest';
import { LinearApi, type FetchLike } from './api.js';
import { LinearTracker } from './tracker.js';

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
      Team: () => ({ teams: { nodes: [{ id: 't-1', key: 'REL', name: 'Relais' }] } }),
      LabelCreate: (v) => ({ issueLabelCreate: { success: true, issueLabel: { id: 'l2', name: v.input.name } } }),
      IssueUpdate: () => ({ issueUpdate: { success: true } }),
    });
    await new LinearTracker(api, 'app-1').setLabels('REL-1', ['agent:stop'], ['bug']);
    expect(calls.find((c) => c.op === 'LabelCreate')!.vars).toEqual({ input: { name: 'agent:stop', teamId: 't-1', color: '#26b5ce' } });
    expect(calls.at(-1)!.vars).toEqual({ id: 'uuid-1', input: { addedLabelIds: ['l2'], removedLabelIds: ['l1'] } });
  });

  it('ensureSetup creates only the missing states', async () => {
    const { api, calls } = fakeLinear({
      TeamStates: () => states,
      TeamLabels: () => ({ issueLabels: { nodes: [] } }),
      Team: () => ({ teams: { nodes: [{ id: 't-1', key: 'REL', name: 'Relais' }] } }),
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
