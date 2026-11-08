import { DEFAULT_REQUIREMENTS } from '../../src/adapters/sandbox/types.js';
import { describe, expect, it } from 'vitest';
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
    expect(await h.ticket()).toMatchObject({ blocked: true, verifyAttempts: preset.bounds.verifyAttempts - 1 });
    expect(h.tracker.comments('REL-1').at(-1)).toContain('🔴 Blocked');
  });

  it('test preset: a check that passes within the bound resets the counter', async () => {
    const h = createHarness({ preset: testPreset() });
    h.checks.failNext('1 failed');
    await delegate(h);
    expect(h.checks.calls).toHaveLength(2);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false, verifyAttempts: 0 });
  });

  it('test preset: a feedback run is checked too, and its pass resets the counter', async () => {
    const h = createHarness({ preset: testPreset({ verifyAttempts: 2 }) });
    h.checks.failNext('1 failed');
    h.checks.failNext('2 failed');
    await delegate(h);
    expect(await h.ticket()).toMatchObject({ blocked: true, verifyAttempts: 1 });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'reprends', author: 'L' });
    await h.advance(0);
    expect(h.runner.requests).toHaveLength(3);
    expect(h.checks.calls).toHaveLength(3);
    expect(await h.ticket()).toMatchObject({ blocked: false, verifyAttempts: 0 });
  });

  it('a held run reaches its duration cap on the simulated clock and blocks the ticket', async () => {
    const h = createHarness();
    h.runner.enqueue({ hold: true });
    await delegate(h);
    const runId = (await h.ticket()).activeRunId!;
    const cap = h.runner.requests[0]!.limits.durationMs;
    // The agent keeps writing: a silent one would lose its lease first (ORC-344).
    const step = h.project.workflow.limits.silentAfterMs! / 2;
    for (let left = cap - 1; left > 0; left -= step) {
      h.runner.say(runId, { kind: 'text', text: 'working' });
      await h.advance(Math.min(step, left));
    }
    expect((await h.ticket()).activeRunId).toBe(runId);
    await h.advance(1);
    expect(await h.store.getRun(runId)).toMatchObject({ status: 'limit' });
    expect(await h.ticket()).toMatchObject({ blocked: true });
    expect(h.tracker.comments('REL-1').at(-1)).toContain('limit');
  });

  it('refuses a projectYaml combined with a preset, even an empty one', () => {
    expect(() => createHarness({ projectYaml: '', preset: testPreset() })).toThrow('not both');
  });

  it('a held check keeps the ticket verifying until it is released', async () => {
    const h = createHarness({ preset: testPreset() });
    const release = h.checks.holdNext();
    const delegated = delegate(h);
    await h.checks.started(1);
    expect((await h.ticket()).verifyingRunId).toBeDefined();
    release({ ok: false, failures: [{ command: 'fake:check', exitCode: 1, output: '1 failed' }] });
    await delegated;
    expect(h.runner.requests).toHaveLength(2);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', verifyAttempts: 0 });
  });

  it('the scenario drives the sandbox and publisher fakes and feeds the engine a pr.opened', async () => {
    const h = createHarness({ preset: testPreset() });
    await delegate(h);
    const { branch } = await h.ticket();
    const sandbox = await h.sandboxes.create({ runId: 'r-verify', ticketId: 'REL-1', workspacePath: '/tmp/factory-fake/p/REL-1', network: 'none', requirements: DEFAULT_REQUIREMENTS, mounts: [] });
    expect(h.sandboxes.active()).toEqual([sandbox]);
    await h.sandboxes.destroy(sandbox.id);
    const pub = await h.publisher.publish({
      projectId: 'p', repoPath: '/repo', ticketId: 'REL-1', runId: 'r1', worktree: '/w', branch: branch!, sha: 'abc123', title: 'feat: export CSV (REL-1)', body: '',
    });
    expect((await h.forge.findPr('/repo', branch!))?.checks).toBe('pending');
    await h.send('pr.opened', { number: pub.prNumber, url: pub.url, branch: branch! });
    expect(await h.ticket()).toMatchObject({ prNumber: pub.prNumber, prUrl: pub.url });
  });
});
