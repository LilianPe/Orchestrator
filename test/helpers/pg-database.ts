import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { journalSchemaOf } from '../../src/store/pg/migrate.js';
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

/** A test's schema in the PG_URL database; `drop()` removes it with its migration journal. */
export interface TestSchema {
  name: string;
  /**
   * PG_URL with the schema as search_path, and as application_name: the only way its connections are
   * found to be ended, so every connection to the schema goes through this URL.
   */
  url: string;
  drop(): Promise<void>;
}

let made = 0;

function testSchemaName(prefix: string): string {
  const name = `${prefix}_${process.pid}_${Date.now()}_${++made}`;
  // Unquoted in the search_path option, where Postgres would fold upper case that `create schema "…"` keeps.
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`test schema name not in [a-z0-9_]: ${name}`);
  // Throws past Postgres's bound for its journal, which also keeps the application_name whole.
  journalSchemaOf(name);
  return name;
}

function testSchemaUrl(name: string): string {
  const u = new URL(PG_URL);
  u.searchParams.set('options', `-c search_path=${name}`);
  u.searchParams.set('application_name', name);
  return u.toString();
}

/**
 * An empty schema of its own in the PG_URL database, so a suite neither sees nor truncates the rows
 * of a suite running in parallel. A schema rather than a database (ORC-334): a `drop database` waits
 * for a checkpoint of the whole server, a `drop schema` does not.
 */
export async function createTestSchema(prefix: string): Promise<TestSchema> {
  const name = testSchemaName(prefix);
  await onServer(PG_URL, (c) => c.query(`create schema "${name}"`));
  return { name, url: testSchemaUrl(name), drop: () => dropTestSchema(name) };
}

const END_CONNECTIONS = `select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1 and pid <> pg_backend_pid()`;

/** Ends the connections to the schema still open, as `drop database … with (force)` did. */
export function endConnections(name: string): Promise<void> {
  return onServer(PG_URL, (c) => c.query(END_CONNECTIONS, [name])).then(() => undefined);
}

/** Drops the schema and its migration journal, its connections ended first. */
function dropTestSchema(name: string): Promise<void> {
  return onServer(PG_URL, async (c) => {
    await c.query(END_CONNECTIONS, [name]);
    await c.query(`drop schema if exists "${name}", "${journalSchemaOf(name)}" cascade`);
  });
}

/**
 * Empties every table of the engine schema, between the tests sharing one schema. A `delete` rather than a
 * `truncate`, which makes new files for each table: 3 ms against 650 on a Docker Desktop Postgres (ORC-334).
 * The schema has neither sequence nor foreign key (held by pg-migrate-schema.test.ts), so this is all a reset needs.
 */
export const EMPTY_ALL = PG_TABLE_NAMES.map((name) => `delete from "${name}"`).join('; ');

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
