import { describe, expect, it } from 'vitest';
import { BLOCKED_LABEL } from '../../src/core/engine.js';
import { reconcileOnce } from '../../src/adapters/tracker/linear/reconcile.js';
import { blockCause } from '../../src/core/block-cause.js';
import { unroutedReason } from '../../src/core/routing.js';
import { newTicketState, type EventPayloads, type EventType, type FactoryEvent } from '../../src/core/types.js';
import { createHarness } from '../helpers/harness.js';
import { linearIngest, signedDelegation } from '../helpers/linear-webhook.js';

/** What a refused event tells a human: it names the event, the project refused and the one that holds the ticket. */
const refusal = (eventId: string, type = 'thought') => ({ type, body: expect.stringMatching(new RegExp(`${eventId}.*refusé.*\\bp\\b.*\\bapi\\b`, 's')) });

/**
 * A ticket's way out of its wait for a repo (ORC-291), on either store: each keeps a copy of the ticket per
 * project (ORC-316), and one project at most holds it.
 */
describe('an event routed on a stale read, on either store (ORC-291, ORC-316)', () => {
  it('never touches the ticket another project holds: its row stays whole, the event is set aside, logged, repairable, and said in the ticket\'s session', async () => {
    const h = createHarness({ extraProjects: ['api'] });
    h.tracker.addIssue({ identifier: 'REL-1', delegateId: 'app', description: 'x'.repeat(40) });
    const accept = async (id: string, projectId: string, payload: EventPayloads['ticket.delegated']) => {
      await h.orch.accept({ id, type: 'ticket.delegated', at: h.clock.now(), projectId, ticketId: 'REL-1', actor: 'user-1', taint: 'trusted', payload } as FactoryEvent);
      await h.orch.drained();
    };
    // A signed delegation with `repo:api`: api holds the ticket, its run under way, its branch and PR written.
    await accept('signed', 'api', { linearSessionId: 's1' });
    await h.store.updateTicket('api', 'REL-1', (t) => ({ ...t, branch: 'factory/rel-1', prNumber: 7 }));
    const held = await h.store.getTicket('api', 'REL-1');
    expect(held).toMatchObject({ delegated: true, branch: 'factory/rel-1', prNumber: 7 });
    const said = h.tracker.activities('s1').length;

    // A pass that read Linear before the label was there: its delegation, unsigned, for the first repo.
    await accept('reconcile:unrouted:p:REL-1', 'p', { issue: { title: 'T', logical: 'todo', priority: 0 }, repos: ['p', 'api'] });

    expect(await h.store.getTicket('api', 'REL-1')).toEqual(held);
    expect(await h.store.getTicket('p', 'REL-1')).toBeUndefined();
    expect(await h.store.getDeadLetter('reconcile:unrouted:p:REL-1')).toMatchObject({ status: 'open', ticketId: 'REL-1', error: expect.stringContaining('api') });
    expect(h.logs.some((l) => l.level === 'error' && l.message.includes('reconcile:unrouted:p:REL-1') && l.message.includes('api'))).toBe(true);
    // A human reads the refusal in the ticket's session; nothing else of it reached Linear: neither the question nor the Bloqué label.
    expect(h.tracker.activities('s1').slice(said)).toEqual([refusal('reconcile:unrouted:p:REL-1')]);
    expect(h.tracker.issues.get('REL-1')!.labels).not.toContain(BLOCKED_LABEL);

    // Replayed while api holds it, it is refused again, and said again; skipped, it is closed. The ticket never moves.
    await h.store.repairDeadLetter('reconcile:unrouted:p:REL-1', 'replay', 'user-1', h.clock.now());
    await h.orch.poll();
    await h.orch.drained();
    expect(await h.store.getDeadLetter('reconcile:unrouted:p:REL-1')).toMatchObject({ status: 'open', failures: 2 });
    expect(await h.store.getTicket('api', 'REL-1')).toEqual(held);
    expect(h.tracker.activities('s1').slice(said)).toEqual([refusal('reconcile:unrouted:p:REL-1'), refusal('reconcile:unrouted:p:REL-1')]);
    await h.store.repairDeadLetter('reconcile:unrouted:p:REL-1', 'skip', 'user-1', h.clock.now());
    expect(await h.store.getDeadLetter('reconcile:unrouted:p:REL-1')).toMatchObject({ status: 'skipped' });
  });

  it('the copy that waited here never starts work while another project holds the ticket: refused, and said', async () => {
    const h = createHarness({ extraProjects: ['api'] });
    h.tracker.addIssue({ identifier: 'REL-1', delegateId: 'app', description: 'x'.repeat(40) });
    const accept = async (id: string, projectId: string, payload: EventPayloads['ticket.delegated']) => {
      await h.orch.accept({ id, type: 'ticket.delegated', at: h.clock.now(), projectId, ticketId: 'REL-1', actor: 'user-1', taint: 'trusted', payload } as FactoryEvent);
      await h.orch.drained();
    };
    await accept('wait', 'p', { linearSessionId: 's1', repos: ['p', 'api'] });
    await accept('signed', 'api', { linearSessionId: 's2', waitedIn: 'p' });
    const [waiting, held] = [await h.store.getTicket('p', 'REL-1'), await h.store.getTicket('api', 'REL-1')];
    expect(waiting).toMatchObject({ awaitingRepo: ['p', 'api'] });
    expect(h.runner.requests).toHaveLength(1);

    // Routed to the repo it waited in, on a read older than api's delegation.
    await accept('stale', 'p', { linearSessionId: 's3' });

    expect(await h.store.getTicket('p', 'REL-1')).toEqual(waiting);
    expect(await h.store.getTicket('api', 'REL-1')).toEqual(held);
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.store.getDeadLetter('stale')).toMatchObject({ status: 'open' });
    expect(h.tracker.activities('s2').at(-1)).toEqual(refusal('stale'));
    expect(h.tracker.activities('s3')).toEqual([refusal('stale', 'response')]);
  });

  it('two copies that debounce the same job keep a timer each, and each fires: a project workflow debouncing a question (ORC-316)', async () => {
    // Not the standard pack: it debounces only `dev-feedback`, which a copy that does not hold the ticket never arms.
    const h = createHarness({ extraProjects: ['api'], projectYaml: 'version: 1\non:\n  session.mentioned:\n    - { run: ask, debounce: 1m }\n' });
    h.tracker.addIssue({ identifier: 'REL-1', description: 'x'.repeat(40) });
    const mention = async (id: string, projectId: string, session: string) => {
      await h.orch.accept({ id, type: 'session.mentioned', at: h.clock.now(), projectId, ticketId: 'REL-1', actor: 'user-1', taint: 'trusted', payload: { linearSessionId: session, body: 'Pourquoi ?', author: 'A' } } as FactoryEvent);
      await h.orch.drained();
    };
    await mention('m1', 'api', 's1');
    await h.advance(1000);
    await mention('m2', 'p', 's2');

    const armed = (await h.store.dueTimers(Number.MAX_SAFE_INTEGER)).filter((t) => t.kind === 'debounce');
    expect(armed.map((t) => t.projectId).sort()).toEqual(['api', 'p']);
    await h.advance(60_000);
    expect(h.runner.requests).toHaveLength(2);
  });

  it('a row left by a project no longer in the configuration refuses nothing: the project renamed takes its events (ORC-316)', async () => {
    const h = createHarness({ extraProjects: ['api'] });
    h.tracker.addIssue({ identifier: 'REL-1', delegateId: 'app', description: 'x'.repeat(40) });
    const old = { ...newTicketState('old-name', 'REL-1', 'T', 'dev', 1), delegated: true, branch: 'factory/rel-1' };
    await h.store.putTicket(old);
    await h.orch.accept({ id: 'renamed', type: 'ticket.delegated', at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', actor: 'user-1', taint: 'trusted', payload: { linearSessionId: 's1' } } as FactoryEvent);
    await h.orch.drained();
    expect(await h.store.getDeadLetter('renamed')).toBeUndefined();
    expect(await h.store.getTicket('p', 'REL-1')).toMatchObject({ delegated: true, linearSessionId: 's1' });
    expect(await h.store.getTicket('old-name', 'REL-1')).toEqual(old);
  });
});

describe('a stale event brought by the webhook with its ack, on either store (ORC-171, ORC-291, ORC-316)', () => {
  it.each([
    ['a delegation routed by a stale read', { linearSessionId: 's9', ack: true as const }],
    ['a delegation for a team believed to have no repo', { linearSessionId: 's9', noRepo: 'REL' }],
  ])('%s never touches the row another project holds: no ack, no plan, the refusal said in both sessions', async (_name, payload) => {
    const h = createHarness({ extraProjects: ['api'] });
    h.tracker.addIssue({ identifier: 'REL-1', delegateId: 'app', description: 'x'.repeat(40) });
    const accept = async (id: string, projectId: string, p: EventPayloads['ticket.delegated']) => {
      await h.orch.accept({ id, type: 'ticket.delegated', at: h.clock.now(), projectId, ticketId: 'REL-1', actor: 'user-1', taint: 'trusted', payload: p } as FactoryEvent);
      await h.orch.drained();
    };
    await accept('signed', 'api', { linearSessionId: 's1', ack: true });
    await h.store.updateTicket('api', 'REL-1', (t) => ({ ...t, branch: 'factory/rel-1' }));
    const held = await h.store.getTicket('api', 'REL-1');
    const acks = h.tracker.comments('REL-1');

    await accept('stale', 'p', payload);

    expect(await h.store.getTicket('api', 'REL-1')).toEqual(held);
    expect(await h.store.getDeadLetter('stale')).toMatchObject({ status: 'open', error: expect.stringContaining('api') });
    expect(h.tracker.comments('REL-1')).toEqual(acks);
    // The ticket's session, and the one the human who delegated is looking at.
    expect(h.tracker.activities('s1').at(-1)).toEqual(refusal('stale'));
    expect(h.tracker.activities('s9')).toEqual([refusal('stale', 'response')]);
    expect(h.tracker.plans('s9')).toEqual([]);
    expect(h.runner.requests).toHaveLength(1);
  });
});

/** The whole way, from Linear's webhook: what the two features meet on (ORC-171, ORC-291). */
describe('routed from the webhook, on either store', () => {
  const STOPS = { events: [{ kind: 'text' as const, text: 'PR ouverte.' }], hold: true };

  function daemon(teams: Record<string, string[]>) {
    const h = createHarness({ extraProjects: [...new Set(Object.values(teams).flat())].filter((id) => id !== 'p') });
    const ctx = {
      projectsOfTeam: (k: string) => teams[k] ?? [],
      firstProject: () => 'p',
      labelsOf: async (id: string) => (await h.tracker.getIssue(id)).labels,
      ticket: (p: string, id: string) => h.store.getTicket(p, id),
    };
    const ingest = linearIngest((e) => h.orch.accept(e), { now: () => h.clock.now(), ctx });
    const delegate = async (ticket: string, session: string) => {
      const { raw, headers } = signedDelegation(h.clock.now(), ticket, session);
      expect(await ingest(raw, headers)).toEqual({ status: 200 });
      await h.orch.drained();
    };
    return { h, delegate };
  }
  const issue = (h: ReturnType<typeof createHarness>, identifier: string) => h.tracker.addIssue({ identifier, title: 'Export', delegateId: 'app', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  const planKeys = async (h: ReturnType<typeof createHarness>, projects: string[], ticket: string) => {
    const found: string[] = [];
    for (const p of projects) if (await h.store.getMeta(`plan:${p}:${ticket}`)) found.push(p);
    return found;
  };

  it('a team with several repos and no label waits and asks: no ack, no plan, no run', async () => {
    const { h, delegate } = daemon({ REL: ['p', 'api'] });
    issue(h, 'REL-1');
    await delegate('REL-1', 'as-1');
    const t = await h.store.getTicket('p', 'REL-1');
    expect(t).toMatchObject({ blocked: true, delegated: true, awaitingRepo: ['p', 'api'] });
    expect(blockCause(t!.blockReason)).toBe('pickup');
    expect(h.tracker.activities('as-1')).toEqual([{ type: 'thought', body: 'Bien reçu.' }]);
    expect(h.tracker.comments('REL-1')).toEqual(['Bien reçu.', expect.stringContaining(unroutedReason(['p', 'api']))]);
    expect(h.tracker.plans('as-1')).toEqual([]);
    expect(h.tracker.issues.get('REL-1')!.labels).toContain(BLOCKED_LABEL);
    expect(h.runner.requests).toEqual([]);
  });

  it.each([['another repo', 'repo:api', 'api'], ['the repo it waits in', 'repo:p', 'p']])('the wait ends by a label naming %s: one run, one ack and the plan on that project\'s ticket, in the new session', async (_name, label, project) => {
    const { h, delegate } = daemon({ REL: ['p', 'api'] });
    issue(h, 'REL-1');
    await delegate('REL-1', 'as-1');
    h.tracker.issues.get('REL-1')!.labels.push(label);
    h.runner.enqueue(STOPS);
    await delegate('REL-1', 'as-2');

    expect(await h.store.getTicket(project, 'REL-1')).toMatchObject({ blocked: false, delegated: true, linearSessionId: 'as-2', activeRunId: expect.any(String) });
    expect(h.runner.requests).toHaveLength(1);
    expect(h.tracker.comments('REL-1')).toEqual(['Bien reçu.', expect.stringContaining(unroutedReason(['p', 'api'])), 'Bien reçu.']);
    expect(h.tracker.activities('as-2')[0]).toEqual({ type: 'thought', body: 'Bien reçu.' });
    expect(h.tracker.activities('as-1')).toEqual([{ type: 'thought', body: 'Bien reçu.' }]);
    expect(h.tracker.plans('as-2')[0]![0]).toEqual(expect.objectContaining({ content: 'Comprendre' }));
    expect(h.tracker.plans('as-1')).toEqual([]);
    expect(await planKeys(h, ['p', 'api'], 'REL-1')).toEqual([project]);
    expect(h.tracker.issues.get('REL-1')!.labels).not.toContain(BLOCKED_LABEL);

    // The next pass finds the copy that waited: no second ack, no second run, and no block back.
    await reconcileOnce({ tracker: h.tracker, store: h.store, projects: ['p', 'api'].map((id) => ({ ...h.project, id })), submit: (e) => h.orch.accept(e), clock: h.clock, log: () => {} });
    await h.orch.drained();
    expect(h.runner.requests).toHaveLength(1);
    expect(h.tracker.comments('REL-1').filter((c) => c === 'Bien reçu.')).toHaveLength(2);
    expect(h.tracker.issues.get('REL-1')!.labels).not.toContain(BLOCKED_LABEL);
    expect(await h.store.getTicket(project, 'REL-1')).toMatchObject({ blocked: false, delegated: true });
  });

  it('a delegation while the routed run is at work starts nothing and acks nothing: one active run', async () => {
    const { h, delegate } = daemon({ REL: ['p', 'api'] });
    issue(h, 'REL-1');
    h.tracker.issues.get('REL-1')!.labels.push('repo:api');
    h.runner.enqueue(STOPS);
    await delegate('REL-1', 'as-1');
    await delegate('REL-1', 'as-2');
    expect(h.runner.requests).toHaveLength(1);
    expect(h.tracker.comments('REL-1')).toEqual(['Bien reçu.']);
    expect(h.tracker.activities('as-2')).toEqual([{ type: 'response', body: expect.stringContaining('déjà') }]);
    expect(await h.store.getTicket('api', 'REL-1')).toMatchObject({ linearSessionId: 'as-1', activeRunId: expect.any(String) });
  });

  it('a team with no repo blocks under the first project, whatever its labels: no ack, no run', async () => {
    const { h, delegate } = daemon({ REL: ['p', 'api'] });
    issue(h, 'ZZZ-1');
    h.tracker.issues.get('ZZZ-1')!.labels.push('repo:api');
    await delegate('ZZZ-1', 'as-1');
    const t = await h.store.getTicket('p', 'ZZZ-1');
    expect(t).toMatchObject({ blocked: true, delegated: true, awaitingRepo: [] });
    expect(blockCause(t!.blockReason)).toBe('pickup');
    expect(h.tracker.activities('as-1')).toEqual([{ type: 'thought', body: 'Bien reçu.' }]);
    expect(h.tracker.comments('ZZZ-1')).toEqual(['Bien reçu.', expect.stringContaining('ZZZ')]);
    expect(h.runner.requests).toEqual([]);
    // Delegated again, still none: asked again, and the wait does not end by itself.
    await delegate('ZZZ-1', 'as-2');
    expect(await h.store.getTicket('p', 'ZZZ-1')).toMatchObject({ blocked: true, awaitingRepo: [] });
    expect(h.tracker.activities('as-2')).toEqual([{ type: 'thought', body: 'Bien reçu.' }]);
    expect(h.tracker.comments('ZZZ-1').at(-1)).toContain('🔴 Bloqué');
    expect(h.runner.requests).toEqual([]);
  });

  it('its team given a repo, the delegation is not refused as held: the work starts there before any pass, with one ack, and the label goes', async () => {
    const teams: Record<string, string[]> = { REL: ['p', 'zzz'] };
    const { h, delegate } = daemon(teams);
    issue(h, 'ZZZ-1');
    await delegate('ZZZ-1', 'as-1');
    expect(await h.store.getTicket('p', 'ZZZ-1')).toMatchObject({ awaitingRepo: [] });
    expect(h.tracker.issues.get('ZZZ-1')!.labels).toContain(BLOCKED_LABEL);

    // The configuration changed and the factory restarted: the team has its project, no pass has run yet.
    teams['REL'] = ['p'];
    teams['ZZZ'] = ['zzz'];
    h.runner.enqueue(STOPS);
    await delegate('ZZZ-1', 'as-2');

    expect(await h.store.getTicket('zzz', 'ZZZ-1')).toMatchObject({ blocked: false, delegated: true, linearSessionId: 'as-2', activeRunId: expect.any(String) });
    expect(await h.store.deadLetters('ZZZ-1')).toEqual([]);
    expect(h.runner.requests).toHaveLength(1);
    expect(h.tracker.comments('ZZZ-1')).toEqual(['Bien reçu.', expect.stringContaining('ZZZ'), 'Bien reçu.']);
    expect(h.tracker.plans('as-2')[0]![0]).toEqual(expect.objectContaining({ content: 'Comprendre' }));
    expect(await planKeys(h, ['p', 'zzz'], 'ZZZ-1')).toEqual(['zzz']);
    expect(h.tracker.issues.get('ZZZ-1')!.labels).not.toContain(BLOCKED_LABEL);
  });
});

describe('a ticket waiting for its repo, once a human chose it (ORC-291)', () => {
  const repos = ['p', 'api'];
  const signed = { actor: 'user-1', taint: 'trusted' as const };

  async function waiting() {
    const h = createHarness({ extraProjects: ['api'] });
    h.tracker.addIssue({ identifier: 'REL-1', delegateId: 'app', description: 'x'.repeat(40) });
    let seq = 0;
    const to = async <T extends EventType>(projectId: string, type: T, payload: EventPayloads[T]) => {
      await h.orch.accept({ id: `r-${++seq}`, type, at: h.clock.now(), projectId, ticketId: 'REL-1', ...signed, payload } as FactoryEvent);
      await h.orch.drained();
    };
    await to('p', 'ticket.delegated', { linearSessionId: 's1', repos });
    expect(await h.store.getTicket('p', 'REL-1')).toMatchObject({ blockReason: unroutedReason(repos), awaitingRepo: repos });
    expect(h.tracker.issues.get('REL-1')!.labels).toContain(BLOCKED_LABEL);
    return { h, to };
  }

  it('a delegation with the choice to make, on an issue deleted meanwhile, leaves no ticket and writes nothing to Linear (ORC-302)', async () => {
    const h = createHarness({ extraProjects: ['api'] });
    await h.orch.accept({ id: 'gone', type: 'ticket.delegated', at: h.clock.now(), projectId: 'p', ticketId: 'REL-9', ...signed, payload: { linearSessionId: 's1', repos } } as FactoryEvent);
    await h.orch.drained();
    expect(await h.store.getTicket('p', 'REL-9')).toBeUndefined();
    expect(h.tracker.calls.filter((c) => c.method !== 'getIssue')).toEqual([]);
    expect(h.runner.requests).toEqual([]);
  });

  it('its label names the repo it waits in: a new delegation lifts the wait and starts the work there', async () => {
    const { h, to } = await waiting();
    await to('p', 'ticket.delegated', { linearSessionId: 's2' });
    expect(await h.store.getTicket('p', 'REL-1')).toMatchObject({ blocked: false, delegated: true, awaitingRepo: null });
    expect(h.runner.requests).toHaveLength(1);
    expect(h.tracker.issues.get('REL-1')!.labels).not.toContain(BLOCKED_LABEL);
  });

  it('its label names another repo: the work starts there and the Bloqué label goes, with no pass needed', async () => {
    const { h, to } = await waiting();
    await to('api', 'ticket.delegated', { linearSessionId: 's2', waitedIn: 'p' });
    expect(await h.store.getTicket('api', 'REL-1')).toMatchObject({ blocked: false, delegated: true });
    expect(h.runner.requests).toHaveLength(1);
    expect(h.tracker.issues.get('REL-1')!.labels).not.toContain(BLOCKED_LABEL);
  });

  it('the wait lifted late, from a copy the store may no longer hold, leaves the ticket in its repo as it is', async () => {
    const { h, to } = await waiting();
    await to('api', 'ticket.delegated', { linearSessionId: 's2', waitedIn: 'p' });
    await to('p', 'ticket.undelegated', {});
    expect(await h.store.getTicket('api', 'REL-1')).toMatchObject({ blocked: false, delegated: true });
    expect(h.tracker.issues.get('REL-1')!.labels).not.toContain(BLOCKED_LABEL);
  });
});
