export interface TrackerIssue {
  identifier: string;
  title: string;
  description: string;
  url: string;
  stateName: string;
  stateType: string;
  labels: string[];
  delegateId?: string;
  teamKey: string;
  priority: number;
  createdAt: number;
}

export type ActivityInput =
  | { type: 'thought' | 'response' | 'elicitation' | 'error'; body: string; ephemeral?: boolean }
  | { type: 'action'; action: string; parameter: string; result?: string; ephemeral?: boolean };

export interface SearchHit {
  identifier: string;
  title: string;
  url: string;
  stateName: string;
}

export interface Tracker {
  getIssue(identifier: string): Promise<TrackerIssue>;
  listDelegated(teamKey: string): Promise<TrackerIssue[]>;
  search(term: string): Promise<SearchHit[]>;
  moveTo(identifier: string, stateName: string): Promise<void>;
  setLabels(identifier: string, add: string[], remove: string[]): Promise<void>;
  comment(identifier: string, body: string): Promise<void>;
  activity(sessionId: string, a: ActivityInput): Promise<void>;
  addExternalUrl(sessionId: string, label: string, url: string): Promise<void>;
  ensureSession(identifier: string): Promise<string>;
}
