import type { LogicalState } from '../../../core/types.js';
import type { ActivityInput, SearchHit, Tracker, TrackerIssue } from '../types.js';
import type { LinearApi } from './api.js';
import { Q } from './queries.js';

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number;
  createdAt: string;
  state: { id: string; name: string; type: string };
  labels: { nodes: { id: string; name: string }[] };
  delegate: { id: string } | null;
  team: { id: string; key: string };
}
interface StateNode {
  id: string;
  name: string;
  type: string;
  position: number;
}

const STATE_TYPES: Record<LogicalState, string> = {
  todo: 'unstarted',
  dev: 'started',
  human_review: 'started',
  ai_review: 'started',
  ready: 'started',
  done: 'completed',
};

const teamOf = (identifier: string) => identifier.split('-')[0]!;

function toIssue(n: IssueNode): TrackerIssue {
  return {
    identifier: n.identifier,
    title: n.title,
    description: n.description ?? '',
    url: n.url,
    stateName: n.state.name,
    stateType: n.state.type,
    labels: n.labels.nodes.map((l) => l.name),
    delegateId: n.delegate?.id,
    teamKey: n.team.key,
    priority: n.priority,
    createdAt: Date.parse(n.createdAt),
  };
}

export class LinearTracker implements Tracker {
  private states = new Map<string, StateNode[]>();
  private labels = new Map<string, Map<string, string>>();
  private teamIds = new Map<string, string>();
  private issueIds = new Map<string, string>();

  constructor(
    private api: LinearApi,
    private appUserId: string,
  ) {}

  private async node(identifier: string): Promise<IssueNode> {
    const { issue } = await this.api.gql<{ issue: IssueNode | null }>(Q.issue, { id: identifier });
    if (!issue) throw new Error(`Ticket Linear introuvable : ${identifier}`);
    this.issueIds.set(identifier, issue.id);
    return issue;
  }

  private async issueId(identifier: string): Promise<string> {
    return this.issueIds.get(identifier) ?? (await this.node(identifier)).id;
  }

  private async teamId(teamKey: string): Promise<string> {
    const cached = this.teamIds.get(teamKey);
    if (cached) return cached;
    const { teams } = await this.api.gql<{ teams: { nodes: { id: string }[] } }>(Q.team, { key: teamKey });
    const id = teams.nodes[0]?.id;
    if (!id) throw new Error(`Équipe Linear introuvable : ${teamKey}`);
    this.teamIds.set(teamKey, id);
    return id;
  }

  private async teamStates(teamKey: string, refresh = false): Promise<StateNode[]> {
    if (!refresh && this.states.has(teamKey)) return this.states.get(teamKey)!;
    const { workflowStates } = await this.api.gql<{ workflowStates: { nodes: StateNode[] } }>(Q.teamStates, { teamKey });
    this.states.set(teamKey, workflowStates.nodes);
    return workflowStates.nodes;
  }

  private async teamLabels(teamKey: string, refresh = false): Promise<Map<string, string>> {
    if (!refresh && this.labels.has(teamKey)) return this.labels.get(teamKey)!;
    const { issueLabels } = await this.api.gql<{ issueLabels: { nodes: { id: string; name: string }[] } }>(Q.teamLabels, { teamKey });
    const map = new Map(issueLabels.nodes.map((l) => [l.name, l.id]));
    this.labels.set(teamKey, map);
    return map;
  }

  async warm(teamKey: string): Promise<void> {
    await this.teamStates(teamKey, true);
    await this.teamLabels(teamKey, true);
  }

  stateNameById(teamKey: string, id: string): string | undefined {
    return this.states.get(teamKey)?.find((s) => s.id === id)?.name;
  }

  labelNameById(teamKey: string, id: string): string | undefined {
    for (const [name, lid] of this.labels.get(teamKey) ?? []) if (lid === id) return name;
    return undefined;
  }

  async getIssue(identifier: string): Promise<TrackerIssue> {
    return toIssue(await this.node(identifier));
  }

  async listDelegated(teamKey: string): Promise<TrackerIssue[]> {
    const { issues } = await this.api.gql<{ issues: { nodes: IssueNode[] } }>(Q.delegated, { teamKey, appUserId: this.appUserId });
    for (const n of issues.nodes) this.issueIds.set(n.identifier, n.id);
    return issues.nodes.map(toIssue);
  }

