import type { PlanStep } from '../../core/session-plan.js';

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
  /** When Linear last changed the issue, when read: orders what the factory reads of its labels (ORC-185). */
  updatedAt?: number;
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

/** The marker a comment written for an outbox effect carries in its body (ORC-162): invisible once rendered. */
export function effectMarker(effectId: string): string {
  return `<!-- factory:effect=${effectId} -->`;
}

/** The echo key of a status the factory itself moved the ticket to (`putEcho`), for the webhook of its own move to be dropped. */
export function stateEchoKey(identifier: string, stateName: string): string {
  return `state:${identifier}:${stateName}`;
}

/** The echo key of a label the factory itself added or took off (`putEcho`), for the webhook of its own write to be dropped. */
export function labelEchoKey(identifier: string, label: string, change: 'added' | 'removed'): string {
  return change === 'added' ? `label:${identifier}:${label}` : `label-removed:${identifier}:${label}`;
}

/** The tracker has no such issue (deleted, or never existed): an answer about the issue, unlike a read error. */
export class IssueNotFoundError extends Error {}

/**
 * Writes are keyed by the outbox effect id (`ticket:seq:i`) when they come from an effect (ORC-162):
 * an effect replayed after it acted looks for what its first execution wrote before writing again
 * (`findComment`, `findActivity`), and the writes that set a final state (`moveTo`, `setLabels`,
 * `addExternalUrl`) do nothing when it is already there. See docs/idempotence.md.
 */
export interface Tracker {
  getIssue(identifier: string): Promise<TrackerIssue>;
  listDelegated(teamKey: string): Promise<TrackerIssue[]>;
  search(term: string): Promise<SearchHit[]>;
  moveTo(identifier: string, stateName: string): Promise<void>;
  /** Final state: adds `add`, takes off `remove`; writes nothing when the ticket already reads so. */
  setLabels(identifier: string, add: string[], remove: string[]): Promise<void>;
  /** With `effectId`, the comment carries `effectMarker(effectId)`, for `findComment` to find it. */
  comment(identifier: string, body: string, effectId?: string): Promise<void>;
  /** The id of the ticket's comment written for `effectId`, if there is one. */
  findComment(identifier: string, effectId: string): Promise<string | undefined>;
  /** With `effectId`, the activity is written under an id derived from it, for `findActivity` to find it. */
  activity(sessionId: string, a: ActivityInput, effectId?: string): Promise<void>;
  /** The id of the session's activity written for `effectId`, if there is one. */
  findActivity(sessionId: string, effectId: string): Promise<string | undefined>;
  /** Adds the link to the session; nothing when the session already has this URL. */
  addExternalUrl(sessionId: string, label: string, url: string): Promise<void>;
  ensureSession(identifier: string): Promise<string>;
  /** Final state: the session's plan is `plan`, whole (Linear replaces it at each update). */
  setSessionPlan(sessionId: string, plan: readonly PlanStep[]): Promise<void>;
}
