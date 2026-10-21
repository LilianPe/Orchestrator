import type { ActivityInput, SearchHit, Tracker, TrackerIssue } from './types.js';

export class FakeTracker implements Tracker {
  issues = new Map<string, TrackerIssue>();
  calls: { method: string; args: unknown[] }[] = [];
  private sessions = 0;

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
    this.issues.set(issue.identifier, issue);
    return issue;
  }

  activities(sessionId?: string): ActivityInput[] {
    return this.calls
      .filter((c) => c.method === 'activity' && (!sessionId || c.args[0] === sessionId))
      .map((c) => c.args[1] as ActivityInput);
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
    const i = this.must(identifier);
    return { ...i, labels: [...i.labels] };
  }

  async listDelegated(teamKey: string): Promise<TrackerIssue[]> {
    return [...this.issues.values()].filter((i) => i.teamKey === teamKey && i.delegateId);
  }

  async search(term: string): Promise<SearchHit[]> {
    return [...this.issues.values()]
      .filter((i) => i.title.toLowerCase().includes(term.toLowerCase()))
      .map((i) => ({ identifier: i.identifier, title: i.title, url: i.url, stateName: i.stateName }));
  }

  async moveTo(identifier: string, stateName: string): Promise<void> {
    this.record('moveTo', identifier, stateName);
    this.must(identifier).stateName = stateName;
  }

  async setLabels(identifier: string, add: string[], remove: string[]): Promise<void> {
    this.record('setLabels', identifier, add, remove);
    const i = this.must(identifier);
    i.labels = [...new Set([...i.labels.filter((l) => !remove.includes(l)), ...add])];
  }

  async comment(identifier: string, body: string): Promise<void> {
    this.record('comment', identifier, body);
    this.must(identifier);
  }

  async activity(sessionId: string, a: ActivityInput): Promise<void> {
    this.record('activity', sessionId, a);
  }

  async addExternalUrl(sessionId: string, label: string, url: string): Promise<void> {
    this.record('addExternalUrl', sessionId, label, url);
  }

  async ensureSession(identifier: string): Promise<string> {
    this.record('ensureSession', identifier);
    this.must(identifier);
    return `fake-session-${++this.sessions}`;
  }
}
