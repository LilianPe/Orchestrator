import { describe, expect, it, vi } from 'vitest';
import { createHarness } from '../helpers/harness.js';
import { testPreset } from '../helpers/test-preset.js';

function delegate(h: ReturnType<typeof createHarness>) {
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  return h.send('ticket.delegated', { linearSessionId: 'ls-1' });
}

describe('harness: new port fakes and the test preset', () => {
  it('test preset: the verify loop bounded at N blocks the ticket at the N-th failure', async () => {
    const preset = testPreset({ verifyAttempts: 3 });
    const h = createHarness({ preset });
    for (let i = 1; i <= preset.bounds.verifyAttempts; i++) h.checks.failNext(`échec ${i}`);
    await delegate(h);
    expect(h.checks.calls).toHaveLength(preset.bounds.verifyAttempts);
    expect(h.checks.calls[0]!.commands).toEqual(preset.steps.find((s) => s.kind === 'check')!.commands);
    expect(h.runner.requests).toHaveLength(preset.bounds.verifyAttempts);
    expect(h.ticket()).toMatchObject({ blocked: true, verifyAttempts: preset.bounds.verifyAttempts - 1 });
    expect(h.tracker.activities('ls-1').at(-1)!.type).toBe('elicitation');
  });

  it('test preset: a check that passes within the bound resets the counter', async () => {
    const h = createHarness({ preset: testPreset() });
    h.checks.failNext('1 failed');
    await delegate(h);
    expect(h.checks.calls).toHaveLength(2);
    expect(h.ticket()).toMatchObject({ logical: 'human_review', blocked: false, verifyAttempts: 0 });
  });

  it('test preset: only the build step runs the check, not the feedback runs that extend it', async () => {
    const h = createHarness({ preset: testPreset() });
    await delegate(h);
    expect(h.checks.calls).toHaveLength(1);
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'aussi le titre', author: 'L' });
    await h.advance(180_000);
    expect(h.runner.requests).toHaveLength(2);
    expect(h.checks.calls).toHaveLength(1);
  });

  it('refuses a projectYaml combined with a preset, even an empty one', () => {
    expect(() => createHarness({ projectYaml: '', preset: testPreset() })).toThrow('not both');
  });

  it('a held check keeps the ticket verifying until it is released', async () => {
    const h = createHarness({ preset: testPreset() });
    const release = h.checks.holdNext();
    const delegated = delegate(h);
    await vi.waitFor(() => expect(h.checks.calls).toHaveLength(1));
    expect(h.ticket().verifyingRunId).toBeDefined();
    release({ ok: false, failures: [{ command: 'fake:check', exitCode: 1, output: '1 failed' }] });
    await delegated;
    expect(h.runner.requests).toHaveLength(2);
    expect(h.ticket()).toMatchObject({ logical: 'human_review', verifyAttempts: 0 });
  });

  it('the scenario drives the sandbox and publisher fakes (not yet called by the orchestrator) and feeds the engine a pr.opened', async () => {
    const h = createHarness({ preset: testPreset() });
    await delegate(h);
    const { branch } = h.ticket();
    const sandbox = await h.sandboxes.create({ runId: 'r-verify', ticketId: 'REL-1', workspacePath: '/tmp/relais-fake/p/REL-1', network: 'none' });
    expect(h.sandboxes.active()).toEqual([sandbox]);
    await h.sandboxes.destroy(sandbox.id);
    const pub = await h.publisher.publish({
      projectId: 'p', repoPath: '/repo', ticketId: 'REL-1', branch: branch!, sha: 'abc123', title: 'feat: export CSV (REL-1)', body: '',
    });
    expect((await h.forge.findPr('/repo', branch!))?.checks).toBe('pending');
    await h.advance(60_000);
    await h.send('pr.opened', { number: pub.prNumber, url: pub.url, branch: branch! });
    expect(h.ticket()).toMatchObject({ prNumber: pub.prNumber, prUrl: pub.url });
  });
});
