import { createHash } from 'node:crypto';
import type { LogicalState } from '../../../core/types.js';
import type { TeamDirectory } from '../../roles/types.js';
import { effectMarker, IssueNotFoundError, type ActivityInput, type SearchHit, type Tracker, type TrackerIssue } from '../types.js';
import { LinearApiError, type LinearApi, type LinearGqlError } from './api.js';
import { Q } from './queries.js';

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number;
  createdAt: string;
  updatedAt?: string;
  /** In the trash: deleted, until Linear purges it 30 days later. */
  trashed?: boolean | null;
  state: { id: string; name: string; type: string };
  labels: { nodes: LabelNode[] };
  delegate: { id: string } | null;
  team: { id: string; key: string };
}
/** `parent`: the label group, whose labels are exclusive in Linear (one per issue). */
interface LabelNode {
  id: string;
  name: string;
  parent?: { id: string } | null;
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

/** Linear's answer for an issue it does not have: `Entity not found: Issue`, shown as `Could not find referenced Issue.` */
const isNotFound = (e: LinearGqlError) => /Entity not found: Issue\b|Could not find referenced Issue\b/.test(`${e.message} ${e.extensions?.userPresentableMessage ?? ''}`);

/**
 * The id a comment or an activity of an outbox effect is created with (ORC-162): Linear takes a
 * client id in UUID v4 format on `commentCreate` and `agentActivityCreate`, so a replay finds the
 * object by it. A sha256 of the effect id with the version and variant bits of a v4: the same effect
 * always gets the same id.
 */
export function effectUuid(kind: 'comment' | 'activity', effectId: string): string {
  const h = createHash('sha256').update(`factory:${kind}:${effectId}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

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
    ...(n.updatedAt && Number.isFinite(Date.parse(n.updatedAt)) ? { updatedAt: Date.parse(n.updatedAt) } : {}),
  };
}

interface MembersPage {
  teams: { nodes: { members: { nodes: { id: string; active: boolean }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }[] };
}

export class LinearTracker implements Tracker, TeamDirectory {
  private states = new Map<string, StateNode[]>();
  private labels = new Map<string, Map<string, string>>();
  /** Group of each team label read, by label id (label ids are unique across teams). */
  private labelGroups = new Map<string, string>();
  private teamIds = new Map<string, string>();
  private issueIds = new Map<string, string>();

  constructor(
    private api: LinearApi,
    private appUserId: string,
  ) {}

  private async node(identifier: string): Promise<IssueNode> {
    let issue: IssueNode | null = null;
    try {
      ({ issue } = await this.api.gql<{ issue: IssueNode | null }>(Q.issue, { id: identifier }));
    } catch (err) {
      // Linear answers an unknown or deleted issue with an error, not with null.
      if (!(err instanceof LinearApiError && err.errors.some(isNotFound))) throw err;
    }
    if (!issue) throw new IssueNotFoundError(`Ticket Linear introuvable : ${identifier}`);
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

  /**
   * The ids of the team's active members (ORC-186), read each time, every page: the role resolver keeps
   * them a short while, never this adapter. An unknown team is an error, not an empty team.
   */
  async teamMembers(teamKey: string): Promise<string[]> {
    const ids: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page: MembersPage = await this.api.gql<MembersPage>(Q.teamMembers, { key: teamKey, after });
      const team = page.teams.nodes[0];
      if (!team) throw new Error(`Équipe Linear introuvable : ${teamKey}`);
      ids.push(...team.members.nodes.filter((m) => m.active).map((m) => m.id));
      if (!team.members.pageInfo.hasNextPage || !team.members.pageInfo.endCursor) return ids;
      after = team.members.pageInfo.endCursor;
    }
  }

  private async teamStates(teamKey: string, refresh = false): Promise<StateNode[]> {
    if (!refresh && this.states.has(teamKey)) return this.states.get(teamKey)!;
    const { workflowStates } = await this.api.gql<{ workflowStates: { nodes: StateNode[] } }>(Q.teamStates, { teamKey });
    this.states.set(teamKey, workflowStates.nodes);
    return workflowStates.nodes;
  }

  private async teamLabels(teamKey: string, refresh = false): Promise<Map<string, string>> {
    if (!refresh && this.labels.has(teamKey)) return this.labels.get(teamKey)!;
    const { issueLabels } = await this.api.gql<{ issueLabels: { nodes: LabelNode[] } }>(Q.teamLabels, { teamKey });
    const map = new Map(issueLabels.nodes.map((l) => [l.name, l.id]));
    for (const l of issueLabels.nodes) {
      if (l.parent?.id) this.labelGroups.set(l.id, l.parent.id);
      else this.labelGroups.delete(l.id);
    }
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

  stateTypeById(teamKey: string, id: string): string | undefined {
    return this.states.get(teamKey)?.find((s) => s.id === id)?.type;
  }

  labelNameById(teamKey: string, id: string): string | undefined {
    for (const [name, lid] of this.labels.get(teamKey) ?? []) if (lid === id) return name;
    return undefined;
  }

  async getIssue(identifier: string): Promise<TrackerIssue> {
    const issue = await this.node(identifier);
    // Deleted in Linear: kept in the trash, and still answered, for 30 days.
    if (issue.trashed) throw new IssueNotFoundError(`Ticket Linear supprimé : ${identifier}`);
    return toIssue(issue);
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

  /**
   * Reads the ticket's labels first and writes only what differs: a replay writes nothing (ORC-162).
   * Labels of a Linear group are exclusive (ORC-160): adding one takes off the ticket's other labels
   * of its group, as Linear's interface does, so the final state does not depend on what was there.
   * Before adding a label, the team's labels are read again: a group made since the start counts.
   * Two labels of one group in `add` cannot both hold: refused, rather than one picked silently.
   */
  async setLabels(identifier: string, add: string[], remove: string[]): Promise<void> {
    const team = teamOf(identifier);
    const issue = await this.node(identifier);
    const has = new Map(issue.labels.nodes.map((l) => [l.name, l]));
    if (add.some((name) => !has.has(name))) await this.teamLabels(team, true);
    const addedLabelIds: string[] = [];
    const groups = new Map<string, string>();
    for (const name of add) {
      const present = has.get(name);
      const id = present?.id ?? (await this.labelId(team, name));
      if (!present) addedLabelIds.push(id);
      const group = present?.parent?.id ?? this.labelGroups.get(id);
      if (!group) continue;
      const other = groups.get(group);
      if (other !== undefined && other !== name) throw new Error(`Labels exclusifs demandés ensemble : "${other}" et "${name}" (même groupe Linear)`);
      groups.set(group, name);
    }
    const removedLabelIds = issue.labels.nodes
      .filter((l) => !add.includes(l.name) && (remove.includes(l.name) || (l.parent?.id !== undefined && groups.has(l.parent.id))))
      .map((l) => l.id);
    if (addedLabelIds.length === 0 && removedLabelIds.length === 0) return;
    await this.api.gql(Q.issueUpdate, { id: issue.id, input: { addedLabelIds, removedLabelIds } });
  }

  async comment(identifier: string, body: string, effectId?: string): Promise<void> {
    const input: Record<string, unknown> = { issueId: await this.issueId(identifier), body };
    if (effectId !== undefined) {
      input['id'] = effectUuid('comment', effectId);
      input['body'] = `${body}\n\n${effectMarker(effectId)}`;
    }
    await this.api.gql(Q.commentCreate, { input });
  }

  async findComment(identifier: string, effectId: string): Promise<string | undefined> {
    const { comments } = await this.api.gql<{ comments: { nodes: { id: string }[] } }>(Q.effectComment, {
      issueId: await this.issueId(identifier),
      id: effectUuid('comment', effectId),
      marker: effectMarker(effectId),
    });
    return comments.nodes[0]?.id;
  }

  async activity(sessionId: string, a: ActivityInput, effectId?: string): Promise<void> {
    const content =
      a.type === 'action'
        ? { type: 'action', action: a.action, parameter: a.parameter, ...(a.result ? { result: a.result } : {}) }
        : { type: a.type, body: a.body };
    const input: Record<string, unknown> = { agentSessionId: sessionId, content };
    if (a.ephemeral) input['ephemeral'] = true;
    if (effectId !== undefined) input['id'] = effectUuid('activity', effectId);
    await this.api.gql(Q.activityCreate, { input });
  }

  async findActivity(sessionId: string, effectId: string): Promise<string | undefined> {
    const { agentSession } = await this.api.gql<{ agentSession: { activities: { nodes: { id: string }[] } } | null }>(Q.effectActivity, {
      sessionId,
      id: effectUuid('activity', effectId),
    });
    return agentSession?.activities.nodes[0]?.id;
  }

  async addExternalUrl(sessionId: string, label: string, url: string): Promise<void> {
    const { agentSession } = await this.api.gql<{ agentSession: { externalLinks: { url: string }[] } | null }>(Q.sessionLinks, { id: sessionId });
    if (agentSession?.externalLinks.some((l) => l.url === url)) return;
    await this.api.gql(Q.sessionUpdate, { id: sessionId, input: { addedExternalUrls: [{ label, url }] } });
  }

  async ensureSession(identifier: string): Promise<string> {
    const { agentSessionCreateOnIssue } = await this.api.gql<{ agentSessionCreateOnIssue: { agentSession: { id: string } } }>(
      Q.sessionOnIssue,
      { input: { issueId: await this.issueId(identifier) } },
    );
    return agentSessionCreateOnIssue.agentSession.id;
  }

  async ensureSetup(teamKey: string, states: Partial<Record<LogicalState, string>>, labels: string[]): Promise<string[]> {
    const created: string[] = [];
    const existing = new Set((await this.teamStates(teamKey, true)).map((s) => s.name));
    const teamId = await this.teamId(teamKey);
    for (const [logical, name] of Object.entries(states) as [LogicalState, string | undefined][]) {
      if (!name || existing.has(name)) continue;
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
