/**
 * A daemon killed right after answering a GitHub webhook (ORC-134): it writes the signed delivery of
 * `<deliveryFile>` (`{ name, body }`) to the inbox through the GitHub ingestion, records the HTTP status
 * it would answer in `<statusFile>`, then kills itself with SIGKILL before any processing.
 *
 *   node --import tsx test/helpers/crash-after-github-ack.ts <postgres://…> <statusFile> <deliveryFile>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { githubDelivery, githubIngest } from './github-webhook.js';
import { storeAt } from './store-at.js';

const [target, statusFile, deliveryFile] = process.argv.slice(2);
if (!target || !statusFile || !deliveryFile) throw new Error('usage: crash-after-github-ack.ts <store> <statusFile> <deliveryFile>');
const store = storeAt(target);
const { name, body } = JSON.parse(readFileSync(deliveryFile, 'utf8')) as { name: string; body: unknown };
const { raw, headers } = githubDelivery(name, body);
const response = await githubIngest(store, (e) => store.appendInbox(e))(raw, headers);
writeFileSync(statusFile, JSON.stringify(response));
process.kill(process.pid, 'SIGKILL');
