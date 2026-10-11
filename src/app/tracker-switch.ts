import type { ActivityInput, SearchHit, Tracker, TrackerIssue } from '../adapters/tracker/types.js';

export class TrackerSwitch implements Tracker {
  current: Tracker | undefined;

  constructor(private port: number) {}

  set(t: Tracker): void {
    this.current = t;
  }

  private t(): Tracker {
    if (!this.current) throw new Error(`Linear non connecté : ouvrez http://localhost:${this.port}/oauth/start`);
    return this.current;
  }

  getIssue(id: string): Promise<TrackerIssue> { return Promise.resolve().then(() => this.t().getIssue(id)); }
  listDelegated(k: string): Promise<TrackerIssue[]> { return Promise.resolve().then(() => this.t().listDelegated(k)); }
  search(q: string): Promise<SearchHit[]> { return Promise.resolve().then(() => this.t().search(q)); }
  moveTo(id: string, s: string): Promise<void> { return Promise.resolve().then(() => this.t().moveTo(id, s)); }
  setLabels(id: string, a: string[], r: string[]): Promise<void> { return Promise.resolve().then(() => this.t().setLabels(id, a, r)); }
  comment(id: string, b: string): Promise<void> { return Promise.resolve().then(() => this.t().comment(id, b)); }
  activity(s: string, a: ActivityInput): Promise<void> { return Promise.resolve().then(() => this.t().activity(s, a)); }
  addExternalUrl(s: string, l: string, u: string): Promise<void> { return Promise.resolve().then(() => this.t().addExternalUrl(s, l, u)); }
  ensureSession(id: string): Promise<string> { return Promise.resolve().then(() => this.t().ensureSession(id)); }
}
