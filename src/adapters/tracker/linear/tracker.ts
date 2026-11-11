import { createHash } from 'node:crypto';
import type { PlanStep } from '../../../core/session-plan.js';
import type { LogicalState } from '../../../core/types.js';
import type { TeamDirectory } from '../../roles/types.js';
import type { CompletedIssue } from '../../../core/baseline.js';
import { effectMarker, IssueNotFoundError, teamOf, type ActivityInput, type DatedIssue, type IssueHistory, type SearchHit, type Tracker, type TrackerIssue } from '../types.js';
import { LinearApiError, type LinearApi, type LinearGqlError } from './api.js';
import { allNodes, type Connection } from '../../graphql-pages.js';
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
  /** Linear's default page of them: `withAllPages` reads the rest (ORC-347). */
  labels: Connection<LabelNode>;
  /** Linear's first page of them: `withAllPages` reads the rest (ORC-363). */
  inverseRelations: Connection<RelationNode>;
  delegate: { id: string } | null;
  team: { id: string; key: string };
  /** Null for an issue an integration created, or whose creator was deleted. Absent from answers older than ORC-197. */
  creator?: { id: string; name: string; url: string } | null;
}
/** `parent`: the label group, whose labels are exclusive in Linear (one per issue). */
interface LabelNode {
  id: string;
  name: string;
  parent?: { id: string } | null;
}
/** A relation where the issue is the related one: `blocks` from `issue`, the blocker (ORC-363). */
interface RelationNode {
  type: string;
  /** Null when Linear will not show it (another team the token cannot read): no blocker the factory can follow. */
  issue: { identifier: string; trashed?: boolean | null; state: { name: string; type: string } } | null;
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

export { teamOf };

/**
 * Linear's answer for an issue it does not have, read on its fields, not its words (ORC-348): an `invalid input` on the
 * `issue` field itself, whose only input is the identifier. A refusal below it (`issue.team`) is about something else.
 */
const isNotFound = (e: LinearGqlError) => e.extensions?.type === 'invalid input' && e.path?.length === 1 && e.path[0] === 'issue';

/**
 * The id a comment or an activity of an outbox effect is created with (ORC-162): Linear takes a
 * client id in UUID v4 format on `commentCreate` and `agentActivityCreate`, so a replay finds the
 * object by it. A sha256 of the effect id with the version and variant bits of a v4: the same effect
 * always gets the same id.
 */
export function effectUuid(kind: 'comment' | 'activity' | 'reaction', effectId: string): string {
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
    // A blocker deleted (in the trash) delivers nothing more: it holds nothing back.
    blockedBy: n.inverseRelations.nodes.flatMap((r) =>
      r.type === 'blocks' && r.issue && !r.issue.trashed ? [{ identifier: r.issue.identifier, stateName: r.issue.state.name, stateType: r.issue.state.type }] : [],
    ),
    delegateId: n.delegate?.id,
    ...(n.creator ? { creator: { id: n.creator.id, name: n.creator.name, url: n.creator.url } } : {}),
    teamKey: n.team.key,
    priority: n.priority,
    createdAt: Date.parse(n.createdAt),
    ...(n.updatedAt && Number.isFinite(Date.parse(n.updatedAt)) ? { updatedAt: Date.parse(n.updatedAt) } : {}),
  };
}

/** A ticket as `Q.issueHistory` reads it (ORC-376). */
interface DatedNode {
  identifier: string;
  title: string;
  description: string | null;
  createdAt: string;
  comments: { nodes: { body: string; createdAt: string }[] };
}

const dated = (n: DatedNode): DatedIssue => ({
  identifier: n.identifier,
  title: n.title,
  description: n.description ?? '',
  createdAt: Date.parse(n.createdAt),
  comments: n.comments.nodes.map((c) => ({ body: c.body, createdAt: Date.parse(c.createdAt) })),
});

interface MembersPage {
  teams: { nodes: { members: Connection<{ id: string; active: boolean }> }[] };
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

  /** `relations`: every page of its relations too, for a read of the ticket; a write needs its labels only. */
  private async node(identifier: string, relations = false): Promise<IssueNode> {
    const issue = await this.queryIssue<IssueNode>(Q.issue, identifier);
    this.issueIds.set(identifier, issue.id);
    return this.withAllPages(issue, relations);
  }

  /** The issue `query` reads by its identifier; `IssueNotFoundError` when Linear has none. */
  private async queryIssue<N>(query: string, identifier: string): Promise<N> {
    let issue: N | null = null;
    try {
      ({ issue } = await this.api.gql<{ issue: N | null }>(query, { id: identifier }));
    } catch (err) {
      // Linear answers an unknown or deleted issue with an error, not with null.
      if (!(err instanceof LinearApiError && err.errors.some(isNotFound))) throw err;
    }
    if (!issue) throw new IssueNotFoundError(`Linear ticket not found: ${identifier}`);
    return issue;
  }

