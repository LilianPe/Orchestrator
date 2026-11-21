import { describe, expect, it } from 'vitest';
import { dryRunFingerprint, type DryRun, type DryRunBreak, type DryRunRequest, type FingerprintFiles } from '../../src/core/dry-run.js';
import { chainHarness, delegate as delegateOnChain } from '../helpers/chain.js';
import { createHarness } from '../helpers/harness.js';

const DESCRIPTION = 'Export the audits as CSV from the audit list.';
const IMAGE = 'factory/runner:test';
const MAIN = 'a'.repeat(40);
const MOVED = 'b'.repeat(40);
const FILES: FingerprintFiles = { lockfiles: { 'package-lock.json': 'l1' }, config: 'c1' };
const BREAK: DryRunBreak = { kind: 'dependency', step: 'setup', command: 'npm ci', detail: 'a dependency is missing: No matching version found for left-pad@9.9.9', output: 'npm error notarget' };

/** The default branch as the factory's repository has it: its head and the files of the fingerprint there. */
interface Main {
  sha: string;
  files: FingerprintFiles;
}

/** A dry run of `main`, green or red, with the fingerprint the gate computes for it: the workflow's empty setup, the harness's image. */
const dryRunOf = (main: Main, ok: boolean, id = 'dry-old'): DryRun => ({
  id, projectId: 'p', sha: main.sha, target: 'main', ok, fingerprint: dryRunFingerprint({ setup: [], image: IMAGE, ...main.files }),
  breaks: ok ? [] : [BREAK], commands: ['npm test'], startedAt: 0, endedAt: 1,
});

/** A sandboxed harness whose default branch is `main` (changed by the test), each dry run asked kept and answered `next`. */
function gated(o: { next?: (req: DryRunRequest, main: Main) => DryRun; sandboxed?: boolean } = {}) {
  const main: Main = { sha: MAIN, files: FILES };
  const asked: DryRunRequest[] = [];
  const h = createHarness({
    sandboxed: o.sandboxed ?? true,
    dryRunFiles: async () => ({ sha: main.sha, ...main.files }),
    dryRunner: async (req) => {
      asked.push(req);
      return { ...(o.next ?? ((_r, m) => dryRunOf(m, true)))(req, main), id: req.runId };
    },
  });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: DESCRIPTION });
  return { h, main, asked, delegate: (id = 'REL-1') => h.send('ticket.delegated', { linearSessionId: `ls-${id}` }, id) };
}

