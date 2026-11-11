import type { PlanStep } from '../core/session-plan.js';
import type { ActivityInput, IssueHistory, SearchHit, Tracker, TrackerIssue } from '../adapters/tracker/types.js';

export class TrackerSwitch implements Tracker {
  current: Tracker | undefined;

  constructor(private port: number) {}

  set(t: Tracker): void {
    this.current = t;
  }

  private t(): Tracker {
    if (!this.current) throw new Error(`Linear not connected: open http://localhost:${this.port}/oauth/start`);
    return this.current;
  }

  getIssue(id: string): Promise<TrackerIssue> { return Promise.resolve().then(() => this.t().getIssue(id)); }
  history(id: string): Promise<IssueHistory> { return Promise.resolve().then(() => this.t().history(id)); }
  listDelegated(k: string): Promise<TrackerIssue[]> { return Promise.resolve().then(() => this.t().listDelegated(k)); }
  search(q: string, k: string): Promise<SearchHit[]> { return Promise.resolve().then(() => this.t().search(q, k)); }
  moveTo(id: string, s: string): Promise<void> { return Promise.resolve().then(() => this.t().moveTo(id, s)); }
  setLabels(id: string, a: string[], r: string[]): Promise<void> { return Promise.resolve().then(() => this.t().setLabels(id, a, r)); }
  comment(id: string, b: string, e?: string): Promise<void> { return Promise.resolve().then(() => this.t().comment(id, b, e)); }
  findComment(id: string, e: string): Promise<string | undefined> { return Promise.resolve().then(() => this.t().findComment(id, e)); }
  activity(s: string, a: ActivityInput, e?: string): Promise<void> { return Promise.resolve().then(() => this.t().activity(s, a, e)); }
  findActivity(s: string, e: string): Promise<string | undefined> { return Promise.resolve().then(() => this.t().findActivity(s, e)); }
  addExternalUrl(s: string, l: string, u: string): Promise<void> { return Promise.resolve().then(() => this.t().addExternalUrl(s, l, u)); }
  ensureSession(id: string): Promise<string> { return Promise.resolve().then(() => this.t().ensureSession(id)); }
  setSessionPlan(s: string, plan: readonly PlanStep[]): Promise<void> { return Promise.resolve().then(() => this.t().setSessionPlan(s, plan)); }
}
