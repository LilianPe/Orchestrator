import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A delegation decides three effects, in this order: labels, comment, start_run (ORC-149 crash tests). */
export const CRASH_WORKFLOW = `
version: 1
on:
  ticket.delegated:
    - { when: "state in [todo, dev] && !blocked", labels: { add: ["agent:pris"], remove: [] }, comment: "Pris en charge.", run: dev }
`;

/**
 * Runs `crash-after-decision.ts` in a child process on `target` (a SQLite file or a Postgres URL),
 * killed before it claims outbox row number `killAt` (0: inside the decision transaction), or with
 * `acted:<n>`, after row `n` acted and before it is settled, under a lease of `leaseMs`. Returns how
 * it ended and the ids of the rows it completed before dying.
 */
export function crashAfterDecision(
  target: string,
  killAt: number | `acted:${number}`,
  leaseMs?: number,
): { exited: { status: number | null; signal: string | null }; completed: string[] } {
  const logFile = join(mkdtempSync(join(tmpdir(), 'factory-decision-')), 'completed.log');
  const root = join(import.meta.dirname, '../..');
  const child = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'test/helpers/crash-after-decision.ts'), target, String(killAt), logFile, ...(leaseMs === undefined ? [] : [String(leaseMs)])], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (child.error) throw child.error;
  const completed = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [];
  if (child.status === 0 && child.signal === null) throw new Error(`crash-after-decision was not killed: ${child.stderr}`);
  return { exited: { status: child.status, signal: child.signal }, completed };
}
