import type { ActivityInput, SearchHit, Tracker, TrackerIssue } from './types.js';

const snapshot = (i: TrackerIssue): TrackerIssue => ({ ...i, labels: [...i.labels] });

/** The states of packs/standard/workflow.yml, the catalogue every team has unless a test declares another. */
export const STANDARD_STATES = ['Todo', 'In Progress', 'Human Review', 'AI Review', 'Ready to Merge', 'Done'] as const;

export class FakeTracker implements Tracker {
  issues = new Map<string, TrackerIssue>();
  calls: { method: string; args: unknown[] }[] = [];
  private sessions = 0;
  private teamStates = new Map<string, readonly string[]>();

  constructor(private readonly defaultStates: readonly string[] = STANDARD_STATES) {}

  setStates(teamKey: string, states: readonly string[]): void {
    this.teamStates.set(teamKey, states);
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

  externalUrls(sessionId: string): { label: string; url: string }[] {
    return this.argsOf('addExternalUrl', sessionId).map(([label, url]) => ({ label: label as string, url: url as string }));
  }

  /** What the comments, activities and links written so far read back as, in the shape the contract suite asks. */
  written() {
    return {
      comments: async (identifier: string) => this.comments(identifier),
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

  async setLabels(identifier: string, add: string[], remove: string[]): Promise<void> {
    this.record('setLabels', identifier, add, remove);
    const i = this.must(identifier);
    i.labels = [...new Set([...i.labels.filter((l) => !remove.includes(l)), ...add])];
  }

  async comment(identifier: string, body: string): Promise<void> {
    this.must(identifier);
    this.record('comment', identifier, body);
  }

  async activity(sessionId: string, a: ActivityInput): Promise<void> {
    this.record('activity', sessionId, a);
  }

  async addExternalUrl(sessionId: string, label: string, url: string): Promise<void> {
    this.record('addExternalUrl', sessionId, label, url);
  }

  async ensureSession(identifier: string): Promise<string> {
    this.must(identifier);
    this.record('ensureSession', identifier);
    return `fake-session-${++this.sessions}`;
  }
}
