import { describe, expect, it } from 'vitest';
import { reconcileOnce, type ReconcileDeps } from '../../src/adapters/tracker/linear/reconcile.js';
import { measureTicket } from '../../src/core/measures.js';
import { createHarness } from '../helpers/harness.js';
import { linearIngest, signedDelegation, signedMention } from '../helpers/linear-webhook.js';

const CLEAR = { identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' };

/** A harness that checks the matrix: Lilian, who signs the helpers' webhooks, is a member who can write the repo. */
function authorized() {
  const h = createHarness({ authz: { githubLogins: { 'user-lilian': 'lilian' } } });
  h.tracker.setTeamMembers('REL', ['user-lilian']);
  h.forge.setRepoPermission('lilian', 'write');
  h.tracker.addIssue(CLEAR);
  return h;
}

function plain() {
  const h = createHarness();
  h.tracker.addIssue(CLEAR);
  return h;
}

const ingestOf = (h: ReturnType<typeof createHarness>) => linearIngest((e) => h.orch.accept(e), { now: () => h.clock.now() });

describe('the trigger (ORC-171)', () => {
  it('criterion 1: a delegation by an authorized member gets its comment in under 10 s of simulated clock, then the plan in the session', async () => {
    const h = authorized();
    h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }], hold: true });
    const { raw, headers } = signedDelegation(h.clock.now());
    expect(await ingestOf(h)(raw, headers)).toEqual({ status: 200 });
    await h.orch.drained();

    expect(h.tracker.comments('REL-1')).toEqual(['Bien reçu.']);
    const order = h.tracker.calls.map((c) => c.method);
    expect(order.indexOf('comment')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('comment')).toBeLessThan(order.indexOf('setSessionPlan'));
    expect(order.indexOf('setSessionPlan')).toBeLessThan(order.indexOf('moveTo'));
    // Linear marks a session unresponsive without an activity in 10 s: a plan does not count as one.
    expect(h.tracker.activities('as-1')[0]).toEqual({ type: 'thought', body: 'Bien reçu.' });
    expect(h.tracker.plans('as-1')[0]![0]).toEqual({ content: 'Comprendre', status: 'inProgress' });
    const [message] = (await measureTicket(h.store, 'p', 'REL-1')).messages;
    expect(message!.signOfLifeMs).toEqual(expect.any(Number));
    expect(message!.signOfLifeMs).toBeLessThan(10_000);
  });

  it('measures the delay from the webhook to the ack on the ack itself, not on a later output', async () => {
    const h = authorized();
    h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }], hold: true });
    const { raw, headers } = signedDelegation(h.clock.now());
    const at = h.clock.now();
    const ingest = linearIngest(
      async (e) => {
        h.clock.advance(1_500);
        return h.orch.accept(e);
      },
      { now: () => at },
    );
    await ingest(raw, headers);
    await h.orch.drained();
    const facts = await h.store.measureFacts('p', 'REL-1');
    expect(Object.values(facts.acks)).toEqual([at + 1_500]);
    expect((await measureTicket(h.store, 'p', 'REL-1')).messages[0]!.signOfLifeMs).toBe(1_500);
  });

  it('updates the plan at each step of the run, ending with the PR', async () => {
    const h = plain();
    h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }] });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1', ack: true });
    const underWay = (i: number) => h.tracker.plans('ls-1')[i]!.filter((s) => s.status === 'inProgress').map((s) => s.content);
    expect(underWay(0)).toEqual(['Comprendre']);
    expect(underWay(1)).toEqual(['Build']);
    await h.send('pr.opened', { number: 3, url: 'https://gh/pr/3', branch: 'factory/rel-1-export-csv' });
    const last = h.tracker.plans('ls-1').at(-1)!;
    expect(last.at(-1)).toEqual({ content: 'PR', status: 'completed' });
    expect(last.some((s) => s.status === 'inProgress')).toBe(false);
  });

  it('writes no plan on a ticket that never got one: a ticket taken before ORC-171, a run with no ack', async () => {
    const h = plain();
    h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }] });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.tracker.plans('ls-1')).toEqual([]);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review' });
  });

  it('keeps a plan Linear refuses from stopping the work: its plan API is a preview', async () => {
    const h = plain();
    h.tracker.setSessionPlan = async () => {
      throw new Error('Field "plan" is not defined by type AgentSessionUpdateInput');
    };
    h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }] });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1', ack: true });
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
    expect(h.tracker.comments('REL-1')).toEqual(['Bien reçu.']);
  });

  it('a webhook sent again neither comments nor starts twice', async () => {
    const h = authorized();
    h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }] });
    const { raw, headers } = signedDelegation(h.clock.now());
    const ingest = ingestOf(h);
    await ingest(raw, headers);
    await h.orch.drained();
    await ingest(raw, headers);
    await h.orch.drained();
    expect(h.tracker.comments('REL-1')).toEqual(['Bien reçu.']);
    expect(h.runner.requests).toHaveLength(1);
  });

  it('a refused delegation gets the refusal alone, and no time of ack', async () => {
    const h = authorized();
    h.tracker.setTeamMembers('REL', []);
    const { raw, headers } = signedDelegation(h.clock.now());
    await ingestOf(h)(raw, headers);
    await h.orch.drained();
    expect(h.tracker.comments('REL-1')).toEqual([]);
    expect(h.tracker.activities('as-1')).toEqual([{ type: 'response', body: expect.stringMatching(/^Refusé/) }]);
    expect((await h.store.measureFacts('p', 'REL-1')).acks).toEqual({});
  });

  it('criterion 2: a second delegation of a ticket at work starts no second run, now or after it ends', async () => {
    const h = plain();
    h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }], hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1', ack: true });
    const [run] = await h.store.runsByStatus('running');
    await h.send('ticket.delegated', { linearSessionId: 'ls-2', ack: true });
    expect(await h.ticket()).toMatchObject({ activeRunId: run!.id, linearSessionId: 'ls-1' });
    expect((await h.ticket()).pendingJob).toBeUndefined();
    expect(h.tracker.comments('REL-1')).toEqual(['Bien reçu.']);
    expect(h.tracker.activities('ls-2')).toEqual([{ type: 'response', body: expect.stringContaining('déjà') }]);
    h.runner.release(run!.id);
    await h.orch.drained();
    expect(h.runner.requests).toHaveLength(1);
  });

  it('criterion 2 in the queue: two delegations of a ticket waiting for a slot give one queued run', async () => {
    const h = plain();
    await h.store.setMeta('paused', '1');
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-2' });
    expect((await h.store.listQueue()).map((q) => q.job)).toEqual(['dev']);
    expect(h.runner.requests).toEqual([]);
  });

  it('criterion 3: a delegation on a team with no repo is blocked under the first project, whoever signs it, and no work starts', async () => {
    const h = authorized();
    h.tracker.addIssue({ identifier: 'ZZZ-1', title: 'Ailleurs', description: 'Un ticket dans une équipe que rien ne rattache à un dépôt.' });
    const { raw, headers } = signedDelegation(h.clock.now(), 'ZZZ-1');
    expect(await ingestOf(h)(raw, headers)).toEqual({ status: 200 });
    await h.orch.drained();
    expect(await h.ticket('ZZZ-1')).toMatchObject({ projectId: 'p', blocked: true, delegated: true, blockReason: expect.stringContaining('ZZZ') });
    expect(h.tracker.issues.get('ZZZ-1')!.labels).toEqual(['Bloqué']);
    expect(h.tracker.activities('as-1')).toEqual([{ type: 'elicitation', body: expect.stringContaining('ZZZ') }]);
    expect(h.tracker.comments('ZZZ-1')).toEqual([]);
    expect(h.runner.requests).toEqual([]);
  });

  it('criterion 3, repaired: its team now has a repo, the first pass over all the projects lifts the block and the label', async () => {
    const h = authorized();
    h.tracker.addIssue({ identifier: 'ZZZ-1', title: 'Ailleurs', delegateId: 'app' });
    const { raw, headers } = signedDelegation(h.clock.now(), 'ZZZ-1');
    await ingestOf(h)(raw, headers);
    await h.orch.drained();
    const deps: Omit<ReconcileDeps, 'projects'> = { tracker: h.tracker, store: h.store, submit: (e) => (e.projectId === 'p' ? h.orch.accept(e) : undefined), clock: h.clock, log: () => {} };
    // Nothing changes while no project takes the team.
    await reconcileOnce({ ...deps, projects: [h.project] });
    await h.orch.drained();
    expect(await h.ticket('ZZZ-1')).toMatchObject({ blocked: true });
    await reconcileOnce({ ...deps, projects: [h.project, { ...h.project, id: 'zzz', teamKey: 'ZZZ' }] });
    await h.orch.drained();
    expect(await h.ticket('ZZZ-1')).toMatchObject({ blocked: false, delegated: false });
    expect(h.tracker.issues.get('ZZZ-1')!.labels).toEqual([]);
  });

  it('criterion 4: a mention gets its ack and its answer in the session under the comment, the ticket not delegated', async () => {
    const h = authorized();
    h.runner.enqueue({ events: [{ kind: 'text', text: "C'est pour garder l'ordre." }] });
    const { raw, headers } = signedMention('as-q', '@factory pourquoi ?', h.clock.now());
    await ingestOf(h)(raw, headers);
    await h.orch.drained();
    const session = h.tracker.activities('as-q');
    expect(session[0]).toEqual({ type: 'thought', body: 'Bien reçu.' });
    expect(session.at(-1)).toEqual({ type: 'response', body: "C'est pour garder l'ordre." });
    expect(h.tracker.comments('REL-1')).toEqual([]);
    expect(await h.ticket()).toMatchObject({ delegated: false });
  });
});
