// Option B of the ORC-129 spike: DBOS Transact 5.3.0, functional API (no decorators).
// One durable workflow per event: a DBOS transaction runs decide and writes journal + projection,
// each effect is a DBOS step, its result re-enters as a new workflow keyed `effect:<id>`.
// Throwaway prototype. Usage: node main.ts setup | send <n> | worker | status | replay
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk';
import { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { decide, effectId, type EngineEvent, type TicketState } from '../shared/decide.ts';
import { delegated, runEffect } from '../shared/effects.ts';

const url = process.env.DATABASE_URL!;
const QUEUE = 'tickets';
const log = (...a: unknown[]) => console.log(`[dbos ${process.pid}]`, ...a);

const SCHEMA = `
create table journal (ticket text not null, seq int not null, event_id text not null unique, event jsonb not null,
                      decision jsonb not null, primary key (ticket, seq));
create table tickets (id text primary key, seq int not null, state jsonb);`;

const app = new NodePostgresDataSource('app', { connectionString: url });

// The DBOS transaction is the impure shell: it reads the projection, calls the pure decide,
// and writes journal + projection; DBOS records its output in the same transaction.
const decideTx = app.registerTransaction(
  async (event: EngineEvent) => {
    const c = NodePostgresDataSource.client;
    const t = await c.query('select seq, state from tickets where id = $1', [event.ticket]);
    const seq = (t.rows[0]?.seq ?? 0) + 1;
    const state: TicketState | undefined = t.rows[0]?.state ?? undefined;
    const decision = decide(state, event);
    const effects = decision.effects.map((effect, i) => ({ id: effectId(event.ticket, seq, i), effect }));
    await c.query('insert into journal (ticket, seq, event_id, event, decision) values ($1, $2, $3, $4, $5)', [
      event.ticket, seq, event.id, event, { state: decision.state ?? null, effects },
    ]);
    await c.query(
      'insert into tickets (id, seq, state) values ($1, $2, $3) on conflict (id) do update set seq = $2, state = $3',
      [event.ticket, seq, decision.state ?? null],
    );
    return effects;
  },
  { name: 'decideTx' },
);

const handleEvent = DBOS.registerWorkflow(
  async (event: EngineEvent) => {
    const effects = await decideTx(event);
    log(`decided ${event.id} -> ${effects.length} effect(s)`);
    for (const { id, effect } of effects) {
      const result = await DBOS.runStep(
        async () => {
          log(`executing ${id}`);
          return runEffect(id, effect);
        },
        { name: `effect:${id}`, retriesAllowed: true, maxAttempts: 5, intervalSeconds: 1, backoffRate: 2 },
      );
      log(`effect ${id} done -> ${result.commentId}`);
      const next: EngineEvent = { id: `effect:${id}`, ticket: event.ticket, type: 'effect.done', payload: { effectId: id, result } };
      await DBOS.startWorkflow(handleEvent, {
        workflowID: next.id,
        queueName: QUEUE,
        enqueueOptions: { queuePartitionKey: event.ticket },
      })(next);
    }
  },
  { name: 'handleEvent' },
);

/** Inbox write: the webhook enqueues a workflow whose id is the delivery id (dedup across restarts). */
async function send(n: number): Promise<void> {
  const client = await DBOSClient.create({ systemDatabaseUrl: url });
  const e = delegated(n);
  const before = await client.getWorkflow(e.id);
  await client.enqueue({ queueName: QUEUE, workflowName: 'handleEvent', workflowID: e.id, queuePartitionKey: e.ticket }, e);
  log(`enqueue ${e.id}:`, before ? 'existing workflow id, ignored' : 'enqueued');
  await client.destroy();
}

async function launch(): Promise<void> {
  DBOS.setConfig({ name: 'orc129', systemDatabaseUrl: url, logLevel: 'warn' });
  await DBOS.launch();
  await DBOS.registerQueue(QUEUE, { partitionConcurrency: 1 });
}

async function worker(): Promise<never> {
  await launch();
  log('worker up');
  return new Promise(() => {});
}

async function replay(): Promise<void> {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  const { rows } = await db.query('select ticket, seq, event, decision from journal order by ticket, seq');
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
  await db.end();
}

async function query(sql: string) {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  const { rows } = await db.query(sql);
  await db.end();
  return rows;
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'setup') {
  await query(SCHEMA);
  await NodePostgresDataSource.initializeDBOSSchema({ connectionString: url });
  // DBOS migrates its system schema (dbos.*) itself, at launch.
  await launch();
  await DBOS.shutdown();
} else if (cmd === 'send') await send(Number(arg));
else if (cmd === 'worker') await worker();
else if (cmd === 'replay') await replay();
else if (cmd === 'status')
  console.log(JSON.stringify({
    tickets: await query('select id, seq, state from tickets'),
    workflows: await query('select workflow_uuid, status, application_version, executor_id, recovery_attempts from dbos.workflow_status order by created_at'),
    dbosTables: (await query("select table_name from information_schema.tables where table_schema = 'dbos' order by 1")).map((r) => r.table_name),
    steps: await query('select workflow_uuid, function_id, function_name, output from dbos.operation_outputs order by workflow_uuid, function_id'),
  }, null, 1));
else if (cmd === 'done') process.exitCode = (await query("select 1 from tickets where state->>'status' = 'done'")).length ? 0 : 1;
else throw new Error(`unknown command ${cmd}`);
