import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { CUT_BOUND_REASON } from '../../src/core/engine.js';
import { migratePgStore } from '../../src/store/pg/migrate.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import { allEffects, checkChain, settled, type VisibleCall } from '../helpers/faults.js';
import { createTestDatabase, PG_URL } from '../helpers/pg-database.js';
import { storeAt } from '../helpers/store-at.js';
import { CHAOS_LEASE_MS, chaosEvents, rng, ticketIds, type ChaosEvent, type ChaosMessage, type DaemonMessage } from './events.js';

/**
 * ORC-163: a real daemon process (`daemon.ts`) killed with SIGKILL at random moments while a driver
 * sends it events from Linear, restarted on the same database each time. At the end: no acknowledged
 * event lost or decided twice, nothing left in the inbox or the outbox, every ticket's journal
 * replayed bit for bit, and no visible effect doubled. On Postgres when DATABASE_URL is set, on a
 * SQLite file otherwise. Unlike the harness's `mortal`, the kill is the kernel's: a transaction under
 * way at the kill is rolled back by the database, never committed.
 *
 * CHAOS_EVENTS (100 by default, 500 in the CI's chaos job), CHAOS_SEED, CHAOS_TICKETS, CHAOS_RUN_MS (the runs'
 * longest duration: longer, the kills cut more of them and more steps start again, ORC-220). A failure
 * prints its seed: CHAOS_SEED=<seed> plays the same events and the same kill delays again (the
 * moments they land on in the processing still depend on the machine).
 */
const EVENTS = Number(process.env['CHAOS_EVENTS'] ?? 100);
const SEED = Number(process.env['CHAOS_SEED'] ?? Date.now() % 100_000);
const TICKETS = Number(process.env['CHAOS_TICKETS'] ?? 20);
/**
 * The visible doubles of the outbox's at least once (an effect cut after it acted runs again) fail
 * the run since each effect is idempotent (ORC-162); CHAOS_STRICT_EFFECTS=0 only prints them. A run
 * launched twice for one outbox row, a question's included (ORC-277), is a violation either way.
 */
const STRICT_EFFECTS = process.env['CHAOS_STRICT_EFFECTS'] !== '0';
/** Events sent and not answered yet, at most: several in flight, as webhooks arrive. */
const WINDOW = 8;
/** Delay between a daemon's start and its kill, drawn in this range (wall clock). */
const KILL_MS = [150, 1_500] as const;
/** Kills in all: one per ten events, at least three. */
const KILLS = Math.max(3, Math.ceil(EVENTS / 10));
/** Mean gap between two events sent (wall clock): faster than the daemon processes them. */
const SEND_MS = 10;
/** The simulated time that passes for each answered event (debounces of 3 min fire along the way). */
const STEP_MS = 4_000;

const root = join(import.meta.dirname, '../..');

class Daemon {
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly ready: Promise<void>;
  private child: ChildProcess;
  stderr = '';

