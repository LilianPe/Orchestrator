import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness } from '../../test/helpers/harness.js';
import { homePaths, saveInstance } from '../config/instance.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { runReplayCommand } from './replay.js';

const journals = join(import.meta.dirname, '../../test/replay/journals');
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'factory-replay-'));
  dirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const code = await runReplayCommand(args, { print: (l) => out.push(l), env });
  return { code, out: out.join('\n') };
}

describe('factory replay (ORC-174)', () => {
  it('replays every journal of a folder, identical bit for bit', async () => {
    const { code, out } = await run([journals]);
    expect(code).toBe(0);
    expect(out).toMatch(/review-merge-done\.v1\.json: p\/REL-1: \d+ decision\(s\) replayed, 1 read through the upcasters — identical bit for bit/);
    expect(out).toMatch(/without divergence\.$/);
  });

  it('--what-if: a modified preset diverges, and the report names the event; exit code 1', async () => {
    const dir = tmp();
    const yaml = join(dir, 'workflow.yml');
    writeFileSync(yaml, 'version: 1\nlimits: { verify_attempts: 1 }\njobs:\n  dev: { verify: ["fake:check"] }\n');
    const { code, out } = await run([join(journals, 'check-failed-then-feedback.json'), '--what-if', yaml]);
    expect(code).toBe(1);
    expect(out).toContain('stopped at the first divergence');
    expect(out).toMatch(/event \S+ \(verify\.failed, #\d+ of the journal\)/);
  });

  it('--export writes the journal of a ticket of the instance, which then replays', async () => {
    const home = tmp();
    saveInstance(home, { port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [{ id: 'p', repoPath: '/repo', linearTeamKey: 'REL' }], limits: {} });
    const h = createHarness({ store: new SqliteStore(homePaths(home).db) });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    h.orch.stopAll();
    await h.orch.drained();
    await h.store.close();

    const file = join(home, 'REL-1.json');
    expect(await run(['--export', 'REL-1', '--out', file], { FACTORY_HOME: home })).toEqual({ code: 0, out: `Journal of REL-1 written to ${file}.` });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ format: 1, projectId: 'p', ticketId: 'REL-1' });
    expect((await run([file])).code).toBe(0);
  });

  it('refuses to export a ticket the instance has not journaled, or an instance without a base', async () => {
    const home = tmp();
    saveInstance(home, { port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [{ id: 'p', repoPath: '/repo', linearTeamKey: 'REL' }], limits: {} });
    await expect(run(['--export', 'REL-1'], { FACTORY_HOME: home })).rejects.toThrow(/no instance database/);
    expect(existsSync(homePaths(home).db)).toBe(false);
    await new SqliteStore(homePaths(home).db).close();
    await expect(run(['--export', 'REL-999'], { FACTORY_HOME: home })).rejects.toThrow(/no event journaled for REL-999/);
  });

  it('exits 2, after the other journals, on a journal it cannot read or one without a decision', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a-empty.json'), JSON.stringify({ format: 1, projectId: 'p', ticketId: 'REL-1', workflows: {}, entries: [] }));
    writeFileSync(join(dir, 'b-null.json'), JSON.stringify({ format: 1, projectId: 'p', workflows: null, entries: [] }));
    const { code, out } = await run([dir, join(journals, 'review-merge-done.json'), join(dir, 'missing.json')]);
    expect(code).toBe(2);
    expect(out).toContain('a-empty.json: p/REL-1: 0 decision(s) replayed');
    expect(out).toMatch(/b-null\.json: unreadable .*not a journal exported/);
    expect(out).toMatch(/review-merge-done\.json: p\/REL-1: \d+ decision\(s\) replayed — identical bit for bit/);
    expect(out).toMatch(/missing\.json: unreadable/);
  });

  it('prints its usage without a journal, or with an unknown option', async () => {
    expect((await run([])).code).toBe(2);
    expect(await run(['--whatif', 'x.yml', journals])).toMatchObject({ code: 2, out: expect.stringContaining('Usage: factory replay') });
  });
});