  /** Every node of a list `query` reads under `key`, page after page (ORC-347). */
  private pages<N>(what: string, query: string, vars: Record<string, unknown>, key: string): Promise<N[]> {
    return allNodes<N>(what, async (after) => (await this.api.gql<Record<string, Connection<N>>>(query, { ...vars, after }))[key]);
  }

  /**
   * The issue with every label, those past the page its query read included (ORC-347): cut short, they would read as
   * removed, by the reconciliation and by `setLabels`. Its relations likewise when `relations` (ORC-363): a blocker missed
   * would let it start.
   */
  private async withAllPages(n: IssueNode, relations: boolean): Promise<IssueNode> {
    const rest = async <K extends 'labels' | 'inverseRelations'>(key: K, what: string, query: string): Promise<IssueNode[K]> => {
      type Page = { issue: Pick<IssueNode, K> };
      const nodes = await allNodes<IssueNode[K]['nodes'][number]>(`the ${what} of ${n.identifier}`, async (after) =>
        after === null ? n[key] : (await this.api.gql<Page>(query, { id: n.id, after })).issue[key],
      );
      return { nodes, pageInfo: { hasNextPage: false, endCursor: null } } as IssueNode[K];
    };
    const [labels, inverseRelations] = await Promise.all([
      rest('labels', 'labels', Q.issueLabels),
      relations ? rest('inverseRelations', 'relations', Q.issueRelations) : n.inverseRelations,
    ]);
    return { ...n, labels, inverseRelations };
  }

  private async issueId(identifier: string): Promise<string> {
    return this.issueIds.get(identifier) ?? (await this.node(identifier)).id;
  }

  private async teamId(teamKey: string): Promise<string> {
    const cached = this.teamIds.get(teamKey);
    if (cached) return cached;
    const { teams } = await this.api.gql<{ teams: { nodes: { id: string }[] } }>(Q.team, { key: teamKey });
    const id = teams.nodes[0]?.id;
    if (!id) throw new Error(`Linear team not found: ${teamKey}`);
    this.teamIds.set(teamKey, id);
    return id;
  }

  /**
   * The ids of the team's active members (ORC-186), read each time, every page: the role resolver keeps
   * them a short while, never this adapter. An unknown team is an error, not an empty team.
   */
  async teamMembers(teamKey: string): Promise<string[]> {
    const members = await allNodes<{ id: string; active: boolean }>(`the members of Linear team ${teamKey}`, async (after) => {
      const page = await this.api.gql<MembersPage>(Q.teamMembers, { key: teamKey, after });
      const team = page.teams.nodes[0];
      if (!team) throw new Error(`Linear team not found: ${teamKey}`);
      return team.members;
    });
    return members.filter((m) => m.active).map((m) => m.id);
  }

  private async teamStates(teamKey: string, refresh = false): Promise<StateNode[]> {
    if (!refresh && this.states.has(teamKey)) return this.states.get(teamKey)!;
    const states = await this.pages<StateNode>(`the states of Linear team ${teamKey}`, Q.teamStates, { teamKey }, 'workflowStates');
    this.states.set(teamKey, states);
    return states;
  }