  constructor(target: string, calls: string, life: number, now: number, onMessage: (m: DaemonMessage) => void) {
    this.child = fork(join(root, 'test/chaos/daemon.ts'), [target, calls, String(life), String(now), String(TICKETS)], {
      cwd: root,
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.child.stderr?.on('data', (d: Buffer) => void (this.stderr += d.toString()));
    this.exited = new Promise((resolve) => this.child.once('exit', (code, signal) => resolve({ code, signal })));
    this.ready = new Promise((resolve, reject) => {
      this.child.on('message', (m: DaemonMessage) => {
        if (m.type === 'ready') resolve();
        else onMessage(m);
      });
      void this.exited.then(({ code, signal }) => reject(new Error(`daemon ${life} exited before it was ready (${code ?? signal}): ${this.stderr}`)));
    });
  }

  send(m: ChaosMessage): void {
    if (this.child.connected) this.child.send(m, (err) => void err);
  }

  /** `kill -9`: TerminateProcess on Windows. */
  kill(): void {
    this.child.kill('SIGKILL');
  }
}

/** Every visible call the daemons appended, whichever of them died after. */
function readCalls(file: string): VisibleCall[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as VisibleCall);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('chaos: kill -9 at random moments (ORC-163)', () => {
  it(`${EVENTS} events on ${PG_URL ? 'Postgres' : 'a SQLite file'}, seed ${SEED}: nothing lost, nothing doubled`, { timeout: 30 * 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-chaos-'));
    const calls = join(dir, 'calls.jsonl');
    let target: string;
    let drop = async () => {};
    if (PG_URL) {
      const db = await createTestDatabase('factory_chaos');
      const pool = new Pool({ connectionString: db.url, max: 1 });
      await migratePgStore(pool).finally(() => pool.end());
      target = db.url;
      drop = () => db.drop();
    } else {
      target = join(dir, 'factory.db');
      await new SqliteStore(target).close();
    }

    // One stream each: how many send gaps are drawn before a kill depends on the machine's timing.
    const events = chaosEvents(rng(SEED), EVENTS, TICKETS);
    const killDelay = rng(SEED + 1);
    const sendGap = rng(SEED + 2);
    const acked = new Set<string>();
    const inFlight = new Map<string, ChaosEvent>();
    let now = Date.UTC(2026, 9, 10, 9, 0);
    let cursor = 0;
    let life = 0;
    let kills = 0;
    let resent = 0;
    let wake: () => void = () => {};
    let daemon: Daemon | undefined;
    const onMessage = (m: DaemonMessage) => {
      if (m.type === 'ack' && inFlight.delete(m.id)) {
        acked.add(m.id);
        now += STEP_MS;
        daemon?.send({ type: 'clock', now });
      } else if (m.type === 'nack') {
        const e = inFlight.get(m.id);
        if (e) daemon?.send({ type: 'event', event: e });
      }
      wake();
    };
    const start = async (): Promise<Daemon> => {
      const d = new Daemon(target, calls, life++, now, onMessage);
      await d.ready;
      return d;
    };

    daemon = await start();
    try {
      // Events sent at a random pace, faster than they are processed, and the daemon killed at a
      // random moment after each start: while it answers, decides, executes, fires timers.
      while (acked.size < EVENTS || kills < KILLS) {
        const current = daemon;
        const killAt = Date.now() + KILL_MS[0] + killDelay() * (KILL_MS[1] - KILL_MS[0]);
        let died = false;
        void current.exited.then(() => {
          died = true;
          wake();
        });
        // Not answered yet: sent again, as Linear resends a webhook not answered 200.
        for (const e of inFlight.values()) {
          current.send({ type: 'event', event: e });
          resent++;
        }
        let sendAt = Date.now();
        while (!died && Date.now() < killAt) {
          if (Date.now() >= sendAt && inFlight.size < WINDOW && cursor < events.length) {
            const e = events[cursor++]!;
            inFlight.set(e.id, e);
            current.send({ type: 'event', event: e });
            sendAt = Date.now() + sendGap() * 2 * SEND_MS;
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.max(1, Math.min(killAt, sendAt) - Date.now()));
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
        if (!died) {
          current.kill();
          kills++;
        }
        const exit = await current.exited;
        if (exit.signal === null) throw new Error(`seed ${SEED}: daemon ${life - 1} died by itself (exit ${exit.code}): ${current.stderr}`);
        // The dead daemon's claims expire on the simulated clock before the next one looks.
        now += CHAOS_LEASE_MS + 1;
        daemon = await start();
      }

      // No more kills: the last daemon settles everything, the clock moving past debounces and leases.
      const store = storeAt(target, { max: 2 });
      try {
        for (let i = 0; i < 300 && !(await settled(store, 'p', ticketIds(TICKETS))); i++) {
          now += CHAOS_LEASE_MS;
          daemon.send({ type: 'clock', now });
          await sleep(100);
        }
        daemon.kill();
        await daemon.exited;
        const report = await checkChain(store, { projectId: 'p', tickets: ticketIds(TICKETS), acked, calls: readCalls(calls) });
        // What the kills cut: effects taken up again by the next daemon, runs settled by its recover().
        const effects = await allEffects(store, 'p', ticketIds(TICKETS));
        const retaken = effects.filter((r) => r.attempts > 1).length;
        const cutRuns = (await store.runsByStatus('failure')).length;
        const relaunches = effects.filter((r) => r.effect.kind === 'start_run' && r.effect.relaunchOf).length;
        // A normal outcome, not a violation: a ticket cut too often waits for a human, and the chain holds all the same.
        const bound = effects.filter((r) => r.effect.kind === 'activity' && CUT_BOUND_REASON.test(r.effect.body)).length;
        const summary = `seed ${SEED}: ${EVENTS} events, ${kills} kill(s), ${life} daemon(s), ${resent} event(s) sent again, ${retaken} of ${effects.length} effect(s) taken up again, ${cutRuns} run(s) cut, ${relaunches} step(s) started again, ${bound} block(s) by the bound of the relaunches`;
        console.log(`chaos ${summary}; at-least-once doubles: ${report.atLeastOnce.length}${report.atLeastOnce.map((l) => `\n  ${l}`).join('')}`);
        expect(kills, summary).toBeGreaterThan(0);
        expect(acked.size, summary).toBe(EVENTS);
        expect(report.violations, summary).toEqual([]);
        if (STRICT_EFFECTS) expect(report.atLeastOnce, summary).toEqual([]);
      } finally {
        await store.close();
      }
    } finally {
      daemon.kill();
      await daemon.exited;
      await drop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
