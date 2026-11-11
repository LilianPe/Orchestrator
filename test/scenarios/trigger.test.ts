import { describe, expect, it } from 'vitest';
import { reconcileOnce, type ReconcileDeps } from '../../src/adapters/tracker/linear/reconcile.js';
import { measureTicket } from '../../src/core/measures.js';
import { CUT_RELAUNCHES } from '../../src/store/types.js';
import { createHarness } from '../helpers/harness.js';
import { linearIngest, signedDelegation, signedMention } from '../helpers/linear-webhook.js';
import { testPreset } from '../helpers/test-preset.js';

/** The head of the reason of the cut bound (ORC-220): only its sentence, the block's kind is `limit`. */
const CUT_BOUND = /^Too many relaunches after a cut: /;

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

    expect(h.tracker.comments('REL-1')).toEqual(['Got it.']);
    const order = h.tracker.calls.map((c) => c.method);
    expect(order.indexOf('comment')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('comment')).toBeLessThan(order.indexOf('setSessionPlan'));
    expect(order.indexOf('setSessionPlan')).toBeLessThan(order.indexOf('moveTo'));
    // Linear marks a session unresponsive without an activity in 10 s: a plan does not count as one.
    expect(h.tracker.activities('as-1')[0]).toEqual({ type: 'thought', body: 'Got it.' });
    expect(h.tracker.plans('as-1')[0]![0]).toEqual({ content: 'Understand', status: 'inProgress' });
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

  describe('across verify.errored (ORC-151)', () => {
    const broken = () => {
      let down = true;
      const h = createHarness({
        sandboxed: true,
        cleanVerify: async () => {
          if (down) throw new Error('engine down');
          return { ok: true, failures: [], sha: 'abc', tree: 'tree' };
        },
      });
      h.tracker.addIssue(CLEAR);
      return { h, recover: () => (down = false) };
    };
    const comments = (h: ReturnType<typeof createHarness>) => h.tracker.comments('REL-1').filter((body) => body === 'Got it.');

    it('the plan stays on Vérif, the PR not done, and the ack is not sent again', async () => {
      const { h } = broken();
      await h.send('ticket.delegated', { linearSessionId: 'ls-1', ack: true });
      expect(await h.ticket()).toMatchObject({ blocked: true });
      const last = h.tracker.plans('ls-1').at(-1)!;
      expect(last.filter((s) => s.status === 'inProgress').map((s) => s.content)).toEqual(['Verify']);
      expect(last.at(-1)).toEqual({ content: 'PR', status: 'pending' });
      expect(comments(h)).toHaveLength(1);
    });

    it('a reply resumes the job that blocked: checked again, no second ack, the plan closed at its end', async () => {
      const { h, recover } = broken();
      await h.send('ticket.delegated', { linearSessionId: 'ls-1', ack: true });
      const plans = h.tracker.plans('ls-1').length;
      recover();
      await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'le moteur est revenu', author: 'L' });
      await h.advance(1);
      expect(await h.ticket()).toMatchObject({ blocked: false, verifiedSha: 'abc' });
      expect(comments(h)).toHaveLength(1);
      // `dev` itself ends in Human Review, which closes the plan: `dev-feedback` used to leave it waiting (ORC-196).
      expect(h.tracker.plans('ls-1').length).toBeGreaterThan(plans);
      expect(h.tracker.plans('ls-1').at(-1)!.filter((s) => s.status === 'inProgress')).toEqual([]);
    });
  });

  it('updates the plan at each step of the run, ending with the PR', async () => {
    const h = plain();
    h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }] });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1', ack: true });
    const underWay = (i: number) => h.tracker.plans('ls-1')[i]!.filter((s) => s.status === 'inProgress').map((s) => s.content);
    expect(underWay(0)).toEqual(['Understand']);
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
    expect(h.tracker.comments('REL-1')).toEqual(['Got it.']);
  });

  it('keeps a refused ack from holding back or killing the run: the session still hears, its time is that of the write', async () => {
    const h = plain();
    h.tracker.comment = async () => {
      throw new Error('Linear refuses the comment');
    };
    h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }] });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1', ack: true });
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
    expect(h.tracker.activities('ls-1')[0]).toEqual({ type: 'thought', body: 'Got it.' });
    expect(Object.keys((await h.store.measureFacts('p', 'REL-1')).acks)).toHaveLength(1);
    expect(h.runner.requests).toHaveLength(1);
  });

  it('records no time of ack when neither write reached Linear', async () => {
    const h = plain();
    const refused = async () => {
      throw new Error('Linear down for writes');
    };
    h.tracker.comment = refused;
    h.tracker.activity = refused;
    await h.store.setMeta('paused', '1');
    await h.send('ticket.delegated', { linearSessionId: 'ls-1', ack: true });
    expect((await h.store.measureFacts('p', 'REL-1')).acks).toEqual({});
    expect((await h.ticket()).blocked).toBe(false);
  });

  it('writes the plan of a new delegation to its own session, and keeps it there', async () => {
    const h = plain();
    h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }] }, { events: [{ kind: 'text', text: 'Repris.' }] });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1', ack: true });
    const before = h.tracker.plans('ls-1').length;
    await h.send('status.changed', { from: 'human_review', to: 'dev' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-2', ack: true });
    expect(h.tracker.plans('ls-1')).toHaveLength(before);
    expect(h.tracker.plans('ls-2').at(0)![0]).toEqual({ content: 'Understand', status: 'inProgress' });
    expect(h.tracker.plans('ls-2').length).toBeGreaterThan(1);
  });

  it('leaves the closed plan alone on a reply: a feedback run reopens no step that nothing would close', async () => {
    const h = plain();
    h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }] }, { events: [{ kind: 'text', text: 'Corrigé.' }] });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1', ack: true });
    const closed = h.tracker.plans('ls-1').length;
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'boutons mal alignés', author: 'L', kind: 'instruction' });
    await h.advance(180_000);
    expect(h.runner.requests).toHaveLength(2);
    expect(h.tracker.plans('ls-1')).toHaveLength(closed);
  });

  it('shows the check of a run that hands the ticket over, not that of a feedback run: nothing would close it', async () => {
    const h = createHarness({ preset: testPreset() });
    h.tracker.addIssue(CLEAR);
    h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }] }, { events: [{ kind: 'text', text: 'Corrigé.' }] });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1', ack: true });
    expect(h.tracker.plans('ls-1').some((p) => p.some((s) => s.content === 'Verify' && s.status === 'inProgress'))).toBe(true);
    const closed = h.tracker.plans('ls-1').length;
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'boutons mal alignés', author: 'L', kind: 'instruction' });
    await h.advance(180_000);
    expect(h.runner.requests).toHaveLength(2);
    expect(h.tracker.plans('ls-1')).toHaveLength(closed);
  });

  it('a PR seen during the run does not end the plan: the end of the work closes it, the PR with it', async () => {
    const h = plain();
    h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }], hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1', ack: true });
    const [run] = await h.store.runsByStatus('running');
    await h.send('pr.opened', { number: 3, url: 'https://gh/pr/3', branch: 'factory/rel-1-export-csv' });
    expect(h.tracker.plans('ls-1').at(-1)!.find((s) => s.content === 'Build')).toEqual({ content: 'Build', status: 'inProgress' });
    h.runner.release(run!.id);
    await h.orch.drained();
    expect(h.tracker.plans('ls-1').at(-1)!.at(-1)).toEqual({ content: 'PR', status: 'completed' });
    expect(h.tracker.plans('ls-1').at(-1)!.some((s) => s.status === 'inProgress')).toBe(false);
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
    expect(h.tracker.comments('REL-1')).toEqual(['Got it.']);
    expect(h.runner.requests).toHaveLength(1);
  });

  it('a refused delegation gets the refusal alone, and no time of ack', async () => {
    const h = authorized();
    h.tracker.setTeamMembers('REL', []);
    const { raw, headers } = signedDelegation(h.clock.now());
    await ingestOf(h)(raw, headers);
    await h.orch.drained();
    expect(h.tracker.comments('REL-1')).toEqual([]);
    expect(h.tracker.activities('as-1')).toEqual([{ type: 'response', body: expect.stringMatching(/^Refused/) }]);
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
    expect(h.tracker.comments('REL-1')).toEqual(['Got it.']);
    expect(h.tracker.activities('ls-2')).toEqual([{ type: 'response', body: expect.stringContaining('already') }]);
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

  it('launches no run on an invalid configuration: the delegation is decided and waits in the queue (ORC-350)', async () => {
    const h = createHarness({ configProblems: ['publication impossible: it needs the sandboxes and the GitHub App'] });
    h.tracker.addIssue(CLEAR);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.orch.tick();
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
    expect(h.tracker.activities('as-1')).toEqual([{ type: 'thought', body: 'Got it.' }]);
    expect(h.tracker.comments('ZZZ-1')).toEqual(['Got it.', expect.stringContaining('ZZZ')]);
    expect(h.runner.requests).toEqual([]);
  });

  it('criterion 3, repaired: its team now has a repo, the next pass lifts the block and the label', async () => {
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
    // The 5-minute pass of the first project alone sees it too: it is told every project of the instance.
    await reconcileOnce({ ...deps, projects: [h.project, { ...h.project, id: 'zzz', teamKey: 'ZZZ' }], only: 'p' });
    await h.orch.drained();
    expect(await h.ticket('ZZZ-1')).toMatchObject({ blocked: false, delegated: false });
    expect(h.tracker.issues.get('ZZZ-1')!.labels).toEqual([]);
  });

  it('a /refreeze gets its answer alone in its session: no comment, no thought, no time of ack', async () => {
    const h = authorized();
    const { raw, headers } = signedMention('as-r', '@factory /refreeze le test était faux', h.clock.now());
    await ingestOf(h)(raw, headers);
    await h.orch.drained();
    expect(h.tracker.activities('as-r')).toEqual([{ type: 'response', body: expect.stringMatching(/^Refused/) }]);
    expect(h.tracker.comments('REL-1')).toEqual([]);
    expect((await h.store.measureFacts('p', 'REL-1')).acks).toEqual({});
  });

  describe('after a restart (ORC-220)', () => {
    const underWay = (h: ReturnType<typeof createHarness>) => h.tracker.plans('ls-1').at(-1)!.filter((s) => s.status === 'inProgress').map((s) => s.content);

    /** A delegated ticket whose attempt is at work, then gone with the process that held it. */
    async function lost(h: ReturnType<typeof createHarness>): Promise<void> {
      h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }], hold: true });
      await h.send('ticket.delegated', { linearSessionId: 'ls-1', ack: true });
      const [run] = await h.store.runsByStatus('running');
      h.runner.forget(run!.id);
    }

    it('the relaunch of a lost run keeps one active run: the plan stays on its step, a new delegation starts nothing, and the end closes the plan', async () => {
      const h = plain();
      await lost(h);
      h.runner.enqueue({ events: [{ kind: 'text', text: 'Repris.' }], hold: true });
      await h.restart({ mode: 'brutal' });
      expect(h.runner.requests).toHaveLength(2);
      const running = await h.store.runsByStatus('running');
      expect(running).toHaveLength(1);
      expect(await h.ticket()).toMatchObject({ activeRunId: running[0]!.id });
      expect(underWay(h)).toEqual(['Build']);

      await h.send('ticket.delegated', { linearSessionId: 'ls-2', ack: true });
      expect(h.runner.requests).toHaveLength(2);
      expect((await h.ticket()).pendingJob).toBeUndefined();
      expect(h.tracker.activities('ls-2')).toEqual([{ type: 'response', body: expect.stringContaining('already') }]);
      // The relaunch is nobody's trigger: the one ack stays that of the delegation.
      expect(h.tracker.comments('REL-1')).toEqual(['Got it.']);

      h.runner.release(running[0]!.id);
      await h.orch.drained();
      expect(h.runner.requests).toHaveLength(2);
      expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
      expect(underWay(h)).toEqual([]);
    });

    it('an attempt reattached is still the active run: a new delegation starts nothing, the plan does not move', async () => {
      const h = plain();
      h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }], hold: true });
      await h.send('ticket.delegated', { linearSessionId: 'ls-1', ack: true });
      const written = h.tracker.plans('ls-1').length;
      await h.restart({ mode: 'brutal' });
      await h.send('ticket.delegated', { linearSessionId: 'ls-2', ack: true });
      expect(h.runner.requests).toHaveLength(1);
      expect(h.tracker.activities('ls-2')).toEqual([{ type: 'response', body: expect.stringContaining('already') }]);
      expect(h.tracker.plans('ls-1')).toHaveLength(written);
    });

    it('the relaunch of a feedback run does not reopen the closed plan: nothing would close it', async () => {
      const h = plain();
      h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }] }, { events: [{ kind: 'text', text: 'Corrigé.' }], hold: true });
      await h.send('ticket.delegated', { linearSessionId: 'ls-1', ack: true });
      const closed = h.tracker.plans('ls-1').length;
      await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'boutons mal alignés', author: 'L', kind: 'instruction' });
      await h.advance(180_000);
      const [run] = await h.store.runsByStatus('running');
      h.runner.forget(run!.id);
      h.runner.enqueue({ events: [{ kind: 'text', text: 'Repris.' }] });
      await h.restart({ mode: 'brutal' });
      expect(h.runner.requests).toHaveLength(3);
      expect(h.tracker.plans('ls-1')).toHaveLength(closed);
    });

    it('a lost run past the bound relaunches nothing: blocked, its step stays where it stopped, as under any block', async () => {
      const h = plain();
      await lost(h);
      await h.store.putTicket({ ...(await h.ticket()), cutRelaunches: Array<number>(CUT_RELAUNCHES).fill(h.clock.now()) });
      const written = h.tracker.plans('ls-1').length;
      await h.restart({ mode: 'brutal' });
      expect(h.runner.requests).toHaveLength(1);
      expect((await h.ticket()).blockReason).toMatch(CUT_BOUND);
      expect(h.tracker.plans('ls-1')).toHaveLength(written);
      expect(underWay(h)).toEqual(['Build']);
    });
  });

  it('criterion 4: a mention gets its ack and its answer in the session under the comment, the ticket not delegated', async () => {
    const h = authorized();
    h.runner.enqueue({ events: [{ kind: 'text', text: "C'est pour garder l'ordre." }] });
    const { raw, headers } = signedMention('as-q', '@factory pourquoi ?', h.clock.now());
    await ingestOf(h)(raw, headers);
    await h.orch.drained();
    const session = h.tracker.activities('as-q');
    expect(session[0]).toEqual({ type: 'thought', body: 'Got it.' });
    expect(session.at(-1)).toEqual({ type: 'response', body: "C'est pour garder l'ordre." });
    expect(h.tracker.comments('REL-1')).toEqual([]);
    expect(await h.ticket()).toMatchObject({ delegated: false });
  });
});

