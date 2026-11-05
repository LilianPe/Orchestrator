/**
 * The daemon the chaos test kills (ORC-163): the orchestrator, its worker, its outbox executor and
 * its timers on a real store (Postgres, or a SQLite file), with the fake adapters of the harness,
 * started as `factory up` starts it (`recover`, the timers, the tick, the heartbeat, the worker's
 * poll). Its runs die with it, as containers lost: each life starts their steps again. The driver (`chaos.test.ts`) talks to it over IPC:
 *
 * - `{ type: 'event', event }`: accepted (written to the inbox), then answered `{ type: 'ack', id }`,
 *   as a webhook is answered 200; `{ type: 'nack', id }` if the write failed;
 * - `{ type: 'clock', now }`: the simulated time the driver reached (leases, backoffs, timers).
 *
 * Each visible call to the fake tracker and runner is appended to `<calls>` (JSON lines) as it acts,
 * attributed to the outbox row being executed (`faults.ts`): the file outlives the process, so the
 * driver sees every effect any life made, the one cut by SIGKILL included. The same file is the
 * memory of the fake Linear: a life starts with the comments, activities, links, labels and statuses
 * the earlier lives wrote, as the real Linear keeps them across a restart of the daemon, so that a
 * replayed effect finds what its first execution wrote (ORC-162).
 *
 *   node --import tsx test/chaos/daemon.ts <sqlite file | postgres://…> <calls> <life> <now> <tickets>
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { FakeClock } from '../../src/core/clock.js';
import type { FactoryEvent } from '../../src/core/types.js';
import type { FakeTracker } from '../../src/adapters/tracker/fake.js';
import { TimerService } from '../../src/runtime/timers.js';
import { Faults, type VisibleCall } from '../helpers/faults.js';
import { CRASH_WORKFLOW } from '../helpers/crash-workflow.js';
import { createHarness } from '../helpers/harness.js';
import { storeAt } from '../helpers/store-at.js';
import { CHAOS_LEASE_MS, CHAOS_MEMBER, ticketIds, type ChaosMessage, type DaemonMessage } from './events.js';

const [target, callsFile, life, now, tickets] = process.argv.slice(2);
if (!target || !callsFile || !life || !now || !tickets) throw new Error('usage: daemon.ts <store> <calls> <life> <now> <tickets>');

const send = (m: DaemonMessage): void => void process.send?.(m);
const clock = new FakeClock(Number(now));
const store = storeAt(target, { now: () => clock.now(), max: 4 });
const faults = new Faults(undefined, (call) => appendFileSync(callsFile, `${JSON.stringify({ ...call, life: Number(life) })}\n`));
const h = createHarness({
  store,
  clock,
  faults,
  // A delegation labels, comments and starts the run: a comment posted twice is the double the chaos looks for.
  projectYaml: CRASH_WORKFLOW,
  effectLeaseMs: CHAOS_LEASE_MS,
  processRetry: { attempts: 5, baseMs: 20 },
  effectRetry: { attempts: 8, baseMs: 10, capMs: 100 },
  // The matrix is checked on each event's signed actor (ORC-186): its refusals go through the outbox too.
  authz: { githubLogins: { [CHAOS_MEMBER]: 'dev-gh' } },
});
h.tracker.setTeamMembers('REL', [CHAOS_MEMBER]);
h.forge.setRepoPermission('dev-gh', 'write');
for (const id of ticketIds(Number(tickets))) h.tracker.addIssue({ identifier: id, title: `Ticket ${id}` });
/** The tracker writes of the earlier lives, played again on this life's fake (the raw one: not recorded again). */
const REMEMBERED = new Set(['comment', 'activity', 'addExternalUrl', 'setLabels', 'moveTo']);
if (existsSync(callsFile)) {
  for (const line of readFileSync(callsFile, 'utf8').split('\n')) {
    if (!line) continue;
    const call = JSON.parse(line) as VisibleCall;
    if (!REMEMBERED.has(call.method)) continue;
    const write = h.tracker[call.method as keyof FakeTracker] as (...args: unknown[]) => Promise<unknown>;
    await write.apply(h.tracker, JSON.parse(call.detail) as unknown[]);
  }
}
// Runs that last a few tens of milliseconds, or up to CHAOS_RUN_MS, so that kills cut some of them; no
// text from them: the relay posts nothing, and each visible activity is an effect's.
const RUN_MS = Number(process.env['CHAOS_RUN_MS'] ?? 150);
h.runner.enqueue(...Array.from({ length: 10_000 }, () => ({ events: [], hold: true })));
const start = h.runner.start.bind(h.runner);
h.runner.start = (req) => {
  const handle = start(req);
  setTimeout(() => h.runner.release(req.runId), 10 + Math.random() * RUN_MS);
  return handle;
};

process.on('message', (m: ChaosMessage) => {
  if (m.type === 'clock') {
    clock.set(Math.max(clock.now(), m.now));
    h.runner.tick();
    return;
  }
  h.orch.accept({ ...m.event, at: clock.now() } as FactoryEvent).then(
    () => send({ type: 'ack', id: m.event.id }),
    () => send({ type: 'nack', id: m.event.id }),
  );
});

const log = (message: string): void => void process.stderr.write(`chaos daemon ${life}: ${message}\n`);
await h.orch.recover();
const timers = new TimerService(h.store, clock, () => h.orch.wake(), (err) => log(`timers: ${err.message}`));
timers.start(20);
setInterval(() => void h.orch.tick(), 50);
setInterval(() => h.orch.supervise().catch((err: Error) => log(`heartbeat: ${err.message}`)), 50);
await h.orch.startWorker(20);
send({ type: 'ready' });
