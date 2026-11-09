import { userInfo } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { repoRoot } from '../app/root.js';
import { homePaths } from '../config/instance.js';
import { openStore } from '../store/open.js';
import type { Store } from '../store/types.js';

export const FLAKY_USAGE = `Usage: factory flaky <project> [add <test> --reason <why> [--frozen] | remove <test>]
  no action   list the project's known flaky tests
  add         list a test as known flaky: failing, verify marks it indicative, and the agent is not sent back for it
  --frozen    also while it is frozen for a ticket: a decision of its own, recorded with your name
  remove      take it off the list
A test is named as verify names it: <file> > <full name> (vitest, jest), its node id (pytest).`;

export interface FlakyOptions {
  store: Store;
  project: string;
  action?: string;
  test?: string;
  reason?: string;
  frozen?: boolean;
  /** Who decides, recorded with the entry. */
  by: string;
  now: number;
  print: (line: string) => void;
}

/**
 * `factory flaky` (ORC-164): the repository's known flaky tests, a human's list, which `verify` reads. Written to the store
 * directly (no daemon needed), with who decided, why and when: the only way a test becomes known flaky, there is no automatic rule.
 */
export async function runFlaky(o: FlakyOptions): Promise<number> {
  if (o.action === undefined) {
    const known = await o.store.knownFlakyTests(o.project);
    o.print(known.length ? `Known flaky tests of ${o.project}:` : `No known flaky test for ${o.project}.`);
    for (const k of known) o.print(`  ${k.test}  (${k.addedBy}: ${k.reason}${k.coversFrozen ? '; frozen tests too' : ''})`);
    return 0;
  }
  if (o.action === 'add' && o.test && o.reason) {
    await o.store.putKnownFlakyTest({ projectId: o.project, test: o.test, coversFrozen: !!o.frozen, reason: o.reason, addedBy: o.by, addedAt: o.now });
    o.print(`${o.test} is now a known flaky test of ${o.project}${o.frozen ? ', frozen or not' : ''}: failing, it is indicative.`);
    return 0;
  }
  if (o.action === 'remove' && o.test) {
    const removed = await o.store.deleteKnownFlakyTest(o.project, o.test);
    o.print(removed ? `${o.test} is no longer a known flaky test of ${o.project}.` : `${o.test} is not a known flaky test of ${o.project}.`);
    return removed ? 0 : 1;
  }
  o.print(FLAKY_USAGE);
  return 1;
}

/** The command line: `factory flaky <project> [add|remove] [<test>] [--reason <why>] [--frozen]`, on the instance's store. */
export async function runFlakyCommand(home: string, args: readonly string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args: [...args], allowPositionals: true, options: { reason: { type: 'string' }, frozen: { type: 'boolean' } } });
  const [project, action, test] = positionals;
  if (!project) {
    console.log(FLAKY_USAGE);
    return 1;
  }
  // The daemon migrates the schema; this only reads and writes rows.
  const { store } = await openStore({ env: process.env, sqlitePath: homePaths(home).db, migrationsFolder: join(repoRoot(), 'drizzle'), migrate: false });
  try {
    let by = 'cli';
    try {
      by = userInfo().username || by;
    } catch {
      // No user name (a container without passwd entry): recorded as `cli`.
    }
    return await runFlaky({
      store, project, by, now: Date.now(), print: (s) => console.log(s),
      ...(action ? { action } : {}), ...(test ? { test } : {}), ...(values.reason ? { reason: values.reason } : {}), ...(values.frozen ? { frozen: true } : {}),
    });
  } finally {
    await store.close();
  }
}
