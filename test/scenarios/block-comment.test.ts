import { describe, expect, it } from 'vitest';
import { blockCause } from '../../src/core/block-cause.js';
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
      "🔴 Bloqué à l'étape build (tentative 1/1)",
      `Raison : ${t.blockReason}`,
      "Ce que j'ai essayé :",
      '- Le run dev lancé : arrêté à son plafond.',
      "Question : Je reprends l'étape telle quelle (répondez « oui ») ou avec une consigne (écrivez-la) ?",
      expect.stringMatching(/^État : branche \S+ · dernier commit \S+ · CI aucune · tokens 123 · \d+ min$/),
      'Répondez dans ce ticket : je reprends dès votre réponse.',
    ]);
    const told = h.tracker.activities('ls-1').filter((a) => a.type === 'elicitation' || a.type === 'error');
    expect(told).toEqual([]);
    expect(h.tracker.comments('REL-1').filter((c) => c.includes('🔴'))).toHaveLength(1);
  });

  it('a member answers on the ticket: the blocked step starts again, in its session, reading the reply, the label off', async () => {
    const h = await blocked();
    h.runner.enqueue({ hold: true });
    await h.send('ticket.commented', { body: 'Prends le point-virgule.', author: 'Lilian' }, 'REL-1', { actor: MEMBER });
    expect(h.runner.requests).toHaveLength(2);
    const relaunch = h.runner.requests[1]!;
    expect(relaunch.prompt.split('\n')[0]).toBe('/factory:dev');
    expect(relaunch.prompt).toContain('Prends le point-virgule.');
    expect(relaunch.resume).toBe(true);
    expect(await h.ticket()).toMatchObject({ blocked: false, activeJob: 'dev', pendingFeedback: [] });
    expect((await h.ticket()).blockedJob).toBeUndefined();
    expect((await h.tracker.getIssue('REL-1')).labels).not.toContain('Bloqué');
  });

  it('someone out of the team answers: refused, journaled and answered on the ticket, still blocked', async () => {
    const h = await blocked();
    await h.send('ticket.commented', { body: 'Reprends.', author: 'X' }, 'REL-1', { actor: 'user-stranger' });
    expect(h.runner.requests).toHaveLength(1);
    expect(h.tracker.comments('REL-1').at(-1)).toMatch(/^Refusé : relancer un run bloqué/);
    expect(await h.ticket()).toMatchObject({ blocked: true, pendingFeedback: [] });
    const { entries } = await exportJournal(h.store, 'p', 'REL-1');
    expect(entries.find((e) => e.event.type === 'ticket.commented')?.decision?.trace?.join()).toContain('authz: refused relaunch_blocked');
  });

  it('what it decided replays bit for bit', async () => {
    const h = await blocked();
    h.runner.enqueue({ hold: true });
    await h.send('ticket.commented', { body: 'Vas-y.', author: 'Lilian' }, 'REL-1', { actor: MEMBER });
    expect(replayJournal(await exportJournal(h.store, 'p', 'REL-1')).divergences).toEqual([]);
  });
});

describe('the question of an agent through `/agent/ask` (ORC-196)', () => {
  it('is told by the comment, then a reply resumes the job at work once it ended', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const run = (await h.store.getRun((await h.ticket()).activeRunId!))!;
    await h.orch.askQuestion(run, "Question posée par l'agent", 'Quel séparateur ?');
    await h.orch.blockTicket('p', 'REL-1', "Question posée par l'agent");
    expect(h.tracker.comments('REL-1').at(-1)).toContain('Question : Quel séparateur ?');
    expect(await h.ticket()).toMatchObject({ blocked: true, blockedJob: 'dev' });
    await h.send('ticket.commented', { body: 'Le point-virgule.', author: 'Lilian' });
    expect(await h.ticket()).toMatchObject({ blocked: false, pendingJob: { job: 'dev', input: 'feedback' } });
  });
});
