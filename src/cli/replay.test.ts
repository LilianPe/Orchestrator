import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveInstance } from '../config/instance.js';
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

  // The scenario's delegation started `dev`; factory/fantome starts at its entry, `intake` (ORC-231).
  it('--what-if <preset>: a journal diverges on the workflow of another compiled preset, and the report names the event; exit code 1', async () => {
    const { code, out } = await run([join(journals, 'check-failed-then-feedback.json'), '--what-if', 'factory/fantome']);
    expect(code).toBe(1);
    expect(out).toContain('stopped at the first divergence');
    // Both start at intake (ORC-395): they part at its end, where factory/default moves the ticket to Spec (ORC-457) and the Rapide
    // level, which shows no status, starts the spec at once.
    expect(out).toMatch(/event \S+ \(run\.finished, #3 of the journal\): effects\[0\]\.kind recorded "move", replayed "start_run"/);
  });

  it('--what-if refuses a preset the binary does not have, a workflow file included (ORC-389); exit code 2', async () => {
    for (const preset of ['factory/nope', join(tmp(), 'workflow.yml')]) {
      const { code, out } = await run([journals, '--what-if', preset]);
      expect(code).toBe(2);
      expect(out).toContain(`--what-if: unknown preset ${preset}`);
      expect(out).toContain('factory/default, factory/fantome');
    }
  });

  it('refuses to export without the instance database: Postgres only (ORC-178), its export tests in test/integration/replay-export-pg.test.ts', async () => {
    const home = tmp();
    saveInstance(home, { port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [{ id: 'p', github: 'acme/app', linearTeamKey: 'REL' }] });
    await expect(run(['--export', 'REL-1'], { FACTORY_HOME: home })).rejects.toThrow(/FACTORY_DATABASE_URL is not set/);
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
