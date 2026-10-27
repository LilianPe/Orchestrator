/**
 * A daemon killed after a decision's commit (ORC-149): the delegation of REL-1 is decided on the
 * `CRASH_WORKFLOW` rule (three effects: labels, comment, start_run), then the process kills itself
 * with SIGKILL right before it claims the outbox row number `<killAt>` (1: before any effect), or,
 * with `<killAt>` 0, inside the decision transaction, between `decide` and the COMMIT. With
 * `<killAt>` `acted:<n>` (ORC-150), it dies while executing row number `<n>`: after the effect
 * acted, before its row is settled, under a lease of `<leaseMs>`. The id of each row it completed
 * is appended to `<logFile>`.
 *
 *   node --import tsx test/helpers/crash-after-decision.ts <sqlite file | postgres://…> <killAt> <logFile> [leaseMs]
 */
import { appendFileSync } from 'node:fs';
import { PgStore } from '../../src/store/pg/pg-store.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import type { DecisionRequest, Store } from '../../src/store/types.js';
import { CRASH_WORKFLOW } from './crash-workflow.js';
import { createHarness } from './harness.js';

const [target, killAt, logFile, leaseMs] = process.argv.slice(2);
if (!target || !killAt || !logFile) throw new Error('usage: crash-after-decision.ts <store> <killAt> <logFile>');
const inner: Store = target.startsWith('postgres') ? new PgStore({ connectionString: target }) : new SqliteStore(target);
let claims = 0;
let settled = 0;
const actedAt = killAt.startsWith('acted:') ? Number(killAt.slice('acted:'.length)) : undefined;
const store = Object.assign(Object.create(inner) as Store, {
  decide: (req: DecisionRequest) =>
    inner.decide({
      ...req,
      decide: (ticket, workflow) => {
        const plan = req.decide(ticket, workflow);
        if (Number(killAt) === 0) process.kill(process.pid, 'SIGKILL');
        return plan;
      },
    }),
  claimEffect: async (projectId: string, ticketId: string | undefined, leaseMs: number) => {
    const pending = (await inner.listEffects(projectId, ticketId)).some((r) => r.status === 'pending');
    if (pending && ++claims === Number(killAt)) process.kill(process.pid, 'SIGKILL');
    return inner.claimEffect(projectId, ticketId, leaseMs);
  },
  completeEffect: async (id: string, lease?: string, at?: number) => {
    if (++settled === actedAt) process.kill(process.pid, 'SIGKILL');
    const done = await inner.completeEffect(id, lease, at);
    appendFileSync(logFile, `${id}\n`);
    return done;
  },
});
const h = createHarness({ store, projectYaml: CRASH_WORKFLOW, effectLeaseMs: leaseMs ? Number(leaseMs) : undefined });
h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
// Not reached: the process is killed while the worker executes the effects.
process.exit(0);