  async search(term: string): Promise<SearchHit[]> {
    const { searchIssues } = await this.api.gql<{
      searchIssues: { nodes: { identifier: string; title: string; url: string; state: { name: string } }[] };
    }>(Q.search, { term });
    return searchIssues.nodes.map((n) => ({ identifier: n.identifier, title: n.title, url: n.url, stateName: n.state.name }));
  }

  async moveTo(identifier: string, stateName: string): Promise<void> {
    const team = teamOf(identifier);
    let state = (await this.teamStates(team)).find((s) => s.name === stateName);
    state ??= (await this.teamStates(team, true)).find((s) => s.name === stateName);
    if (!state) throw new Error(`Statut Linear introuvable : "${stateName}" (équipe ${team})`);
    await this.api.gql(Q.issueUpdate, { id: await this.issueId(identifier), input: { stateId: state.id } });
  }

  private async labelId(teamKey: string, name: string): Promise<string> {
    const labels = await this.teamLabels(teamKey);
    const existing = labels.get(name);
    if (existing) return existing;
    const { issueLabelCreate } = await this.api.gql<{ issueLabelCreate: { issueLabel: { id: string } } }>(Q.labelCreate, {
      input: { name, teamId: await this.teamId(teamKey), color: '#26b5ce' },
    });
    labels.set(name, issueLabelCreate.issueLabel.id);
    return issueLabelCreate.issueLabel.id;
  }

  async setLabels(identifier: string, add: string[], remove: string[]): Promise<void> {
    const team = teamOf(identifier);
    const id = await this.issueId(identifier);
    const addedLabelIds: string[] = [];
    for (const name of add) addedLabelIds.push(await this.labelId(team, name));
    const labels = await this.teamLabels(team);
    const removedLabelIds = remove.map((n) => labels.get(n)).filter((x): x is string => !!x);
    await this.api.gql(Q.issueUpdate, { id, input: { addedLabelIds, removedLabelIds } });
  }

  async comment(identifier: string, body: string): Promise<void> {
    await this.api.gql(Q.commentCreate, { input: { issueId: await this.issueId(identifier), body } });
  }

  async activity(sessionId: string, a: ActivityInput): Promise<void> {
    const content =
      a.type === 'action'
        ? { type: 'action', action: a.action, parameter: a.parameter, ...(a.result ? { result: a.result } : {}) }
        : { type: a.type, body: a.body };
    const input: Record<string, unknown> = { agentSessionId: sessionId, content };
    if (a.ephemeral) input['ephemeral'] = true;
    await this.api.gql(Q.activityCreate, { input });
  }

  async addExternalUrl(sessionId: string, label: string, url: string): Promise<void> {
    await this.api.gql(Q.sessionUpdate, { id: sessionId, input: { addedExternalUrls: [{ label, url }] } });
  }

  async ensureSession(identifier: string): Promise<string> {
    const { agentSessionCreateOnIssue } = await this.api.gql<{ agentSessionCreateOnIssue: { agentSession: { id: string } } }>(
      Q.sessionOnIssue,
      { input: { issueId: await this.issueId(identifier) } },
    );
    return agentSessionCreateOnIssue.agentSession.id;
  }

  async ensureSetup(teamKey: string, states: Record<LogicalState, string>, labels: string[]): Promise<string[]> {
    const created: string[] = [];
    const existing = new Set((await this.teamStates(teamKey, true)).map((s) => s.name));
    const teamId = await this.teamId(teamKey);
    for (const [logical, name] of Object.entries(states) as [LogicalState, string][]) {
      if (existing.has(name)) continue;
      await this.api.gql(Q.stateCreate, { input: { name, teamId, type: STATE_TYPES[logical], color: '#5e6ad2' } });
      created.push(name);
    }
    const existingLabels = await this.teamLabels(teamKey, true);
    for (const name of labels) {
      if (existingLabels.has(name)) continue;
      await this.labelId(teamKey, name);
      created.push(name);
    }
    await this.warm(teamKey);
    return created;
  }
}
