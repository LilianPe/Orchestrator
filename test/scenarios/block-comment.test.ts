import { describe, expect, it } from 'vitest';
import { blockCause } from '../../src/core/block-cause.js';
import { SENSITIVE_PATHS } from '../../src/core/engine.js';
import { replayJournal, exportJournal } from '../../src/runtime/replay.js';
import { createHarness } from '../helpers/harness.js';

const MEMBER = 'user-lilian';

/** A ticket delegated by a member, its first run stopped at a cap. */
async function blocked() {
  const h = createHarness({ authz: { githubLogins: { [MEMBER]: 'lilian-gh' } } });
  h.tracker.setTeamMembers('REL', [MEMBER]);
  h.forge.setRepoPermission('lilian-gh', 'write');
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.runner.enqueue({ outcome: 'limit', tokens: { input: 100, output: 20, cacheRead: 999, cacheCreation: 3 } });
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: MEMBER });
  return h;
}

describe('the standard blocking comment and the reply that resumes (ORC-196)', () => {
  it('a block: the comment follows the template, the label is on, and nothing else tells it', async () => {
    const h = await blocked();
    const t = await h.ticket();
    expect(blockCause(t.blockReason)).toBe('limit');
    expect(t).toMatchObject({ blocked: true, blockedJob: 'dev' });
    expect((await h.tracker.getIssue('REL-1')).labels).toContain('Bloqué');
    const body = h.tracker.comments('REL-1').at(-1)!;
    expect(body.split('\n')).toEqual([
      "🔴 Blocked at step build (attempt 1/1)",
      `Reason: ${t.blockReason}`,
      'What I tried:',
      '- Started the run dev: stopped at its limit.',
      'Question: Shall I redo the step as is (reply "yes") or with an instruction (write it)?',
      expect.stringMatching(/^State: branch \S+ · last commit \S+ · CI none · code-run tokens 123 · \d+ min$/),
      'Reply on this ticket: I will resume as soon as you answer.',
    ]);
    const told = h.tracker.activities('ls-1').filter((a) => a.type === 'elicitation' || a.type === 'error');
    expect(told).toEqual([]);
    expect(h.tracker.comments('REL-1').filter((c) => c.includes('🔴'))).toHaveLength(1);
  });

  it('a member answers on the ticket: the blocked step starts again, in its session, reading the reply, the label off', async () => {
    const h = await blocked();
    h.runner.enqueue({ hold: true });
    await h.send('ticket.commented', { body: 'Prends le point-virgule.', author: 'Lilian', kind: 'instruction' }, 'REL-1', { actor: MEMBER });
    expect(h.runner.requests).toHaveLength(2);
    const relaunch = h.runner.requests[1]!;
    expect(relaunch.prompt.split('\n')[0]).toBe('/factory:dev');
    expect(relaunch.prompt).toContain('Prends le point-virgule.');
    expect(relaunch.resume).toBe(true);
    expect(await h.ticket()).toMatchObject({ blocked: false, activeJob: 'dev', humanInbox: [] });
    expect((await h.ticket()).blockedJob).toBeUndefined();
    expect((await h.tracker.getIssue('REL-1')).labels).not.toContain('Bloqué');
  });

  it('someone out of the team answers: refused, journaled and answered on the ticket, still blocked', async () => {
    const h = await blocked();
    await h.send('ticket.commented', { body: 'Reprends.', author: 'X', kind: 'instruction' }, 'REL-1', { actor: 'user-stranger' });
    expect(h.runner.requests).toHaveLength(1);
    expect(h.tracker.comments('REL-1').at(-1)).toMatch(/^Refused: relaunching a blocked run/);
    expect(await h.ticket()).toMatchObject({ blocked: true, humanInbox: [] });
    const { entries } = await exportJournal(h.store, 'p', 'REL-1');
    expect(entries.find((e) => e.event.type === 'ticket.commented')?.decision?.trace?.join()).toContain('authz: refused relaunch_blocked');
  });

  it('a direction in the session, as the webhook classifies it: the same resume', async () => {
    const h = await blocked();
    h.runner.enqueue({ hold: true });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'Corrige le séparateur', author: 'Lilian', ack: true, kind: 'instruction' }, 'REL-1', { actor: MEMBER });
    expect(h.runner.requests[1]!.prompt.split('\n')[0]).toBe('/factory:dev');
    expect(h.runner.requests[1]!.prompt).toContain('Corrige le séparateur');
    expect(await h.ticket()).toMatchObject({ blocked: false, activeJob: 'dev', humanInbox: [] });
  });

  it('a question on the blocked ticket resumes it, no second agent to answer it', async () => {
    const h = await blocked();
    h.runner.enqueue({ hold: true });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'Quel séparateur tu proposes ?', author: 'Lilian', ack: true, kind: 'question' }, 'REL-1', { actor: MEMBER });
    expect(h.runner.requests).toHaveLength(2);
    expect(h.runner.requests[1]!.prompt.split('\n')[0]).toBe('/factory:dev');
  });

  it('`/status` as a comment answers on the ticket: nothing resumes, the step is kept, the agent never reads it', async () => {
    const h = await blocked();
    await h.send('ticket.commented', { body: '/status', author: 'Lilian', kind: 'command' }, 'REL-1', { actor: MEMBER });
    expect(h.runner.requests).toHaveLength(1);
    expect(h.tracker.comments('REL-1').at(-1)).toContain('Blocked: ');
    expect(await h.ticket()).toMatchObject({ blocked: true, blockedJob: 'dev' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.commented', { body: 'Vas-y.', author: 'Lilian', kind: 'instruction' }, 'REL-1', { actor: MEMBER });
    expect(h.runner.requests[1]!.prompt).toContain('Vas-y.');
    expect(h.runner.requests[1]!.prompt).not.toContain('/status');
  });

  it('an untrusted message waiting in the inbox: the resume by a trusted comment runs with the sensitive paths (I12)', async () => {
    // No role resolver: an unsigned message gets past the matrix only there, as a row journaled before ORC-186 does.
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
    h.runner.enqueue({ outcome: 'limit' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: '/status', author: 'Bot', kind: 'command' }, 'REL-1', { taint: 'untrusted' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.commented', { body: 'Vas-y.', author: 'Lilian', kind: 'instruction' });
    expect(h.runner.requests[1]!.sensitivePaths).toEqual(SENSITIVE_PATHS);
    expect((await h.ticket()).humanInbox).toEqual([]);
  });

  it('what it decided replays bit for bit', async () => {
    const h = await blocked();
    h.runner.enqueue({ hold: true });
    await h.send('ticket.commented', { body: 'Vas-y.', author: 'Lilian', kind: 'instruction' }, 'REL-1', { actor: MEMBER });
    expect(replayJournal(await exportJournal(h.store, 'p', 'REL-1')).divergences).toEqual([]);
  });
});

describe('the question of an agent through `/agent/ask` (ORC-196)', () => {
  it('is told by the comment, then a reply resumes the job at work once it ended', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.send('agent.asked', { question: 'Quel séparateur ?', job: 'dev' });
    expect(h.tracker.comments('REL-1').at(-1)).toContain('Question: Quel séparateur ?');
    expect(await h.ticket()).toMatchObject({ blocked: true, blockedJob: 'dev' });
    await h.send('ticket.commented', { body: 'Le point-virgule.', author: 'Lilian', kind: 'instruction' });
    expect(await h.ticket()).toMatchObject({ blocked: false, pendingJob: { job: 'dev', input: 'feedback' } });
  });
});
