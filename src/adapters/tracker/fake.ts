import type { ActivityInput, SearchHit, Tracker, TrackerIssue } from './types.js';

const snapshot = (i: TrackerIssue): TrackerIssue => ({ ...i, labels: [...i.labels] });

/** The states of packs/standard/workflow.yml, the catalogue every team has unless a test declares another. */
export const STANDARD_STATES = ['Todo', 'In Progress', 'Human Review', 'AI Review', 'Ready to Merge', 'Done'] as const;

export class FakeTracker implements Tracker {
  issues = new Map<string, TrackerIssue>();
  calls: { method: string; args: unknown[] }[] = [];
  private sessions = 0;
  private teamStates = new Map<string, readonly string[]>();
  /** Group of each grouped label, by name: labels of a group are exclusive, as in Linear (ORC-160). */
  private labelGroups = new Map<string, string>();

  constructor(private readonly defaultStates: readonly string[] = STANDARD_STATES) {}

  setStates(teamKey: string, states: readonly string[]): void {
    this.teamStates.set(teamKey, states);
  }

  /** Declares a label group: adding one of `labels` takes the others off the ticket. */
  setLabelGroup(group: string, labels: readonly string[]): void {
    for (const l of labels) this.labelGroups.set(l, group);
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
      description: 'Description assez longue pour passer le contrôle de prise en charge.',
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
    if (!i) throw new Error(`unknown issue ${identifier}`);
    return i;
  }

  async getIssue(identifier: string): Promise<TrackerIssue> {
    return snapshot(this.must(identifier));
  }

  async listDelegated(teamKey: string): Promise<TrackerIssue[]> {
    return [...this.issues.values()].filter((i) => i.teamKey === teamKey && i.delegateId).map(snapshot);
  }

  async search(term: string): Promise<SearchHit[]> {
    return [...this.issues.values()]
      .filter((i) => i.title.toLowerCase().includes(term.toLowerCase()))
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
   * adding a label of a group takes the group's other labels off (ORC-160).
   */
  async setLabels(identifier: string, add: string[], remove: string[]): Promise<void> {
    const i = this.must(identifier);
    const groups = new Set(add.map((l) => this.labelGroups.get(l)).filter((g) => g !== undefined));
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

  async ensureSession(identifier: string): Promise<string> {
    this.must(identifier);
    const id = `fake-session-${++this.sessions}`;
    this.record('ensureSession', identifier, id);
    return id;
  }
}
