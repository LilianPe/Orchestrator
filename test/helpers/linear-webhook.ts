import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLinearIngest } from '../../src/adapters/tracker/linear/ingest.js';
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

/** A signed Linear delegation of REL-1 (session as-1), as Linear posts it at `at`. */
export function signedDelegation(at = NOW): { raw: string; headers: Record<string, string> } {
  return sign({
    type: 'AgentSessionEvent',
    action: 'created',
    webhookTimestamp: at,
    agentSession: { id: 'as-1', issue: { id: 'u1', identifier: 'REL-1', title: 'Export CSV' }, comment: null, creator: { id: 'user-lilian', name: 'Lilian' } },
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

/**
 * The daemon's Linear ingestion for project `p` (team REL), writing through `accept`. `acked` and
 * `now` as the daemon wires them: what follows a posted ack (the daemon records its time), the
 * clock (default 1000).
 */
export function linearIngest(
  accept: (e: FactoryEvent) => Promise<boolean>,
  acks: string[] = [],
  opts: { acked?: (eventId: string) => Promise<void>; now?: () => number } = {},
) {
  return createLinearIngest({
    secret: () => SECRET,
    accept,
    ack: async (sessionId, eventId) => {
      acks.push(sessionId);
      await opts.acked?.(eventId);
    },
    log: () => {},
    ctx: {
      projectIdForTeam: (k) => (k === 'REL' ? 'p' : undefined),
      logicalFor: () => null,
      stateNameById: () => undefined,
      labelNameById: () => undefined,
      isEcho: () => false,
      commands: () => [],
      now: opts.now ?? (() => NOW),
    },
  });
}
