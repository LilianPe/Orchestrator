/**
 * A daemon killed right after answering a webhook (ORC-147): it writes the signed delegation of
 * `linear-webhook.ts` to the inbox through the Linear ingestion, records the HTTP status it would
 * answer in `<statusFile>`, then kills itself with SIGKILL before any processing.
 *
 *   node --import tsx test/helpers/crash-after-ack.ts <sqlite file | postgres://…> <statusFile>
 */
import { writeFileSync } from 'node:fs';
import { PgStore } from '../../src/store/pg/pg-store.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import { linearIngest, signedDelegation } from './linear-webhook.js';

const [target, statusFile] = process.argv.slice(2);
if (!target || !statusFile) throw new Error('usage: crash-after-ack.ts <store> <statusFile>');
const store = target.startsWith('postgres') ? new PgStore({ connectionString: target }) : new SqliteStore(target);
const { raw, headers } = signedDelegation();
const response = await linearIngest((e) => store.appendInbox(e))(raw, headers);
writeFileSync(statusFile, JSON.stringify(response));
process.kill(process.pid, 'SIGKILL');
