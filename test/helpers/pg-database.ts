import { Client } from 'pg';

/** The Postgres server of the integration project; empty skips its suites. */
export const PG_URL = process.env['DATABASE_URL'] ?? process.env['TEST_DATABASE_URL'] ?? '';

async function onServer<T>(connectionString: string, f: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString });
  await c.connect();
  try {
    return await f(c);
  } finally {
    await c.end();
  }
}

/**
 * An empty database of its own on the PG_URL server, so a suite neither sees nor truncates the
 * rows of a suite running in parallel. `drop()` removes it.
 */
export async function createTestDatabase(prefix: string): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `${prefix}_${process.pid}_${Date.now()}`;
  await onServer(PG_URL, (c) => c.query(`create database "${name}"`));
  const u = new URL(PG_URL);
  u.pathname = `/${name}`;
  return {
    url: u.toString(),
    drop: () => onServer(PG_URL, (c) => c.query(`drop database if exists "${name}" with (force)`)).then(() => undefined),
  };
}

export function queryOn<T>(connectionString: string, f: (c: Client) => Promise<T>): Promise<T> {
  return onServer(connectionString, f);
}
