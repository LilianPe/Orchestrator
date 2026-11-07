import { EventEmitter } from 'node:events';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PgStore } from './pg-store.js';

// No connection is opened: a pool connects on its first query.
const URL_NOWHERE = 'postgres://nobody:nothing@127.0.0.1:1/none';

describe('PgStore pool errors', () => {
  it('reports an idle client error instead of letting it kill the process', async () => {
    const seen: string[] = [];
    const store = new PgStore({ connectionString: URL_NOWHERE, onError: (e) => void seen.push(e.message) });
    const pool = (store as unknown as { pool: Pool }).pool;
    expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
    expect(seen).toEqual(['terminating connection due to administrator command']);
    await store.close();
  });

  it('reports the error of a checked-out client, which the pool does not hear, once (ORC-290)', async () => {
    const seen: string[] = [];
    const store = new PgStore({ connectionString: URL_NOWHERE, onError: (e) => void seen.push(e.message) });
    const pool = (store as unknown as { pool: Pool }).pool;
    const client = new EventEmitter();
    pool.emit('connect', client);
    // Checked out: the pool took its idle listener off, as on every acquire.
    expect(() => client.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
    expect(seen).toEqual(['terminating connection due to administrator command']);
    // Idle: the pool's own listener has it, and reports it through the pool's 'error'.
    client.on('error', (err: Error) => pool.emit('error', err));
    client.emit('error', new Error('cut while idle'));
    expect(seen).toEqual(['terminating connection due to administrator command', 'cut while idle']);
    await store.close();
  });

  it('listens on an injected pool too, and keeps a listener the owner already set', async () => {
    const bare = new Pool({ connectionString: URL_NOWHERE });
    const seen: string[] = [];
    new PgStore({ pool: bare, onError: (e) => void seen.push(e.message) });
    expect(() => bare.emit('error', new Error('cut'))).not.toThrow();
    expect(seen).toEqual(['cut']);

    const owned = new Pool({ connectionString: URL_NOWHERE });
    const ownerSeen: string[] = [];
    owned.on('error', (e) => void ownerSeen.push(e.message));
    new PgStore({ pool: owned, onError: (e) => void seen.push(e.message) });
    owned.emit('error', new Error('cut again'));
    expect(ownerSeen).toEqual(['cut again']);
    expect(seen).toEqual(['cut']);
    await Promise.all([bare.end(), owned.end()]);
  });
});
