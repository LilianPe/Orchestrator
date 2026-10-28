/**
 * The daemon the chaos test kills (ORC-163): the orchestrator, its worker, its outbox executor and
 * its timers on a real store (Postgres, or a SQLite file), with the fake adapters of the harness,
 * started as `factory up` starts it (`recover`, the recovery notices, the timers, the tick, the
 * worker's poll). The driver (`chaos.test.ts`) talks to it over IPC:
 *
 * - `{ type: 'event', event }`: accepted (written to the inbox), then answered `{ type: 'ack', id }`,
 *   as a webhook is answered 200; `{ type: 'nack', id }` if the write failed;
 * - `{ type: 'clock', now }`: the simulated time the driver reached (leases, backoffs, timers).
 *
 * Each visible call to the fake tracker and runner is appended to `<calls>` (JSON lines) as it acts,
 * attributed to the outbox row being executed (`faults.ts`): the file outlives the process, so the
 * driver sees every effect any life made, the one cut by SIGKILL included.
 *
 *   node --import tsx test/chaos/daemon.ts <sqlite file | postgres://…> <calls> <life> <now> <tickets>
 */
import { appendFileSync } from 'node:fs';
import { FakeClock } from '../../src/core/clock.js';
import type { FactoryEvent } from '../../src/core/types.js';
import { TimerService } from '../../src/runtime/timers.js';
import { Faults } from '../helpers/faults.js';
import { CRASH_WORKFLOW } from '../helpers/crash-workflow.js';
import { createHarness } from '../helpers/harness.js';
import { storeAt } from '../helpers/store-at.js';
import { CHAOS_LEASE_MS, ticketIds, type ChaosMessage, type DaemonMessage } from './events.js';

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
});
for (const id of ticketIds(Number(tickets))) h.tracker.addIssue({ identifier: id, title: `Ticket ${id}` });
// Runs that last a few tens of milliseconds, so that kills cut some of them; no text from them: the
// relay posts nothing, and each visible activity is an effect's.
h.runner.enqueue(...Array.from({ length: 10_000 }, () => ({ events: [], hold: true })));
const start = h.runner.start.bind(h.runner);
h.runner.start = (req) => {
  const handle = start(req);
  setTimeout(() => h.runner.release(req.runId), 10 + Math.random() * 150);
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
await h.orch.announceRecovery();
await h.orch.startWorker(20);
send({ type: 'ready' });
