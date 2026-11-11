import type { PlanStep } from '../../core/session-plan.js';
import type { TeamDirectory } from '../roles/types.js';
import { IssueNotFoundError, type ActivityInput, type DatedIssue, type IssueHistory, type SearchHit, type Tracker, type TrackerIssue } from './types.js';

/** The states of packs/standard/workflow.yml, the catalogue every team has unless a test declares another. */
export const STANDARD_STATES = ['Todo', 'In Progress', 'Human Review', 'AI Review', 'Done'] as const;

export class FakeTracker implements Tracker, TeamDirectory {
  issues = new Map<string, TrackerIssue>();
  calls: { method: string; args: unknown[] }[] = [];
  private sessions = 0;
  private teamStates = new Map<string, readonly string[]>();
  /** Group of each grouped label, by name: labels of a group are exclusive, as in Linear (ORC-160). */
  private labelGroups = new Map<string, string>();
  private members = new Map<string, readonly string[]>();
  /** The blockers of each issue, by identifier: « blocked by » relations (ORC-363). */
  private blockers = new Map<string, string[]>();
  /** The comments of each issue, dated, as a test writes them on Linear (ORC-376): `history` reads them. */
  private threads = new Map<string, { body: string; createdAt: number }[]>();
  /** The issues related to each one, both ways (ORC-376). */
  private related = new Map<string, Set<string>>();

  constructor(private readonly defaultStates: readonly string[] = STANDARD_STATES) {}

  setStates(teamKey: string, states: readonly string[]): void {
    this.teamStates.set(teamKey, states);
  }

  /** Declares a label group: adding one of `labels` takes the others off the ticket. */
  setLabelGroup(group: string, labels: readonly string[]): void {
    for (const l of labels) this.labelGroups.set(l, group);
  }

  /** `blocker` blocks `blocked`, as a Linear relation (ORC-363): `blocked` reads it in `blockedBy`, with the blocker as it is then. */
  blocks(blocker: string, blocked: string): void {
    this.blockers.set(blocked, [...(this.blockers.get(blocked) ?? []), blocker]);
  }

  /** A comment written on `identifier` at `createdAt`, by a human on Linear (ORC-376): `history` reads it, dated. */
  addComment(identifier: string, body: string, createdAt: number): void {
    this.must(identifier);
    this.threads.set(identifier, [...(this.threads.get(identifier) ?? []), { body, createdAt }]);
  }

  /** `a` and `b` related, as a Linear relation (ORC-376): `history` reads each from the other. */
  relate(a: string, b: string): void {
    for (const [x, y] of [[a, b], [b, a]] as const) this.related.set(x, new Set([...(this.related.get(x) ?? []), y]));
  }

  /** The relation taken off. */
  unblocks(blocker: string, blocked: string): void {
    this.blockers.set(blocked, (this.blockers.get(blocked) ?? []).filter((b) => b !== blocker));
  }

  /** The issue as read: a copy, its blockers with their status now. */
  private snapshot(i: TrackerIssue): TrackerIssue {
    const blockedBy = (this.blockers.get(i.identifier) ?? []).map((b) => {
      const { stateName, stateType } = this.must(b);
      return { identifier: b, stateName, stateType };
    });
    return { ...i, labels: [...i.labels], blockedBy };
  }

  /** The Linear user ids of the team's active members (ORC-186); none until set. */
  setTeamMembers(teamKey: string, ids: readonly string[]): void {
    this.members.set(teamKey, [...ids]);
  }

  statesOf(teamKey: string): readonly string[] {
    return this.teamStates.get(teamKey) ?? this.defaultStates;
  }

  private checkState(teamKey: string, stateName: string): void {
    if (!this.statesOf(teamKey).includes(stateName)) throw new Error(`unknown state ${stateName} for team ${teamKey}`);
  }

  addIssue(p: Partial<TrackerIssue> & { identifier: string }): TrackerIssue {
    const issue: TrackerIssue = {
      title: 'Ticket',
      description: 'A description long enough to pass the pickup check.',
      url: `https://linear.app/test/issue/${p.identifier}`,
      stateName: 'Todo',
      stateType: 'unstarted',
      labels: [],
      teamKey: p.identifier.split('-')[0]!,
      priority: 0,
      createdAt: 0,
      ...p,
    };
    this.checkState(issue.teamKey, issue.stateName);
    this.issues.set(issue.identifier, issue);
    return issue;
  }

  private argsOf(method: string, target?: string): unknown[][] {
    return this.calls.filter((c) => c.method === method && (!target || c.args[0] === target)).map((c) => c.args.slice(1));
  }

  activities(sessionId?: string): ActivityInput[] {
    return this.argsOf('activity', sessionId).map(([a]) => a as ActivityInput);
  }

  comments(identifier: string): string[] {
    return this.argsOf('comment', identifier).map(([body]) => body as string);
  }

  agentSessions(identifier: string): string[] {
    return this.argsOf('ensureSession', identifier).map(([id]) => id as string);
  }

  externalUrls(sessionId: string): { label: string; url: string }[] {
    return this.argsOf('addExternalUrl', sessionId).map(([label, url]) => ({ label: label as string, url: url as string }));
  }

  /** The plans written to the session, in order. */
  plans(sessionId: string): (readonly PlanStep[])[] {
    return this.argsOf('setSessionPlan', sessionId).map(([plan]) => plan as readonly PlanStep[]);
  }

