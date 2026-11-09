import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { PG_TABLE_NAMES } from '../../src/store/pg/schema.js';

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
export async function createTestDatabase(prefix: string): Promise<{ name: string; url: string; drop(): Promise<void> }> {
  const name = `${prefix}_${process.pid}_${Date.now()}`;
  await onServer(PG_URL, (c) => c.query(`create database "${name}"`));
  const u = new URL(PG_URL);
  u.pathname = `/${name}`;
  return {
    name,
    url: u.toString(),
    drop: () => onServer(PG_URL, (c) => c.query(`drop database if exists "${name}" with (force)`)).then(() => undefined),
  };
}

/** Empties every table of the engine schema, between the tests of a suite sharing one database. */
export const TRUNCATE_ALL = `truncate table ${PG_TABLE_NAMES.map((name) => `"${name}"`).join(', ')} restart identity cascade`;

export function queryOn<T>(connectionString: string, f: (c: Client) => Promise<T>): Promise<T> {
  return onServer(connectionString, f);
}

/** `drizzle/` as it was up to the migration `tag`, included: a database migrated by an older daemon. */
export function migrationsUpTo(tag: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'factory-drizzle-')), 'drizzle');
  cpSync(join(import.meta.dirname, '../../drizzle'), dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const last = journal.entries.findIndex((e) => e.tag === tag);
  if (last < 0) throw new Error(`no migration ${tag}`);
  writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, last + 1) }));
  return dir;
}
