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

/** A signed Linear delegation of REL-1 (session as-1), as Linear posts it. */
export function signedDelegation(): { raw: string; headers: Record<string, string> } {
  const raw = JSON.stringify({
    type: 'AgentSessionEvent',
    action: 'created',
    webhookTimestamp: NOW,
    agentSession: { id: 'as-1', issue: { id: 'u1', identifier: 'REL-1', title: 'Export CSV' }, comment: null, creator: { name: 'Lilian' } },
    promptContext: '<issue identifier="REL-1">Export CSV</issue>',
  });
  return { raw, headers: { 'linear-signature': createHmac('sha256', SECRET).update(raw).digest('hex') } };
}

/** The daemon's Linear ingestion for project `p` (team REL), writing through `accept`. */
export function linearIngest(accept: (e: FactoryEvent) => Promise<boolean>, acks: string[] = []) {
  return createLinearIngest({
    secret: () => SECRET,
    accept,
    ack: async (sessionId) => void acks.push(sessionId),
    log: () => {},
    ctx: {
      projectIdForTeam: (k) => (k === 'REL' ? 'p' : undefined),
      logicalFor: () => null,
      stateNameById: () => undefined,
      labelNameById: () => undefined,
      isEcho: () => false,
      commands: () => [],
      now: () => NOW,
    },
  });
}