/** ORC-409: a repository's tickets wait for its dry run, which runs again when what it ran with changes. */
describe('the dry run gate of a delegated ticket', () => {
  it('criterion 1: a red last dry run refuses the ticket, blocked with what breaks, and no run starts', async () => {
    const { h, main, asked, delegate } = gated();
    await h.store.putDryRun(dryRunOf(main, false));
    await delegate();
    expect(asked).toEqual([]);
    expect(h.runner.requests).toEqual([]);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: true, blockKind: 'repo_config' });
    expect(t.blockReason).toContain('dry run');
    const [comment] = h.tracker.comments('REL-1').filter((c) => c.startsWith('🔴'));
    expect(comment).toContain('`npm ci`');
    expect(comment).toContain('left-pad@9.9.9');
    expect(comment).toContain('factory dry-run p');
  });

  it('on the chain as it ships, a red dry run refuses the ticket before its intake', async () => {
    const h = chainHarness({ sandboxed: true, dryRunFiles: async () => ({ sha: MAIN, ...FILES }), dryRunner: async () => expect.unreachable() });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: DESCRIPTION });
    await h.store.putDryRun(dryRunOf({ sha: MAIN, files: FILES }, false));
    await delegateOnChain(h);
    expect(h.runner.requests).toEqual([]);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockKind: 'repo_config', blockedJob: 'intake' });
  });

  it('a green last dry run on the same fingerprint lets the ticket start, without running it again', async () => {
    const { h, main, asked, delegate } = gated();
    await h.store.putDryRun(dryRunOf(main, true));
    await delegate();
    expect(asked).toEqual([]);
    expect(h.runner.requests).toHaveLength(1);
    expect((await h.ticket()).blocked).toBe(false);
  });

  it('a project with no dry run yet runs it at its first delegation: green, the ticket starts', async () => {
    const { h, asked, delegate } = gated();
    await delegate();
    expect(asked).toHaveLength(1);
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.store.lastDryRun('p')).toMatchObject({ ok: true, id: asked[0]!.runId });
  });

  it('a project with no dry run yet runs it at its first delegation: red, the ticket is refused', async () => {
    const { h, asked, delegate } = gated({ next: (_r, m) => dryRunOf(m, false) });
    await delegate();
    expect(asked).toHaveLength(1);
    expect(h.runner.requests).toEqual([]);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockKind: 'repo_config' });
  });

  it.each([
    ['a lockfile', (m: Main) => void (m.files = { ...m.files, lockfiles: { 'package-lock.json': 'l2' } })],
    ['a lockfile added', (m: Main) => void (m.files = { ...m.files, lockfiles: { ...m.files.lockfiles, 'uv.lock': 'u1' } })],
    ['.factory/config.yml', (m: Main) => void (m.files = { ...m.files, config: 'c2' })],
  ])('criterion 2: a green dry run whose input changed (%s) runs again before the ticket starts', async (_what, change) => {
    const { h, main, asked, delegate } = gated();
    await h.store.putDryRun(dryRunOf(main, true));
    change(main);
    await delegate();
    expect(asked).toHaveLength(1);
    expect(h.runner.requests).toHaveLength(1);
  });

  it('criterion 2: a green dry run on another runner image runs again', async () => {
    const { h, main, asked, delegate } = gated();
    await h.store.putDryRun({ ...dryRunOf(main, true), fingerprint: dryRunFingerprint({ setup: [], image: 'factory/runner:old', ...main.files }) });
    await delegate();
    expect(asked).toHaveLength(1);
  });

  it('criterion 2: a green dry run on another setup runs again', async () => {
    const { h, main, asked, delegate } = gated();
    await h.store.putDryRun({ ...dryRunOf(main, true), fingerprint: dryRunFingerprint({ setup: ['npm ci'], image: IMAGE, ...main.files }) });
    await delegate();
    expect(asked).toHaveLength(1);
  });

  it('a green dry run is not run again for a default branch that moved with the same inputs', async () => {
    const { h, main, asked, delegate } = gated();
    await h.store.putDryRun(dryRunOf(main, true));
    main.sha = MOVED;
    await delegate();
    expect(asked).toEqual([]);
    expect(h.runner.requests).toHaveLength(1);
  });

  it('a red dry run runs again once the default branch moved, its fix in the code: green, the ticket starts on a reply', async () => {
    const { h, main, asked, delegate } = gated();
    await h.store.putDryRun(dryRunOf(main, false));
    await delegate();
    expect((await h.ticket()).blocked).toBe(true);
    // A reply on the same default branch: refused again, without running it again.
    await h.send('ticket.commented', { body: 'Done?', author: 'Armand', kind: 'instruction' });
    expect(asked).toEqual([]);
    expect(h.runner.requests).toEqual([]);
    main.sha = MOVED;
    await h.send('ticket.commented', { body: 'Fixed on main.', author: 'Armand', kind: 'instruction' });
    expect(asked).toHaveLength(1);
    expect(h.runner.requests).toHaveLength(1);
    expect((await h.ticket()).blocked).toBe(false);
  });

  it('two tickets delegated together share one dry run', async () => {
    const { h, asked } = gated();
    h.tracker.addIssue({ identifier: 'REL-2', title: 'Export PDF', description: DESCRIPTION });
    await Promise.all([
      h.orch.accept({ id: 'd-1', type: 'ticket.delegated', at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload: { linearSessionId: 'ls-1' } }),
      h.orch.accept({ id: 'd-2', type: 'ticket.delegated', at: h.clock.now(), projectId: 'p', ticketId: 'REL-2', payload: { linearSessionId: 'ls-2' } }),
    ]);
    await h.orch.drained();
    expect(asked).toHaveLength(1);
    expect(h.runner.requests).toHaveLength(2);
  });

  it('a dry run that cannot run blocks the ticket on the launch, as any launch error, and records nothing', async () => {
    const h = createHarness({ sandboxed: true, dryRunFiles: async () => ({ sha: MAIN, ...FILES }), dryRunner: async () => Promise.reject(new Error('engine down')) });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: DESCRIPTION });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.runner.requests).toEqual([]);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockKind: 'infra' });
    expect(await h.store.lastDryRun('p')).toBeUndefined();
  });

  it('without sandboxes no dry run can run: none refuses the ticket', async () => {
    const { h, main, asked, delegate } = gated({ sandboxed: false });
    await h.store.putDryRun(dryRunOf(main, false));
    await delegate();
    expect(asked).toEqual([]);
    expect(h.runner.requests).toHaveLength(1);
  });
});