  private async teamLabels(teamKey: string, refresh = false): Promise<Map<string, string>> {
    if (!refresh && this.labels.has(teamKey)) return this.labels.get(teamKey)!;
    // Every page: a label missed past the first one would be created again (ORC-347).
    const labels = await this.pages<LabelNode>(`the labels of Linear team ${teamKey}`, Q.teamLabels, { teamKey }, 'issueLabels');
    const map = new Map(labels.map((l) => [l.name, l.id]));
    for (const l of labels) {
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
    const issue = await this.node(identifier, true);
    // Deleted in Linear: kept in the trash, and still answered, for 30 days.
    if (issue.trashed) throw new IssueNotFoundError(`Linear ticket deleted: ${identifier}`);
    return toIssue(issue);
  }

  async history(identifier: string): Promise<IssueHistory> {
    type Node = DatedNode & { trashed: boolean | null; relations: { nodes: { relatedIssue: DatedNode | null }[] }; inverseRelations: { nodes: { issue: DatedNode | null }[] } };
    const issue = await this.queryIssue<Node>(Q.issueHistory, identifier);
    // Deleted in Linear, as `getIssue` says.
    if (issue.trashed) throw new IssueNotFoundError(`Linear ticket deleted: ${identifier}`);
    const linked = [...issue.relations.nodes.map((r) => r.relatedIssue), ...issue.inverseRelations.nodes.map((r) => r.issue)].filter((n): n is DatedNode => !!n);
    // A ticket related twice (a relation each way) is read once.
    return { issue: dated(issue), linked: [...new Map(linked.map((n) => [n.identifier, dated(n)])).values()] };
  }

  async listDelegated(teamKey: string): Promise<TrackerIssue[]> {
    // Every page: a ticket past the first one got no catch-up from the reconciliation, only a `getIssue` (ORC-347).
    const issues = await this.pages<IssueNode>(`the tickets of Linear team ${teamKey} delegated to the app`, Q.delegated, { teamKey, appUserId: this.appUserId }, 'issues');
    // A deleted issue is not delegated, as getIssue says, even if the query still lists it from the trash.
    const live = issues.filter((n) => !n.trashed);
    for (const n of live) this.issueIds.set(n.identifier, n.id);
    return (await Promise.all(live.map((n) => this.withAllPages(n, true)))).map(toIssue);
  }

  /**
   * The issues of the team completed in `[since, until)`, every page (ORC-230): for `factory baseline`, not the factory's own
   * work. An issue whose links run past the page read throws: a PR missed would read as an issue delivered without one.
   */
  async completedIssues(teamKey: string, since: number, until: number): Promise<CompletedIssue[]> {
    type Node = { identifier: string; startedAt: string | null; completedAt: string; trashed?: boolean | null; attachments: Connection<{ url: string }> };
    const vars = { teamKey, since: new Date(since).toISOString(), until: new Date(until).toISOString() };
    const issues = await this.pages<Node>(`the issues of Linear team ${teamKey} completed in the period`, Q.completed, vars, 'issues');
    return issues
      .filter((n) => !n.trashed)
      .map((n) => {
        if (n.attachments.pageInfo.hasNextPage) throw new Error(`the links of ${n.identifier}: more than one page, never read as complete`);
        return { identifier: n.identifier, startedAt: n.startedAt ? Date.parse(n.startedAt) : null, completedAt: Date.parse(n.completedAt), links: n.attachments.nodes.map((a) => a.url) };
      });
  }

  async search(term: string, teamKey: string): Promise<SearchHit[]> {
    const { searchIssues } = await this.api.gql<{
      searchIssues: { nodes: { identifier: string; title: string; url: string; state: { name: string } }[] };
    }>(Q.search, { term, teamKey });
    // The filter is Linear's: a hit of another team is dropped here all the same.
    return searchIssues.nodes.filter((n) => teamOf(n.identifier) === teamKey).map((n) => ({ identifier: n.identifier, title: n.title, url: n.url, stateName: n.state.name }));
  }

  async moveTo(identifier: string, stateName: string): Promise<void> {
    const team = teamOf(identifier);
    let state = (await this.teamStates(team)).find((s) => s.name === stateName);
    state ??= (await this.teamStates(team, true)).find((s) => s.name === stateName);
    if (!state) throw new Error(`Linear status not found: "${stateName}" (team ${team})`);
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
      if (other !== undefined && other !== name) throw new Error(`Exclusive labels asked for together: "${other}" and "${name}" (same Linear group)`);
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

  async react(commentId: string, emoji: string, effectId?: string): Promise<void> {
    const input: Record<string, unknown> = { commentId, emoji };
    if (effectId !== undefined) input['id'] = effectUuid('reaction', effectId);
    await this.api.gql(Q.reactionCreate, { input });
  }

  async findReaction(commentId: string, effectId: string): Promise<string | undefined> {
    const { comment } = await this.api.gql<{ comment: { reactions: { id: string }[] } | null }>(Q.effectReaction, { commentId });
    const id = effectUuid('reaction', effectId);
    return comment?.reactions.find((r) => r.id === id)?.id;
  }

  async activity(sessionId: string, a: ActivityInput, effectId?: string): Promise<void> {
    const content =
      a.type === 'action'
        ? { type: 'action', action: a.action, parameter: a.parameter, ...(a.result ? { result: a.result } : {}) }
        : { type: a.type, body: a.body };
    const input: Record<string, unknown> = { agentSessionId: sessionId, content };
    if (a.type === 'elicitation' && a.options?.length) {
      input['signal'] = 'select';
      input['signalMetadata'] = { options: a.options.map((o) => ({ label: o, value: o })) };
    }
    if (a.ephemeral) input['ephemeral'] = true;
    if (effectId !== undefined) input['id'] = effectUuid('activity', effectId);
    // The live feed's ephemeral activities yield Linear's quota to every other call (ORC-350).
    await this.api.gql(Q.activityCreate, { input }, { background: !!a.ephemeral });
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

  async setSessionPlan(sessionId: string, plan: readonly PlanStep[]): Promise<void> {
    await this.api.gql(Q.sessionUpdate, { id: sessionId, input: { plan } });
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
