// Option A of the ORC-129 spike: homegrown inbox + journal + projection + outbox on Postgres.
// Throwaway prototype. Usage: node main.ts setup | send <n> | worker | status | replay
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { decide, effectId, type EngineEvent, type TicketState } from '../shared/decide.ts';
import { delegated, runEffect } from '../shared/effects.ts';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const LEASE = '5 seconds';
const log = (...a: unknown[]) => console.log(`[maison ${process.pid}]`, ...a);

const SCHEMA = `
create table inbox   (id text primary key, ticket text not null, event jsonb not null,
                      received_at timestamptz not null default now(), processed_at timestamptz);
create table journal (ticket text not null, seq int not null, event_id text not null unique, event jsonb not null,
                      decision jsonb not null, primary key (ticket, seq));
create table tickets (id text primary key, seq int not null, state jsonb);
create table outbox  (id text primary key, ticket text not null, effect jsonb not null,
                      status text not null default 'pending', attempts int not null default 0,
                      lease_until timestamptz, next_at timestamptz not null default now(), result jsonb);`;

async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

/** Inbox write: what the webhook route (ORC-147) and the executors do before anything else. */
async function append(c: pg.ClientBase | pg.Pool, e: EngineEvent): Promise<boolean> {
  const r = await c.query('insert into inbox (id, ticket, event) values ($1, $2, $3) on conflict do nothing', [e.id, e.ticket, e]);
  return r.rowCount === 1;
}

/**
 * Decision transaction (ORC-149): lock the ticket, then take its oldest unprocessed event, decide,
 * write journal + projection + outbox, mark the inbox row. Locking the ticket before picking the row
 * keeps per-ticket order with several workers (only one worker runs in the spike).
 */
async function decideNext(): Promise<boolean> {
  return tx(async (c) => {
    const pending = await c.query(
      'select ticket from inbox where processed_at is null group by ticket order by min(received_at)',
    );
    let row;
    for (const { ticket } of pending.rows) {
      const lock = await c.query('select pg_try_advisory_xact_lock(hashtext($1)) as ok', [ticket]);
      if (!lock.rows[0].ok) continue;
      row = (
        await c.query(
          'select id, ticket, event from inbox where ticket = $1 and processed_at is null order by received_at, id limit 1',
          [ticket],
        )
      ).rows[0];
      if (row) break;
    }
    if (!row) return false;
    const { id, ticket, event } = row;
    const t = await c.query('select seq, state from tickets where id = $1', [ticket]);
    const seq = (t.rows[0]?.seq ?? 0) + 1;
    const state: TicketState | undefined = t.rows[0]?.state ?? undefined;
    const decision = decide(state, event);
    const effects = decision.effects.map((effect, i) => ({ id: effectId(ticket, seq, i), effect }));
    await c.query('insert into journal (ticket, seq, event_id, event, decision) values ($1, $2, $3, $4, $5)', [
      ticket, seq, id, event, { state: decision.state ?? null, effects },
    ]);
    await c.query(
      'insert into tickets (id, seq, state) values ($1, $2, $3) on conflict (id) do update set seq = $2, state = $3',
      [ticket, seq, decision.state ?? null],
    );
    for (const e of effects) await c.query('insert into outbox (id, ticket, effect) values ($1, $2, $3)', [e.id, ticket, e.effect]);
    await c.query('update inbox set processed_at = now() where id = $1', [id]);
    log(`decided ${id} -> seq ${seq}, ${effects.length} effect(s)`);
    return true;
  });
}

/** Outbox executor (ORC-150): claim with SKIP LOCKED + lease, run outside any transaction, return the result through the inbox. */
async function executeNext(): Promise<boolean> {
  const { rows } = await pool.query(
    `update outbox set attempts = attempts + 1, lease_until = now() + interval '${LEASE}'
       where id = (select id from outbox
                    where status = 'pending' and next_at <= now() and (lease_until is null or lease_until < now())
                    order by id limit 1 for update skip locked)
     returning id, ticket, effect, attempts`,
  );
  if (!rows[0]) return false;
  const { id, ticket, effect, attempts } = rows[0];
  log(`executing ${id} (attempt ${attempts})`);
  try {
    const result = await runEffect(id, effect);
    await tx(async (c) => {
      await c.query("update outbox set status = 'done', result = $2, lease_until = null where id = $1", [id, result]);
      await append(c, { id: `effect:${id}`, ticket, type: 'effect.done', payload: { effectId: id, result } });
    });
    log(`effect ${id} done -> ${result.commentId}`);
  } catch (err) {
    const backoffMs = 1000 * 2 ** (attempts - 1);
    await pool.query(
      `update outbox set lease_until = null, next_at = now() + make_interval(secs => $2) where id = $1`,
      [id, backoffMs / 1000],
    );
    log(`effect ${id} failed (${(err as Error).message}), retry in ${backoffMs} ms`);
  }
  return true;
}

async function worker(): Promise<never> {
  log('worker up');
  for (;;) {
    const busy = (await decideNext()) || (await executeNext());
    if (!busy) await new Promise((r) => setTimeout(r, 200));
  }
}

/** Replays the journal through decide and compares each decision with the recorded one. */
async function replay(): Promise<void> {
  const { rows } = await pool.query('select ticket, seq, event, decision from journal order by ticket, seq');
  const states = new Map<string, TicketState | undefined>();
  let mismatches = 0;
  for (const r of rows) {
    const d = decide(states.get(r.ticket), r.event);
    const effects = d.effects.map((effect, i) => ({ id: effectId(r.ticket, r.seq, i), effect }));
    const same = isDeepStrictEqual({ state: d.state ?? null, effects }, r.decision);
    if (!same) mismatches++;
    console.log(`${same ? 'identique' : 'ÉCART'}  ${r.ticket}#${r.seq}  ${r.event.id}`);
    states.set(r.ticket, d.state);
  }
  console.log(`rejeu : ${rows.length} décision(s), ${mismatches} écart(s)`);
}

async function status(): Promise<void> {
  const t = await pool.query('select id, seq, state from tickets');
  const o = await pool.query('select id, status, attempts, result from outbox order by id');
  const i = await pool.query('select id, processed_at is not null as processed from inbox order by received_at, id');
  console.log(JSON.stringify({ tickets: t.rows, outbox: o.rows, inbox: i.rows }, null, 1));
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'setup') await pool.query(SCHEMA);
else if (cmd === 'send') log(`inbox write ${delegated(Number(arg)).id}:`, (await append(pool, delegated(Number(arg)))) ? 'inserted' : 'duplicate, ignored');
else if (cmd === 'worker') await worker();
else if (cmd === 'replay') await replay();
else if (cmd === 'status') await status();
else if (cmd === 'done') process.exitCode = (await pool.query("select 1 from tickets where state->>'status' = 'done'")).rowCount ? 0 : 1;
else throw new Error(`unknown command ${cmd}`);
await pool.end();