describe('the acknowledgement by reaction (ORC-380, decision ORC-140)', () => {
  const reacting = (refuse = false) => {
    const h = createHarness({ acknowledge: 'reaction', authz: { githubLogins: { 'user-lilian': 'lilian' } } });
    h.tracker.setTeamMembers('REL', ['user-lilian']);
    h.forge.setRepoPermission('lilian', 'write');
    h.tracker.addIssue(CLEAR);
    if (refuse) h.tracker.refuseReactions = true;
    return h;
  };
  const warned = (h: ReturnType<typeof createHarness>) => h.logs.filter((l) => /reaction/.test(l.message));

  it('criterion 1: a mention gets a reaction on its comment and no « Got it. » comment; the sign of life is measured on it', async () => {
    const h = reacting();
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Pour garder l’ordre.' }], hold: true });
    const { raw, headers } = signedMention('as-q', '@factory pourquoi ce tri ?', h.clock.now());
    expect(await ingestOf(h)(raw, headers)).toEqual({ status: 200 });
    await h.orch.drained();
    expect(h.tracker.reactions('c-as-q')).toEqual(['👀']);
    expect(h.tracker.comments('REL-1')).toEqual([]);
    // Linear marks a session unresponsive without an activity in 10 s: the session keeps its thought.
    expect(h.tracker.activities('as-q')[0]).toEqual({ type: 'thought', body: 'Got it.' });
    const [message] = (await measureTicket(h.store, 'p', 'REL-1')).messages;
    expect(message!.signOfLifeMs).toEqual(expect.any(Number));
  });

  it('criterion 2: without the key, a mention gets no reaction, and a delegation its comment as before', async () => {
    const h = authorized();
    h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }], hold: true });
    const { raw, headers } = signedMention('as-q', '@factory pourquoi ?', h.clock.now());
    await ingestOf(h)(raw, headers);
    await h.orch.drained();
    expect(h.tracker.calls.filter((c) => c.method === 'react')).toEqual([]);
    expect(h.tracker.comments('REL-1')).toEqual([]);
  });

  it('criterion 3: a reaction Linear refuses falls back on the comment, and the fallback is logged; the sign of life still counts', async () => {
    const h = reacting(true);
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Pour garder l’ordre.' }], hold: true });
    const { raw, headers } = signedMention('as-q', '@factory pourquoi ce tri ?', h.clock.now());
    await ingestOf(h)(raw, headers);
    await h.orch.drained();
    expect(h.tracker.reactions('c-as-q')).toEqual([]);
    expect(h.tracker.comments('REL-1')).toEqual(['Got it.']);
    expect(warned(h)).toEqual([{ level: 'warn', message: expect.stringMatching(/reaction .*refused.*comment instead/) }]);
    expect((await measureTicket(h.store, 'p', 'REL-1')).messages[0]!.signOfLifeMs).toEqual(expect.any(Number));
  });

  it('a delegation has no message to react on: its comment is written, the fallback logged', async () => {
    const h = reacting();
    h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }], hold: true });
    const { raw, headers } = signedDelegation(h.clock.now());
    await ingestOf(h)(raw, headers);
    await h.orch.drained();
    expect(h.tracker.calls.filter((c) => c.method === 'react')).toEqual([]);
    expect(h.tracker.comments('REL-1')).toEqual(['Got it.']);
    expect(warned(h)).toEqual([{ level: 'info', message: expect.stringMatching(/no message to put a reaction on.*comment instead/) }]);
  });
});