  /** What the comments, sessions, activities and links written so far read back as, in the shape the contract suite asks. */
  written() {
    return {
      comments: async (identifier: string) => this.comments(identifier),
      sessions: async (identifier: string) => this.agentSessions(identifier),
      activities: async (sessionId: string) => this.activities(sessionId),
      externalUrls: async (sessionId: string) => this.externalUrls(sessionId),
    };
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  private must(identifier: string): TrackerIssue {
    const i = this.issues.get(identifier);
    if (!i) throw new IssueNotFoundError(`unknown issue ${identifier}`);
    return i;
  }

  async getIssue(identifier: string): Promise<TrackerIssue> {
    return this.snapshot(this.must(identifier));
  }

  /** As Linear's: every relation, both ways, « blocked by » included. */
  async history(identifier: string): Promise<IssueHistory> {
    const dated = (i: TrackerIssue): DatedIssue => ({
      identifier: i.identifier, title: i.title, description: i.description, createdAt: i.createdAt, comments: (this.threads.get(i.identifier) ?? []).map((c) => ({ ...c })),
    });
    const blocked = [...this.blockers].filter(([, by]) => by.includes(identifier)).map(([id]) => id);
    const linked = new Set([...(this.related.get(identifier) ?? []), ...(this.blockers.get(identifier) ?? []), ...blocked]);
    return { issue: dated(this.must(identifier)), linked: [...linked].map((id) => dated(this.must(id))) };
  }

  async listDelegated(teamKey: string): Promise<TrackerIssue[]> {
    // As Linear's query: a completed or canceled issue is not listed, delegated or not.
    return [...this.issues.values()]
      .filter((i) => i.teamKey === teamKey && i.delegateId && i.stateType !== 'completed' && i.stateType !== 'canceled')
      .map((i) => this.snapshot(i));
  }

  async teamMembers(teamKey: string): Promise<string[]> {
    this.record('teamMembers', teamKey);
    return [...(this.members.get(teamKey) ?? [])];
  }

  async search(term: string, teamKey: string): Promise<SearchHit[]> {
    return [...this.issues.values()]
      .filter((i) => i.teamKey === teamKey && i.title.toLowerCase().includes(term.toLowerCase()))
      .map((i) => ({ identifier: i.identifier, title: i.title, url: i.url, stateName: i.stateName }));
  }

  async moveTo(identifier: string, stateName: string): Promise<void> {
    this.record('moveTo', identifier, stateName);
    const i = this.must(identifier);
    this.checkState(i.teamKey, stateName);
    i.stateName = stateName;
  }

  /**
   * As the Linear adapter: a write only when the labels change, so a replay records nothing (ORC-162);
   * adding a label of a group takes the group's other labels off, two of one group are refused (ORC-160).
   */
  async setLabels(identifier: string, add: string[], remove: string[]): Promise<void> {
    const i = this.must(identifier);
    const groups = new Map<string, string>();
    for (const l of add) {
      const group = this.labelGroups.get(l);
      if (group === undefined) continue;
      const other = groups.get(group);
      if (other !== undefined && other !== l) throw new Error(`exclusive labels asked together: ${other} and ${l} (group ${group})`);
      groups.set(group, l);
    }
    const off = (l: string) => {
      const group = this.labelGroups.get(l);
      return remove.includes(l) || (group !== undefined && groups.has(group));
    };
    const next = [...new Set([...i.labels.filter((l) => add.includes(l) || !off(l)), ...add])];
    if (next.length === i.labels.length && next.every((l) => i.labels.includes(l))) return;
    this.record('setLabels', identifier, add, remove);
    i.labels = next;
  }

  /** The effect id, when given, is recorded after the body: `comments()` reads the bodies as written by the factory. */
  async comment(identifier: string, body: string, effectId?: string): Promise<void> {
    this.must(identifier);
    this.record('comment', identifier, body, ...(effectId === undefined ? [] : [effectId]));
  }

  async findComment(identifier: string, effectId: string): Promise<string | undefined> {
    this.must(identifier);
    const n = this.argsOf('comment', identifier).findIndex(([, e]) => e === effectId);
    return n < 0 ? undefined : `comment-${identifier}-${n + 1}`;
  }

  async activity(sessionId: string, a: ActivityInput, effectId?: string): Promise<void> {
    this.record('activity', sessionId, a, ...(effectId === undefined ? [] : [effectId]));
  }

  async findActivity(sessionId: string, effectId: string): Promise<string | undefined> {
    const n = this.argsOf('activity', sessionId).findIndex(([, e]) => e === effectId);
    return n < 0 ? undefined : `activity-${sessionId}-${n + 1}`;
  }

  /** As the Linear adapter: a URL the session already links is not added again. */
  async addExternalUrl(sessionId: string, label: string, url: string): Promise<void> {
    if (this.externalUrls(sessionId).some((l) => l.url === url)) return;
    this.record('addExternalUrl', sessionId, label, url);
  }

  async setSessionPlan(sessionId: string, plan: readonly PlanStep[]): Promise<void> {
    this.record('setSessionPlan', sessionId, plan);
  }

  async ensureSession(identifier: string): Promise<string> {
    this.must(identifier);
    const id = `fake-session-${++this.sessions}`;
    this.record('ensureSession', identifier, id);
    return id;
  }
}
