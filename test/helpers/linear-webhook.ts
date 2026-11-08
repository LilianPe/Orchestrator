import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLinearIngest, type DeliveryStore } from '../../src/adapters/tracker/linear/ingest.js';
import type { MapContext } from '../../src/adapters/tracker/linear/webhook.js';
import type { MessageClassifier } from '../../src/adapters/runner/message-classifier.js';
import type { FactoryEvent } from '../../src/core/types.js';

/**
 * Runs `crash-after-ack.ts` in a child process: the delegation is written to the inbox of
 * `target` (a SQLite file or a Postgres URL), then the process is killed with SIGKILL. Returns the
 * status the webhook was answered and how the process ended.
 */
export function crashAfterAck(target: string): { response: { status: number }; exited: { status: number | null; signal: string | null } } {
  const statusFile = join(mkdtempSync(join(tmpdir(), 'factory-crash-')), 'status.json');
  const root = join(import.meta.dirname, '../..');
  const child = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'test/helpers/crash-after-ack.ts'), target, statusFile], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  let response: { status: number };
  try {
    response = JSON.parse(readFileSync(statusFile, 'utf8')) as { status: number };
  } catch {
    throw new Error(`crash-after-ack wrote no status (exit ${child.status}, ${child.signal}): ${child.stderr}`);
  }
  return { response, exited: { status: child.status, signal: child.signal } };
}

const SECRET = 'inbox-test-secret';
const NOW = 1_000;

const sign = (body: unknown) => {
  const raw = JSON.stringify(body);
  return { raw, headers: { 'linear-signature': createHmac('sha256', SECRET).update(raw).digest('hex') } };
};

/** A signed Linear delegation of `identifier` (session as-1 unless named), as Linear posts it at `at`. */
export function signedDelegation(at = NOW, identifier = 'REL-1', sessionId = 'as-1'): { raw: string; headers: Record<string, string> } {
  return sign({
    type: 'AgentSessionEvent',
    action: 'created',
    webhookTimestamp: at,
    agentSession: { id: sessionId, issue: { id: 'u1', identifier, title: 'Export CSV' }, comment: null, creator: { id: 'user-lilian', name: 'Lilian' } },
    promptContext: '<issue identifier="REL-1">Export CSV</issue>',
  });
}

/** A signed mention of the agent in a comment of REL-1 (a question, new session `sessionId`), posted at `at`. */
export function signedMention(sessionId: string, body: string, at = NOW): { raw: string; headers: Record<string, string> } {
  return sign({
    type: 'AgentSessionEvent',
    action: 'created',
    webhookTimestamp: at,
    agentSession: { id: sessionId, issue: { id: 'u1', identifier: 'REL-1', title: 'Export CSV' }, comment: { id: `c-${sessionId}`, body, user: { id: 'user-lilian', name: 'Lilian' } } },
  });
}

/** A signed reply in session `sessionId` of REL-1, posted at `at`. */
export function signedReply(sessionId: string, body: string, at = NOW): { raw: string; headers: Record<string, string> } {
  return sign({
    type: 'AgentSessionEvent',
    action: 'prompted',
    webhookTimestamp: at,
    agentSession: { id: sessionId, issue: { id: 'u1', identifier: 'REL-1', title: 'Export CSV' } },
    agentActivity: { id: `aa-${sessionId}-${at}`, user: { id: 'user-lilian', name: 'Lilian' }, content: { type: 'prompt', body } },
  });
}

/**
 * The daemon's Linear ingestion for project `p` (team REL), writing through `accept`. `now` as the
 * daemon wires it: the clock (default 1000). `ctx`: what differs from that one project (the team's repos).
 */
export function linearIngest(accept: (e: FactoryEvent) => Promise<boolean>, opts: { now?: () => number; ctx?: Partial<MapContext>; classify?: MessageClassifier; deliveries?: DeliveryStore } = {}) {
  return createLinearIngest({
    ...(opts.classify ? { classify: opts.classify } : {}),
    ...(opts.deliveries ? { deliveries: opts.deliveries } : {}),
    secret: () => SECRET,
    accept,
    log: () => {},
    ctx: {
      projectsOfTeam: (k) => (k === 'REL' ? ['p'] : []),
      firstProject: () => 'p',
      labelsOf: async () => [],
      ticket: async () => undefined,
      logicalFor: () => null,
      stateNameById: () => undefined,
      stateTypeById: () => undefined,
      labelNameById: () => undefined,
      isEcho: () => false,
      commands: () => [],
      now: opts.now ?? (() => NOW),
      ...opts.ctx,
    },
  });
}

/**
 * A signed Linear update of REL-1 by Lilian, as Linear posts it at `at`: moved from Human Review (`s-hr`) to AI Review
 * (`s-ai`), the label `agent:reprendre` (`l-resume`) added beside `bug`. Map its ids with `ISSUE_UPDATE_CTX`.
 */
export function signedIssueUpdate(at = NOW): { raw: string; headers: Record<string, string> } {
  return sign({
    type: 'Issue',
    action: 'update',
    webhookTimestamp: at,
    actor: { id: 'user-lilian', type: 'user', name: 'Lilian' },
    data: { id: 'u1', updatedAt: new Date(at).toISOString(), identifier: 'REL-1', number: 1, team: { key: 'REL' }, stateId: 's-ai', state: { id: 's-ai', name: 'AI Review' }, labelIds: ['l-bug', 'l-resume'] },
    updatedFrom: { stateId: 's-hr', labelIds: ['l-bug'] },
  });
}

/** What the daemon reads of the team for `signedIssueUpdate`: its two states and its two labels. */
export const ISSUE_UPDATE_CTX: Partial<MapContext> = {
  logicalFor: (_p, name) => (({ 'Human Review': 'human_review', 'AI Review': 'ai_review' }) as const)[name as 'Human Review' | 'AI Review'] ?? null,
  stateNameById: (_t, id) => ({ 's-hr': 'Human Review', 's-ai': 'AI Review' })[id],
  stateTypeById: () => 'started',
  labelNameById: (_t, id) => ({ 'l-bug': 'bug', 'l-resume': 'agent:reprendre' })[id],
};
