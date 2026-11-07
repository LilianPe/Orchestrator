import { describe, expect, it } from 'vitest';
import { linearIngest, signedReply } from '../helpers/linear-webhook.js';
import { SENSITIVE_PATHS } from '../../src/core/engine.js';
import { createHarness } from '../helpers/harness.js';
import { testPreset } from '../helpers/test-preset.js';

type Harness = ReturnType<typeof createHarness>;

const instruction = (body: string) => ({ linearSessionId: 'ls-1', body, author: 'Lilian', ack: true as const, kind: 'instruction' as const });

/** A delegated ticket whose first run is still at work. */
async function atWork(h: Harness): Promise<string> {
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.runner.enqueue({ hold: true, events: [{ kind: 'text', text: 'PR ouverte, tests verts.' }] });
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
  return (await h.ticket()).activeRunId!;
}

/** A delegated ticket whose work is over, in Human Review: no agent is at work. */
async function inReview(h: Harness): Promise<void> {
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte, tests verts.' }] });
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
}

describe('the human inbox (ORC-180)', () => {
  // One of the seven mandatory scenarios of docs/tests.md, and criterion 6 of the ticket.
  it('a human reply during a run: in humanInbox, a sign of life posted, the run not interrupted, then handed over at the step boundary', async () => {
    const h = createHarness();
    const running = await atWork(h);
    const before = h.tracker.activities('ls-1').length;

    await h.send('session.prompted', instruction('corrige le tri'));
    expect((await h.ticket()).humanInbox.map((f) => f.body)).toEqual(['corrige le tri']);
    // At once, on the clock of the decision, with no agent called: the model stays out of it.
    expect(h.tracker.activities('ls-1').slice(before)).toContainEqual(expect.objectContaining({ type: 'thought', body: 'Noted, taken into account at the next step.' }));
    expect(h.runner.requests).toHaveLength(1);
    expect((await h.store.getRun(running))!.status).toBe('running');

    await h.advance(60_000);
    await h.send('session.prompted', instruction('ajoute un test'));
    // The regrouping ends: nothing is started, nothing is stopped, nothing goes pending behind the run.
    await h.advance(180_000);
    expect(h.runner.requests).toHaveLength(1);
    expect((await h.ticket()).activeRunId).toBe(running);
    expect((await h.ticket()).pendingJob).toBeUndefined();
    expect((await h.store.getRun(running))!.status).toBe('running');
    expect((await h.ticket()).humanInbox.map((f) => f.body)).toEqual(['corrige le tri', 'ajoute un test']);

    h.runner.enqueue({ events: [{ kind: 'text', text: 'Pris en compte.' }] });
    h.runner.release(running);
    await h.orch.drained();
    // Delivered together, to the session the agent was working in, once its work has ended and shows in Human Review.
    expect(h.runner.requests).toHaveLength(2);
    const next = h.runner.requests[1]!;
    expect(next.resume).toBe(true);
    expect(next.claudeSessionId).toBe(h.runner.requests[0]!.claudeSessionId);
    expect(next.prompt).toContain('corrige le tri');
    expect(next.prompt).toContain('ajoute un test');
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', humanInbox: [] });
  });

  it('a boundary that resumes the agent anyway carries the messages: no extra run, none lost when the attempt is cut', async () => {
    const h = createHarness({ preset: testPreset() });
    h.checks.failNext('1 failed');
    const running = await atWork(h);
    await h.send('session.prompted', instruction('corrige le tri'));
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Corrigé.' }] });
    h.runner.release(running);
    await h.orch.drained();
    // The failed check resumes `dev`: the same attempt reads its failures and the instruction.
    const prompts = h.runner.requests.map((r) => r.prompt);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('## Failed checks');
    expect(prompts[1]).toContain('## Feedback to address');
    expect(prompts[1]).toContain('corrige le tri');
    expect((await h.ticket()).humanInbox).toEqual([]);
    // Written with the attempt: the relaunch of a cut attempt reads what it read.
    const run = (await h.store.runsByStatus('success')).find((r) => r.id !== running);
    expect(run?.input?.text).toContain('corrige le tri');
  });

  it('an untrusted message keeps its taint up to the attempt that reads it at the boundary (I12)', async () => {
    const h = createHarness({ preset: testPreset() });
    h.checks.failNext('1 failed');
    const running = await atWork(h);
    expect(h.runner.requests[0]!.sensitivePaths).toBeUndefined();
    await h.send('session.prompted', instruction('corrige le tri'), 'REL-1', { taint: 'untrusted' });
    expect((await h.ticket()).humanInbox).toEqual([expect.objectContaining({ taint: 'untrusted' })]);
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Corrigé.' }] });
    h.runner.release(running);
    await h.orch.drained();
    expect(h.runner.requests[1]!.prompt).toContain('corrige le tri');
    expect(h.runner.requests[1]!.sensitivePaths).toEqual(SENSITIVE_PATHS);
  });

  describe('a run that empties the inbox takes the taint of all it empties (I12)', () => {
    const command = { linearSessionId: 'ls-1', body: '/status', author: 'Lilian', ack: true as const, kind: 'command' as const };

    it('a command beside a message, at a boundary: the agent is not given the command, the attempt takes its taint', async () => {
      const h = createHarness({ preset: testPreset() });
      h.checks.failNext('1 failed');
      const running = await atWork(h);
      await h.send('session.prompted', instruction('corrige le tri'));
      await h.send('session.prompted', command, 'REL-1', { taint: 'untrusted' });
      h.runner.enqueue({ events: [{ kind: 'text', text: 'Corrigé.' }] });
      h.runner.release(running);
      await h.orch.drained();
      expect(h.runner.requests[1]!.prompt).toContain('corrige le tri');
      expect(h.runner.requests[1]!.prompt).not.toContain('/status');
      expect(h.runner.requests[1]!.sensitivePaths).toEqual(SENSITIVE_PATHS);
      expect((await h.ticket()).humanInbox).toEqual([]);
    });

    it('a command that came in behind a pending job: the launch takes its taint, not only the decision', async () => {
      const h = createHarness();
      const running = await atWork(h);
      // Out and back by a human: its own move to dev would be the echo of the factory's.
      await h.send('status.changed', { from: 'dev', to: 'human_review' });
      await h.send('status.changed', { from: 'human_review', to: 'dev' });
      expect((await h.ticket()).pendingJob).toMatchObject({ job: 'dev-feedback' });
      await h.send('session.prompted', command, 'REL-1', { taint: 'untrusted' });
      h.runner.enqueue({ events: [{ kind: 'text', text: 'Repris.' }] });
      h.runner.release(running);
      await h.orch.drained();
      expect(h.runner.requests[1]!.prompt.startsWith('/factory:feedback\n')).toBe(true);
      expect(h.runner.requests[1]!.sensitivePaths).toEqual(SENSITIVE_PATHS);
    });

    it('the relaunch of a cut attempt keeps that taint, the inbox being empty by then', async () => {
      const h = createHarness({ preset: testPreset(), effectLeaseMs: 60_000 });
      h.checks.failNext('1 failed');
      const running = await atWork(h);
      await h.send('session.prompted', instruction('corrige le tri'));
      await h.send('session.prompted', command, 'REL-1', { taint: 'untrusted' });
      h.runner.enqueue({ hold: true });
      h.runner.release(running);
      await h.orch.drained();
      const cut = (await h.ticket()).activeRunId!;
      expect((await h.ticket()).humanInbox).toEqual([]);
      h.runner.forget(cut);
      h.runner.enqueue({ events: [{ kind: 'text', text: 'Corrigé.' }] });
      await h.restart({ mode: 'brutal' });
      const again = h.runner.requests[2]!;
      expect(again.prompt).toContain('corrige le tri');
      expect(again.sensitivePaths).toEqual(SENSITIVE_PATHS);
    });

    it('a step that reads and empties nothing takes nothing: a command alone at a boundary stays, the attempt free', async () => {
      const h = createHarness({ preset: testPreset() });
      h.checks.failNext('1 failed');
      const running = await atWork(h);
      await h.send('session.prompted', command, 'REL-1', { taint: 'untrusted' });
      h.runner.enqueue({ events: [{ kind: 'text', text: 'Corrigé.' }] });
      h.runner.release(running);
      await h.orch.drained();
      expect(h.runner.requests[1]!.sensitivePaths).toBeUndefined();
      expect((await h.ticket()).humanInbox).toEqual([expect.objectContaining({ kind: 'command', taint: 'untrusted' })]);
    });

    it('a review neither reads nor empties it, whatever waits there', async () => {
      const h = createHarness();
      await inReview(h);
      await h.send('session.prompted', instruction('corrige le tri'), 'REL-1', { taint: 'untrusted' });
      h.runner.enqueue({ hold: true, events: [{ kind: 'text', text: 'Synthèse.' }], submit: false });
      await h.send('status.changed', { from: 'human_review', to: 'ai_review' });
      expect(h.runner.requests[1]!.prompt.startsWith('/factory:review\n')).toBe(true);
      expect(h.runner.requests[1]!.sensitivePaths).toBeUndefined();
      expect((await h.ticket()).humanInbox).toEqual([expect.objectContaining({ taint: 'untrusted' })]);
    });
  });

  it('a review does not read them: they wait for the agent that implements', async () => {
    const h = createHarness();
    await inReview(h);
    h.runner.enqueue({ hold: true, events: [{ kind: 'text', text: 'Synthèse.' }], submit: false }, { events: [{ kind: 'text', text: 'Pris en compte.' }] });
    await h.send('status.changed', { from: 'human_review', to: 'ai_review' });
    const review = (await h.ticket()).activeRunId!;
    expect(h.runner.requests[1]!.prompt.startsWith('/factory:review\n')).toBe(true);
    await h.send('session.prompted', instruction('corrige le tri'));
    expect(h.runner.requests[1]!.prompt).not.toContain('corrige le tri');
    h.runner.release(review);
    await h.orch.drained();
    expect(h.runner.requests).toHaveLength(3);
    expect(h.runner.requests[2]!.prompt.startsWith('/factory:feedback\n')).toBe(true);
    expect(h.runner.requests[2]!.prompt).toContain('corrige le tri');
  });

  it('with no agent at work, replies regrouped over 3 minutes resume it once, and a restart loses nothing', async () => {
    const h = createHarness();
    await inReview(h);
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Corrigé.' }] });
    await h.send('session.prompted', instruction('corrige le tri'));
    await h.advance(60_000);
    await h.send('session.prompted', instruction('ajoute un test'));
    await h.restart();
    await h.advance(179_000);
    expect(h.runner.requests).toHaveLength(1);
    await h.advance(1_000);
    expect(h.runner.requests).toHaveLength(2);
    expect(h.runner.requests[1]!.prompt).toContain('corrige le tri');
    expect(h.runner.requests[1]!.prompt).toContain('ajoute un test');
    expect((await h.ticket()).humanInbox).toEqual([]);
  });

  it('a question during a run is answered at once by a read-only run beside it, and stays for the agent', async () => {
    const h = createHarness();
    const running = await atWork(h);
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Parce que.' }] });
    await h.send('session.prompted', { ...instruction('pourquoi ce choix ?'), kind: 'question' });
    expect(h.runner.requests).toHaveLength(2);
    expect(h.runner.requests[1]).toMatchObject({ readOnly: true });
    expect(h.runner.requests[1]!.prompt.startsWith('/factory:ask\n')).toBe(true);
    expect(h.tracker.activities('ls-1').at(-1)).toEqual({ type: 'response', body: 'Parce que.' });
    expect((await h.store.getRun(running))!.status).toBe('running');
    expect((await h.ticket()).humanInbox.map((f) => f.body)).toEqual(['pourquoi ce choix ?']);
  });

  it('through the Linear webhook: classified without a model, acked by the outbox, the ack time recorded for the measure', async () => {
    const h = createHarness();
    await inReview(h);
    const ingest = linearIngest((e) => h.orch.accept(e), { now: () => h.clock.now() });
    const { raw, headers } = signedReply('ls-1', 'les boutons sont mal alignés ?', h.clock.now());
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Parce que.' }] });
    await ingest(raw, headers);
    await h.orch.drained();
    expect(h.runner.requests.at(-1)!.prompt.startsWith('/factory:ask\n')).toBe(true);
    expect(h.tracker.activities('ls-1')).toContainEqual(expect.objectContaining({ type: 'thought', body: 'Noted, I am looking into it and will answer here.' }));
    const prompted = (await h.store.recentEvents(100, 'REL-1')).find((e) => e.type === 'session.prompted')!;
    expect(prompted.payload).toMatchObject({ ack: true, kind: 'question' });
    expect((await h.store.measureFacts('p', 'REL-1')).acks[prompted.id]).toBe(h.clock.now());
  });
});
