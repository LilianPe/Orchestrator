import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLES_TTL_MS } from '../../src/adapters/roles/cached.js';
import { runRepair } from '../../src/cli/repair.js';
import { loadWorkflow } from '../../src/config/load-workflow.js';
import { TRUSTED, type FactoryEvent } from '../../src/core/types.js';
import type { StoredEvent } from '../../src/core/upcast.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import type { DecisionRequest, Store } from '../../src/store/types.js';
import type { WorkspaceRequest } from '../../src/adapters/workspace/types.js';
import { CRASH_WORKFLOW, crashAfterDecision } from '../helpers/crash-workflow.js';
import { createHarness, harnessStoreKind, packDir } from '../helpers/harness.js';

const waitFor = async (cond: () => boolean | Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 400 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 5));
  expect(await cond()).toBe(true);
};

/** A promise the test opens by hand: where it holds a call, or waits for one to get there. */
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
};

/**
 * ORC-149: the worker decides each inbox row in one transaction (journal, projection, outbox,
 * timers, inbox mark), one task per ticket, and executes the outbox rows after the commit.
 */
/** On a SQLite file: test/integration/worker-pg.test.ts kills the daemon on Postgres. */
const onSqliteFile = harnessStoreKind() === 'postgres' ? it.skip : it;

describe('worker: per-ticket lock and decision transaction', () => {
  onSqliteFile.each([
    { killAt: 1, done: [] as string[], label: 'before any effect' },
    { killAt: 2, done: ['REL-1:1:1'], label: 'after its first effect' },
  ])('loses no event and doubles no effect when killed with SIGKILL after the commit, $label', async ({ killAt, done }) => {
    const file = join(mkdtempSync(join(tmpdir(), 'factory-worker-')), 'factory.db');
    const { completed } = crashAfterDecision(file, killAt);
    expect(completed).toEqual(done);

    const h = createHarness({ store: new SqliteStore(file), projectYaml: CRASH_WORKFLOW });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    // Committed before the kill: journal, projection and the three outbox rows, the inbox row processed.
    expect((await h.store.recentEvents(10, 'REL-1')).map((e) => e.type)).toEqual(['ticket.delegated']);
    expect(await h.ticket()).toMatchObject({ delegated: true });
    // The result of each effect done before the kill, written with its row (ORC-150).
    expect((await h.store.pendingInbox(10)).map((e) => e.id)).toEqual(done.map((id) => `effect:${id}`));
    expect((await h.store.listEffects('p', 'REL-1')).map((r) => [r.id, r.effect.kind])).toEqual([
      ['REL-1:1:1', 'labels'],
      ['REL-1:1:2', 'comment'],
      ['REL-1:1:3', 'start_run'],
    ]);

    await h.restart();
    // The rows left are executed once each, and only those (the run's end decides more afterwards).
    expect((await h.store.listEffects('p', 'REL-1')).slice(0, 3).map((r) => r.status)).toEqual(['done', 'done', 'done']);
    const labels = h.tracker.calls.filter((c) => c.method === 'setLabels');
    expect(labels).toHaveLength(killAt === 1 ? 1 : 0);
    expect(h.tracker.calls.filter((c) => c.method === 'comment').map((c) => c.args[1])).toEqual(['Pris en charge.']);
    expect(h.runner.requests).toHaveLength(1);
    expect((await h.store.recentEvents(50, 'REL-1')).filter((e) => e.type === 'ticket.delegated')).toHaveLength(1);

    // Another start finds nothing left to do.
    await h.restart();
    expect(h.runner.requests).toHaveLength(1);
  });

  onSqliteFile('writes nothing of a decision cut by SIGKILL before its commit, and decides it once at the next start', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'factory-worker-')), 'factory.db');
    expect(crashAfterDecision(file, 0).completed).toEqual([]);

    const h = createHarness({ store: new SqliteStore(file), projectYaml: CRASH_WORKFLOW });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    expect(await h.store.recentEvents(10)).toEqual([]);
    expect(await h.store.getTicket('p', 'REL-1')).toBeUndefined();
    expect(await h.store.listEffects('p', 'REL-1')).toEqual([]);
    expect((await h.store.pendingInbox(10)).map((e) => e.type)).toEqual(['ticket.delegated']);

    await h.restart();
    expect((await h.store.recentEvents(50, 'REL-1')).filter((e) => e.type === 'ticket.delegated')).toHaveLength(1);
    expect(h.tracker.calls.filter((c) => c.method === 'comment')).toHaveLength(1);
    expect(h.runner.requests).toHaveLength(1);
  });

  it('decides a ticket while another one is held in a long workspace setup (criterion 5)', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.tracker.addIssue({ identifier: 'REL-2', title: 'Import CSV' });
    let release!: () => void;
    const npmCi = new Promise<void>((r) => (release = r));
    const prepare = h.workspaces.prepare.bind(h.workspaces);
    h.workspaces.prepare = async (req: WorkspaceRequest) => {
      if (req.ticketId === 'REL-1') await npmCi;
      return prepare(req);
    };
    const event = (id: string, ticketId: string) =>
      ({ ...TRUSTED, id, type: 'ticket.delegated' as const, at: h.clock.now(), projectId: 'p', ticketId, payload: { linearSessionId: `ls-${ticketId}` } });

    await h.orch.accept(event('d1', 'REL-1'));
    // REL-1's start_run is in its setup (the outbox row runs under its lease).
    await waitFor(async () => (await h.store.listEffects('p', 'REL-1')).some((r) => r.effect.kind === 'start_run' && r.status === 'running'));
    await h.orch.accept(event('d2', 'REL-2'));
    // REL-2 is decided and its effects run while REL-1 is still in its setup.
    await waitFor(async () => {
      const rows = await h.store.listEffects('p', 'REL-2');
      return rows.length > 0 && rows.every((r) => r.status === 'done');
    });
    expect(await h.ticket('REL-2')).toMatchObject({ delegated: true });
    expect((await h.store.listEffects('p', 'REL-1')).map((r) => [r.effect.kind, r.status])).toEqual([['start_run', 'running']]);
    expect(h.workspaces.prepared.map((r) => r.ticketId)).not.toContain('REL-1');

    release();
    await h.orch.drained();
    expect(h.workspaces.prepared.map((r) => r.ticketId)).toContain('REL-1');
    expect(h.runner.requests).toHaveLength(2);
  });

  it('keeps a ticket on the workflow version it started with when the workflow changes (criterion 4)', async () => {
    const version = (comment: string) => `
version: 1
on:
  label.changed:
    - { label: "agent:x", comment: "${comment}" }
`;
    const h = createHarness({ projectYaml: version('ancienne version') });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.tracker.addIssue({ identifier: 'REL-2', title: 'Import CSV' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const frozen = (await h.ticket()).workflowHash;
    expect(frozen).toMatch(/^[0-9a-f]{64}$/);

    const file = join(mkdtempSync(join(tmpdir(), 'factory-wf-')), 'workflow.yml');
    writeFileSync(file, version('nouvelle version'));
    h.project.workflow = loadWorkflow({ packDir, projectFile: file });
    await h.restart();

    await h.send('label.changed', { label: 'agent:x', change: 'added' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-2' }, 'REL-2');
    await h.send('label.changed', { label: 'agent:x', change: 'added' }, 'REL-2');
    const comments = h.tracker.calls.filter((c) => c.method === 'comment').map((c) => [c.args[0], c.args[1]]);
    expect(comments).toEqual([
      ['REL-1', 'ancienne version'],
      ['REL-2', 'nouvelle version'],
    ]);
    expect((await h.ticket()).workflowHash).toBe(frozen);
    expect((await h.ticket('REL-2')).workflowHash).not.toBe(frozen);
  });

  it('writes the effects of a decision to the outbox as ticket:seq:i, seq the journal position (criterion 3)', async () => {
    const h = createHarness({ projectYaml: CRASH_WORKFLOW });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const journal = (await h.store.recentEvents(50, 'REL-1')).reverse().map((e) => e.id);
    const rows = await h.store.listEffects('p', 'REL-1');
    expect(rows.length).toBeGreaterThan(3);
    for (const r of rows) {
      expect(r.id).toBe(`REL-1:${r.seq}:${r.i}`);
      expect(journal[r.seq - 1]).toBe(r.eventId);
    }
    expect(rows.slice(0, 3).map((r) => r.id)).toEqual(['REL-1:1:1', 'REL-1:1:2', 'REL-1:1:3']);
  });

  it('takes an event id once: the inbox key dedups it before any decision', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    const e = { ...TRUSTED, id: 'd1', type: 'ticket.delegated' as const, at: 1, projectId: 'p', ticketId: 'REL-1', payload: { linearSessionId: 'ls-1' } };
    expect(await h.orch.accept(e)).toBe(true);
    expect(await h.orch.accept(e)).toBe(false);
    await h.orch.drained();
    expect(h.runner.requests).toHaveLength(1);
    expect((await h.store.recentEvents(10, 'REL-1')).filter((x) => x.id === 'd1')).toHaveLength(1);
  });

  describe('a row whose processing throws', () => {
    const delegation = (h: ReturnType<typeof createHarness>, id: string, ticketId = 'REL-1') =>
      ({ ...TRUSTED, id, type: 'ticket.delegated' as const, at: h.clock.now(), projectId: 'p', ticketId, payload: { linearSessionId: `ls-${ticketId}` } });
    const stop = (h: ReturnType<typeof createHarness>, id: string) =>
      ({ ...TRUSTED, id, type: 'control.stop' as const, at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload: {} });

    it('is retried in the same process after a backoff, then lets the rows behind it through, in order', async () => {
      const h = createHarness({ processRetry: { attempts: 4, baseMs: 5 } });
      h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
      const getIssue = h.tracker.getIssue.bind(h.tracker);
      let failures = 2;
      h.tracker.getIssue = async (id: string) => {
        if (failures > 0) {
          failures--;
          throw new Error('Linear unreachable');
        }
        return getIssue(id);
      };
      h.runner.enqueue({ hold: true });
      await h.orch.accept(delegation(h, 'd1'));
      // A stop behind the failed delegation is not lost: it goes once the delegation passes.
      await h.orch.accept(stop(h, 's1'));
      await waitFor(async () => (await h.store.pendingInbox(10)).length === 0);
      await h.orch.drained();
      const types = (await h.store.recentEvents(10, 'REL-1')).map((e) => e.id).reverse();
      expect(types.slice(0, 2)).toEqual(['d1', 's1']);
      expect(await h.ticket()).toMatchObject({ delegated: true, blocked: true, blockReason: 'Arrêté à la demande' });
    });

    it('waits for the next start past its last retry, with the rows of its ticket, other tickets aside', async () => {
      const h = createHarness({ processRetry: { attempts: 3, baseMs: 1 } });
      h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
      h.tracker.addIssue({ identifier: 'REL-2', title: 'Import CSV' });
      const getIssue = h.tracker.getIssue.bind(h.tracker);
      let down = true;
      let tries = 0;
      h.tracker.getIssue = async (id: string) => {
        if (down && id === 'REL-1') {
          tries++;
          throw new Error('Linear unreachable');
        }
        return getIssue(id);
      };
      await h.orch.accept(delegation(h, 'd1'));
      await h.orch.accept(stop(h, 's1'));
      await waitFor(() => tries === 3);
      await new Promise((r) => setTimeout(r, 30));
      expect(tries).toBe(3);
      await h.send('ticket.delegated', { linearSessionId: 'ls-2' }, 'REL-2');
      expect(await h.ticket('REL-2')).toMatchObject({ delegated: true });
      expect((await h.store.pendingInbox(10)).map((e) => e.id)).toEqual(['d1', 's1']);

      down = false;
      await h.restart();
      expect((await h.store.recentEvents(10, 'REL-1')).map((e) => e.id).reverse().slice(0, 2)).toEqual(['d1', 's1']);
      expect(await h.store.pendingInbox(10)).toEqual([]);
    });

    it('holds the later events without a ticket of its project too, instead of leaving them waiting unseen', async () => {
      let broken = true;
      const decided: string[] = [];
      const wrapStore = (inner: Store) =>
        Object.assign(Object.create(inner) as Store, {
          decide: (req: DecisionRequest) => {
            decided.push(req.event.id);
            if (broken && req.event.id === 'g1') throw new Error('database hiccup');
            return inner.decide(req);
          },
        });
      const h = createHarness({ wrapStore, processRetry: { attempts: 1, baseMs: 1 } });
      const global = (id: string, type: 'control.pause' | 'control.resume') =>
        ({ ...TRUSTED, id, type, at: h.clock.now(), projectId: '*', payload: {} });
      await h.orch.accept(global('g1', 'control.pause'));
      await h.orch.accept(global('g2', 'control.resume'));
      await h.orch.drained();
      // g2 is held behind g1 by this process: never even sent to the store.
      expect(decided).toEqual(['g1']);
      expect((await h.store.pendingInbox(10)).map((e) => e.id)).toEqual(['g1', 'g2']);

      broken = false;
      await h.restart();
      expect(decided.slice(1).filter((id) => !id.startsWith('effect:'))).toEqual(['g1', 'g2']);
      expect(await h.store.getMeta('paused')).toBe('0');
    });

    it('lets the older row parked before it go first, oldest first, without a restart (ORC-314)', async () => {
      let hiccup = true;
      const decided: string[] = [];
      const h = createHarness({
        projectYaml: CRASH_WORKFLOW,
        processRetry: { attempts: 5, baseMs: 1 },
        // A backoff no real timer reaches during the test: only the polls below end it.
        effectRetry: { attempts: 2, baseMs: 60_000, capMs: 60_000 },
        wrapStore: (inner) =>
          Object.assign(Object.create(inner) as Store, {
            decide: async (req: DecisionRequest) => {
              if (hiccup && req.event.id === 'younger') {
                hiccup = false;
                throw new Error('database hiccup');
              }
              const outcome = await inner.decide(req);
              decided.push(`${req.event.id}:${outcome.status}`);
              return outcome;
            },
          }),
      });
      h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
      h.tracker.comment = async () => {
        throw new Error('Linear down');
      };
      await h.orch.accept(delegation(h, 'd1'));
      await h.orch.drained();
      // The result of the labels is parked behind the comment's backoff.
      expect((await h.store.pendingInbox(10)).map((e) => e.id)).toEqual(['effect:REL-1:1:1']);

      // A younger row gets to the store all the same (a stop may pass a backoff), and fails there.
      await h.orch.accept({ ...TRUSTED, id: 'younger', type: 'status.changed', at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload: { from: 'todo', to: 'todo' } });
      await waitFor(() => decided.includes('younger:waiting'));

      // The comment's last attempt dies, at the first poll. The worker goes on polling, with no restart.
      for (let polls = 0; polls < 3; polls++) await h.advance(60_000);

      expect((await h.store.pendingInbox(10)).map((e) => e.id)).toEqual([]);
      expect(decided.filter((d) => /^(effect:REL-1:1:[12]|younger):committed$/.test(d))).toEqual(['effect:REL-1:1:1:committed', 'younger:committed', 'effect:REL-1:1:2:committed']);
      expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Erreur : Linear down' });
    });

    describe('past its last retry, with an older row of its ticket parked (ORC-315)', () => {
      /** `younger` throws at each decision while `broken`; `attempt` runs in that decision, before it throws. */
      function failingYounger(attempts: number, attempt: (n: number) => void | Promise<void>) {
        const state = { broken: true, tries: 0 };
        const decided: string[] = [];
        const h = createHarness({
          projectYaml: CRASH_WORKFLOW,
          processRetry: { attempts, baseMs: 1 },
          // A backoff no real timer reaches during the test: only `advance` ends it.
          effectRetry: { attempts: 2, baseMs: 60_000, capMs: 60_000 },
          wrapStore: (inner) =>
            Object.assign(Object.create(inner) as Store, {
              decide: async (req: DecisionRequest) => {
                if (state.broken && req.event.id === 'younger') {
                  await attempt(++state.tries);
                  throw new Error('database hiccup');
                }
                const outcome = await inner.decide(req);
                decided.push(`${req.event.id}:${outcome.status}`);
                return outcome;
              },
            }),
        });
        h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
        h.tracker.comment = async () => {
          throw new Error('Linear down');
        };
        const younger = { ...TRUSTED, id: 'younger', type: 'status.changed' as const, at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload: { from: 'todo', to: 'todo' } };
        return { h, state, decided, younger };
      }

      /** The older row is decided with no restart; the result of the effect that died after `younger` came stays behind it. */
      async function olderDecidedThenRestart({ h, state, decided }: Pick<ReturnType<typeof failingYounger>, 'h' | 'state' | 'decided'>) {
        await h.advance(60_000);
        expect(decided).toContain('effect:REL-1:1:1:committed');
        expect((await h.store.pendingInbox(10)).map((e) => e.id)).toEqual(['younger', 'effect:REL-1:1:2']);
        expect((await h.ticket()).blocked).toBe(false);

        state.broken = false;
        await h.restart();
        expect(await h.store.pendingInbox(10)).toEqual([]);
        expect(decided.filter((d) => /^(effect:REL-1:1:[12]|younger):committed$/.test(d))).toEqual(['effect:REL-1:1:1:committed', 'younger:committed', 'effect:REL-1:1:2:committed']);
        expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Erreur : Linear down' });
      }

      it('lets the older row go, without a restart', async () => {
        const exhausted = gate();
        const scenario = failingYounger(3, (n) => {
          if (n === 3) exhausted.open();
        });
        const { h } = scenario;
        await h.orch.accept(delegation(h, 'd1'));
        await h.orch.drained();
        expect((await h.store.pendingInbox(10)).map((e) => e.id)).toEqual(['effect:REL-1:1:1']);

        await h.orch.accept(scenario.younger);
        await exhausted.opened;
        await h.orch.drained();

        await olderDecidedThenRestart(scenario);
      });

      it('lets it go when a poll read it behind the attempt still running, before that attempt failed', async () => {
        const inDecision = gate();
        const answer = gate();
        const scenario = failingYounger(1, async () => {
          inDecision.open();
          await answer.opened;
        });
        const { h } = scenario;
        await h.orch.accept(delegation(h, 'd1'));
        await h.orch.drained();

        await h.orch.accept(scenario.younger);
        await inDecision.opened;
        // Read again now, it queues behind `younger` in its ticket's task: no failed row holds the ticket yet.
        await h.orch.poll();
        answer.open();
        await h.orch.drained();

        await olderDecidedThenRestart(scenario);
      });
    });

    describe('past its last attempt, without a restart (ORC-320)', () => {
      const ATTEMPTS = 2;
      const younger = (h: ReturnType<typeof createHarness>) =>
        ({ ...TRUSTED, id: 'younger', type: 'status.changed' as const, at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload: { from: 'todo', to: 'todo' } });
      const journaled = async (h: ReturnType<typeof createHarness>) => (await h.store.recentEvents(50, 'REL-1')).map((e) => e.id).reverse();
      const repair = (h: ReturnType<typeof createHarness>) => runRepair({ store: h.store, target: 'REL-1', action: 'replay', by: 'armand', now: h.clock.now(), print: () => {} });

      /** `younger` throws at each decision while `broken`; `attempt` runs in that decision, before it throws. */
      function failing(attempt: (n: number) => void | Promise<void> = () => {}, wrap: (inner: Store, state: { broken: boolean; decided: string[] }) => Partial<Store> = () => ({})) {
        const state = { broken: true, decided: [] as string[] };
        let tries = 0;
        const h = createHarness({
          projectYaml: CRASH_WORKFLOW,
          processRetry: { attempts: ATTEMPTS, baseMs: 1 },
          // A backoff no real timer reaches during the test: only `advance` ends it.
          effectRetry: { attempts: 2, baseMs: 60_000, capMs: 60_000 },
          wrapStore: (inner) =>
            Object.assign(Object.create(inner) as Store, {
              decide: async (req: DecisionRequest) => {
                if (state.broken && req.event.id === 'younger') {
                  await attempt(++tries);
                  throw new Error('database hiccup');
                }
                const outcome = await inner.decide(req);
                state.decided.push(`${req.event.id}:${outcome.status}`);
                return outcome;
              },
              ...wrap(inner, state),
            }),
        });
        h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
        return { h, state };
      }

      /** A tracked ticket with roles to read; `attempt` runs in each read of them, which throws until `up`. */
      async function rolesDown(attempt: (n: number) => void) {
        const h = createHarness({ processRetry: { attempts: ATTEMPTS, baseMs: 1 }, authz: { githubLogins: { 'user-lilian': 'lilian-gh' } } });
        h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
        h.tracker.setTeamMembers('REL', ['user-lilian']);
        h.forge.setRepoPermission('lilian-gh', 'write');
        await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: 'user-lilian' });
        h.clock.advance(ROLES_TTL_MS + 1);
        const teamMembers = h.tracker.teamMembers.bind(h.tracker);
        let tries = 0;
        h.tracker.teamMembers = async () => {
          attempt(++tries);
          throw new Error('Linear unreachable');
        };
        const mention = (actor: string) => ({ ...TRUSTED, id: 'mention', type: 'session.mentioned' as const, at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', actor, payload: { linearSessionId: 'ls-2', body: 'lance le dev', author: 'S' } });
        return { h, mention, up: () => (h.tracker.teamMembers = teamMembers) };
      }

      it('blocks the ticket and says so in its session when its store transaction throws at each attempt (criterion 1)', async () => {
        const last = gate();
        const { h } = failing((n) => {
          if (n === ATTEMPTS) last.open();
        });
        await h.send('ticket.delegated', { linearSessionId: 'ls-1' });

        await h.orch.accept(younger(h));
        await last.opened;
        await h.orch.drained();

        expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: expect.stringMatching(/^Événement younger mis de côté \(status\.changed\)/) });
        expect(h.tracker.activities('ls-1')).toContainEqual({ type: 'error', body: expect.stringContaining('factory run repair REL-1') });
        expect(await h.store.deadLetters('REL-1')).toMatchObject([{ eventId: 'younger', status: 'open', failures: 1, error: 'database hiccup' }]);
        expect(await h.store.pendingInbox(10)).toEqual([]);
      });

      it('blocks the ticket when its preparation throws at each attempt (criterion 1)', async () => {
        const last = gate();
        const { h, mention } = await rolesDown((n) => {
          if (n === ATTEMPTS) last.open();
        });

        await h.orch.accept(mention('user-lilian'));
        await last.opened;
        await h.orch.drained();

        expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: expect.stringMatching(/^Événement mention mis de côté/) });
        expect(await h.store.deadLetters('REL-1')).toMatchObject([{ eventId: 'mention', status: 'open', error: 'Linear unreachable' }]);
        expect(await h.store.pendingInbox(10)).toEqual([]);
      });

      /** The ticket's effect died near `younger`'s last attempt: blocked for it, its result decided, nothing left behind. */
      async function effectDiedThenBlocked({ h, state }: ReturnType<typeof failing>) {
        expect(state.decided).toContain('effect:REL-1:1:2:committed');
        expect(await h.store.pendingInbox(10)).toEqual([]);
        // The block of the dead effect, not the dead letter's: repairing `younger` does not make the effect look alive.
        expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Erreur : Linear down' });
        expect(await h.store.deadLetters('REL-1')).toMatchObject([{ eventId: 'younger', status: 'open' }]);
      }

      it('blocks the ticket on an effect that dies after the row is out of attempts (criterion 2)', async () => {
        const last = gate();
        const scenario = failing((n) => {
          if (n === ATTEMPTS) last.open();
        });
        const { h } = scenario;
        h.tracker.comment = async () => {
          throw new Error('Linear down');
        };
        await h.orch.accept(delegation(h, 'd1'));
        await h.orch.drained();
        await h.orch.accept(younger(h));
        await last.opened;
        await h.orch.drained();

        // The comment's last attempt dies at the next poll, with no restart.
        await h.advance(60_000);

        await effectDiedThenBlocked(scenario);
      });

      it('blocks the ticket on an effect that dies right behind the last attempt, in the same task (criterion 2)', async () => {
        const inDecision = gate();
        const answer = gate();
        const scenario = failing(async (n) => {
          if (n < ATTEMPTS) return;
          inDecision.open();
          await answer.opened;
        });
        const { h } = scenario;
        h.tracker.comment = async () => {
          throw new Error('Linear down');
        };
        await h.orch.accept(delegation(h, 'd1'));
        await h.orch.drained();
        await h.orch.accept(younger(h));
        await inDecision.opened;
        // The comment's backoff ends during the attempt: its ticket's task reaches it once the attempt is over.
        h.clock.advance(60_000);
        answer.open();
        await h.orch.drained();
        await h.advance(0);

        await effectDiedThenBlocked(scenario);
      });

      it('takes up what arrived behind the row once it is set aside, a stop included', async () => {
        const inDecision = gate();
        const answer = gate();
        const { h, state } = failing(async () => {
          inDecision.open();
          await answer.opened;
        });
        await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
        await h.orch.accept(younger(h));
        await inDecision.opened;
        await h.orch.accept(stop(h, 's1'));
        await h.orch.poll();
        answer.open();
        await h.orch.drained();

        expect(state.decided).toContain('s1:committed');
        expect(await h.store.pendingInbox(10)).toEqual([]);
        expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Arrêté à la demande' });
      });

      it('gets its row back with `factory run repair`: replayed once the cause is fixed, the ticket unblocked', async () => {
        const last = gate();
        const { h, state } = failing((n) => {
          if (n === ATTEMPTS) last.open();
        });
        await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
        await h.orch.accept(younger(h));
        await last.opened;
        await h.orch.drained();
        expect((await h.ticket()).blocked).toBe(true);

        state.broken = false;
        expect(await repair(h)).toBe(0);
        await h.orch.poll();
        await h.orch.drained();

        expect((await h.ticket()).blocked).toBe(false);
        expect(await journaled(h)).toContain('repair:younger:1');
        expect(await h.store.getDeadLetter('younger')).toMatchObject({ status: 'replayed', resolvedBy: 'armand' });
      });

      it('checks a repaired row on its roles: set aside before they could be read, it is refused at its replay', async () => {
        const last = gate();
        const { h, mention, up } = await rolesDown((n) => {
          if (n === ATTEMPTS) last.open();
        });
        const runs = h.runner.requests.length;
        await h.orch.accept(mention('user-stranger'));
        await last.opened;
        await h.orch.drained();
        expect((await h.store.getDeadLetter('mention'))!.event.roles).toBeUndefined();

        up();
        expect(await repair(h)).toBe(0);
        await h.orch.poll();
        await h.orch.drained();

        // Read at last, its roles refuse it: no run on the word of someone who may not ask.
        expect(h.runner.requests).toHaveLength(runs);
        expect(h.tracker.activities('ls-2')).toEqual([{ type: 'response', body: expect.stringMatching(/^Refusé/) }]);
        const repaired = (await h.store.recentEvents(50, 'REL-1')).find((e) => e.id === 'repair:mention:1');
        expect(repaired).toMatchObject({ payload: { event: { id: 'mention', roles: [] } } });
      });

      it('reopens the dead letter when the repair itself cannot be prepared: the row is still there', async () => {
        const first = gate();
        const second = gate();
        const { h, mention } = await rolesDown((n) => {
          if (n === ATTEMPTS) first.open();
          if (n === ATTEMPTS * 2) second.open();
        });
        await h.orch.accept(mention('user-lilian'));
        await first.opened;
        await h.orch.drained();

        expect(await repair(h)).toBe(0);
        await h.orch.poll();
        await second.opened;
        await h.orch.drained();

        expect(await h.store.getDeadLetter('mention')).toMatchObject({ status: 'open', failures: 2 });
        expect((await h.ticket()).blocked).toBe(true);
        expect(await h.store.pendingInbox(10)).toEqual([]);
      });

      describe('with the store itself failing', () => {
        it('keeps the row and its order while nothing can be written, and decides it at a later attempt, without a dead letter', async () => {
          const stillDown = gate();
          const back = gate();
          let tries = 0;
          const { h, state } = failing(undefined, (inner, s) => ({
            deadLetter: async () => {
              // Past the last attempt: the dead letter could not be written, the row is not given up.
              if (tries > ATTEMPTS) stillDown.open();
              throw new Error('database down');
            },
            decide: async (req: DecisionRequest) => {
              if (s.broken && req.event.id === 'younger') {
                tries++;
                throw new Error('database down');
              }
              const outcome = await inner.decide(req);
              s.decided.push(`${req.event.id}:${outcome.status}`);
              if (req.event.id === 'younger') back.open();
              return outcome;
            },
          }));
          await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
          await h.orch.accept(younger(h));
          await h.orch.accept(stop(h, 's1'));
          await stillDown.opened;

          expect((await h.store.pendingInbox(10)).map((e) => e.id)).toEqual(['younger', 's1']);
          expect(state.decided).not.toContain('s1:committed');
          expect(await h.store.deadLetters()).toEqual([]);

          state.broken = false;
          await back.opened;
          await h.orch.drained();

          expect(await h.store.pendingInbox(10)).toEqual([]);
          expect(await h.store.deadLetters()).toEqual([]);
          const order = await journaled(h);
          expect(order).toContain('younger');
          expect(order.indexOf('younger')).toBeLessThan(order.indexOf('s1'));
        });

        it('keeps retrying when the store cannot even say whether the ticket is tracked', async () => {
          const pastLast = gate();
          const back = gate();
          let tries = 0;
          const { h, state } = failing(undefined, (inner, s) => ({
            getTicket: async (projectId: string, ticketId: string) => {
              if (s.broken && tries >= ATTEMPTS) throw new Error('database down');
              return inner.getTicket(projectId, ticketId);
            },
            decide: async (req: DecisionRequest) => {
              if (s.broken && req.event.id === 'younger') {
                if (++tries > ATTEMPTS) pastLast.open();
                throw new Error('database down');
              }
              const outcome = await inner.decide(req);
              if (req.event.id === 'younger') back.open();
              return outcome;
            },
          }));
          await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
          await h.orch.accept(younger(h));
          await pastLast.opened;
          expect(await h.store.deadLetters()).toEqual([]);

          state.broken = false;
          await back.opened;
          await h.orch.drained();

          expect(await journaled(h)).toContain('younger');
          expect(await h.store.deadLetters()).toEqual([]);
          expect(await h.store.pendingInbox(10)).toEqual([]);
        });

        it("sets the row aside once when the answer to the dead letter's COMMIT is lost", async () => {
          const noticed = gate();
          let lost = true;
          const { h, state } = failing(undefined, (inner, s) => ({
            deadLetter: async (row: StoredEvent, error: string, at: number, holder?: string) => {
              const written = await inner.deadLetter(row, error, at, holder);
              if (lost) {
                lost = false;
                throw new Error('connection reset');
              }
              return written;
            },
            decide: async (req: DecisionRequest) => {
              if (s.broken && req.event.id === 'younger') throw new Error('database hiccup');
              const outcome = await inner.decide(req);
              s.decided.push(`${req.event.id}:${outcome.status}`);
              if (req.event.id === 'dead-letter:younger:1' && outcome.status === 'committed') noticed.open();
              return outcome;
            },
          }));
          await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
          await h.orch.accept(younger(h));
          await noticed.opened;
          await h.orch.drained();

          expect(await h.store.deadLetters('REL-1')).toMatchObject([{ eventId: 'younger', status: 'open', failures: 1 }]);
          expect(state.decided.filter((d) => d.startsWith('dead-letter:'))).toEqual(['dead-letter:younger:1:committed']);
          expect((await h.ticket()).blocked).toBe(true);
          expect(await h.store.pendingInbox(10)).toEqual([]);
        });

        it('sets nothing aside during a shutdown: the row waits for the next start', async () => {
          const inDecision = gate();
          const answer = gate();
          const { h, state } = failing(async (n) => {
            if (n < ATTEMPTS) return;
            inDecision.open();
            await answer.opened;
          });
          await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
          await h.orch.accept(younger(h));
          await inDecision.opened;
          h.orch.stopAll();
          answer.open();
          await h.orch.drained();

          expect(await h.store.deadLetters()).toEqual([]);
          expect((await h.store.pendingInbox(10)).map((e) => e.id)).toEqual(['younger']);

          state.broken = false;
          await h.restart();
          expect(await journaled(h)).toContain('younger');
          expect(await h.store.pendingInbox(10)).toEqual([]);
        });
      });

      it('never sets aside the event that blocks the ticket: set aside, the block would be lost', async () => {
        const pastLast = gate();
        const blocked = gate();
        let tries = 0;
        const { h, state } = failing(undefined, (inner, s) => ({
          decide: async (req: DecisionRequest) => {
            if (s.broken && req.event.id === 'younger') throw new Error('database hiccup');
            if (s.broken && req.event.id === 'dead-letter:younger:1') {
              if (++tries > ATTEMPTS) pastLast.open();
              throw new Error('database hiccup');
            }
            const outcome = await inner.decide(req);
            if (req.event.id === 'dead-letter:younger:1') blocked.open();
            return outcome;
          },
        }));
        await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
        await h.orch.accept(younger(h));
        await pastLast.opened;
        expect((await h.store.deadLetters()).map((d) => d.eventId)).toEqual(['younger']);

        state.broken = false;
        await blocked.opened;
        await h.orch.drained();

        expect((await h.ticket()).blocked).toBe(true);
        expect(await h.store.pendingInbox(10)).toEqual([]);
      });
    });

    it('lets a stop pass the backoff once its retry is answered `waiting`, when only the result of a done effect is ahead (ORC-315)', async () => {
      const answered = gate();
      let hiccup = true;
      const decided: string[] = [];
      const h = createHarness({
        projectYaml: CRASH_WORKFLOW,
        processRetry: { attempts: 5, baseMs: 1 },
        // A backoff no real timer reaches during the test: the stop is what ends it.
        effectRetry: { attempts: 2, baseMs: 60_000, capMs: 60_000 },
        wrapStore: (inner) =>
          Object.assign(Object.create(inner) as Store, {
            decide: async (req: DecisionRequest) => {
              if (hiccup && req.event.id === 'effect:REL-1:1:1') {
                hiccup = false;
                throw new Error('database hiccup');
              }
              const outcome = await inner.decide(req);
              decided.push(`${req.event.id}:${outcome.status}`);
              if (req.event.id === 'effect:REL-1:1:1' && outcome.status === 'waiting') answered.open();
              return outcome;
            },
          }),
      });
      h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
      h.tracker.comment = async () => {
        throw new Error('Linear down');
      };
      await h.orch.accept(delegation(h, 'd1'));
      await answered.opened;
      await h.orch.drained();

      await h.orch.accept(stop(h, 's1'));
      await h.orch.drained();

      expect(decided).toContain('s1:committed');
      expect((await h.store.listEffects('p', 'REL-1')).find((r) => r.id === 'REL-1:1:2')).toMatchObject({ status: 'failed', error: 'cancelled by s1' });
    });
  });

  it('keeps the slot a drain promised to a dequeued item from a start decided meanwhile, and the item its place', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let gating = false;
    let reached = false;
    // The drain's start of REL-2 reads its ticket first: held there, its slot is promised, not taken.
    const wrapStore = (inner: Store) =>
      Object.assign(Object.create(inner) as Store, {
        getTicket: async (projectId: string, ticketId: string) => {
          if (gating && ticketId === 'REL-2') {
            reached = true;
            await gate;
          }
          return inner.getTicket(projectId, ticketId);
        },
      });
    const h = createHarness({ wrapStore, projectYaml: 'version: 1\nlimits:\n  parallel_sessions: 1\n' });
    for (const id of ['REL-1', 'REL-2', 'REL-3']) h.tracker.addIssue({ identifier: id, title: `Ticket ${id}` });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-2' }, 'REL-2');
    const queued = (await h.store.listQueue()).find((q) => q.ticketId === 'REL-2')!;
    expect(queued).toBeDefined();

    gating = true;
    h.runner.release(h.runner.requests[0]!.runId);
    await waitFor(() => reached);
    await h.orch.accept({ ...TRUSTED, id: 'd3', type: 'ticket.delegated', at: h.clock.now(), projectId: 'p', ticketId: 'REL-3', payload: { linearSessionId: 'ls-3' } });
    await waitFor(async () => (await h.store.listQueue()).some((q) => q.ticketId === 'REL-3'));
    open();
    await h.orch.drained();

    const tickets = h.runner.requests.map((r) => r.cwd.split(/[\\/]/).pop());
    expect(tickets.slice(0, 2)).toEqual(['REL-1', 'REL-2']);
    expect((await h.store.listQueue()).find((q) => q.ticketId === 'REL-2')).toBeUndefined();
  });
});

/**
 * ORC-150: the outbox executors. Each effect is claimed under a lease, retried with a backoff,
 * dead past its last attempt, and its result comes back through the inbox as `effect:<id>`.
 */
describe('outbox executors: lease, backoff, results through the inbox', () => {
  const journal = async (h: ReturnType<typeof createHarness>) => (await h.store.recentEvents(100, 'REL-1')).reverse();
  const delegation = (h: ReturnType<typeof createHarness>) =>
    ({ ...TRUSTED, id: 'd1', type: 'ticket.delegated' as const, at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload: { linearSessionId: 'ls-1' } });

  it('writes each effect result to the inbox as effect:<id>, decided by the worker like any event (criteria 4 and 5)', async () => {
    const h = createHarness({ projectYaml: CRASH_WORKFLOW });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const rows = await h.store.listEffects('p', 'REL-1');
    const events = await journal(h);
    // Every row settled wrote one result, journaled after the event that decided the row.
    for (const r of rows) {
      expect(r.status).toBe('done');
      const result = events.filter((e) => e.id === `effect:${r.id}`);
      expect(result).toEqual([
        expect.objectContaining({ type: 'effect.done', payload: { effectId: r.id, kind: r.effect.kind, eventId: r.eventId, attempts: 1 } }),
      ]);
      expect(events.findIndex((e) => e.id === `effect:${r.id}`)).toBeGreaterThan(events.findIndex((e) => e.id === r.eventId));
    }
    expect(events.slice(0, 4).map((e) => e.id)).toEqual(['t-1', 'effect:REL-1:1:1', 'effect:REL-1:1:2', 'effect:REL-1:1:3']);
    // The run's result enters as attempt:<id>:finished.
    expect(events.map((e) => e.id)).toContain('attempt:id-1:finished');
    expect(await h.store.pendingInbox(10)).toEqual([]);
  });

  it('retries an effect that fails for a while, after a backoff, and blocks nothing (criterion 3)', async () => {
    const h = createHarness({ projectYaml: CRASH_WORKFLOW, effectRetry: { attempts: 4, baseMs: 20, capMs: 1_000 } });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    const comment = h.tracker.comment.bind(h.tracker);
    const tries: number[] = [];
    h.tracker.comment = async (id: string, body: string) => {
      tries.push(h.clock.now());
      if (tries.length <= 2) throw new Error('Linear unreachable');
      return comment(id, body);
    };
    await h.orch.accept(delegation(h));
    await h.orch.drained();
    // 20 ms, then 40 ms on the simulated clock (ORC-228): never before the backoff.
    for (const [ms, attempts] of [[19, 1], [1, 2], [39, 2], [1, 3]] as const) {
      await h.advance(ms);
      expect(tries).toHaveLength(attempts);
    }
    expect(tries[1]! - tries[0]!).toBe(20);
    expect(tries[2]! - tries[1]!).toBe(40);
    expect((await h.store.listEffects('p', 'REL-1'))[1]).toMatchObject({ id: 'REL-1:1:2', status: 'done', attempts: 3, error: 'Linear unreachable' });
    expect(await h.ticket()).toMatchObject({ blocked: false });
    expect(h.runner.requests).toHaveLength(1);
    expect((await journal(h)).find((e) => e.id === 'effect:REL-1:1:2')).toMatchObject({ type: 'effect.done', payload: { attempts: 3 } });
  });

  it('lets an effect die past its last attempt: the rest of its decision is skipped and decide blocks the ticket', async () => {
    const h = createHarness({ projectYaml: CRASH_WORKFLOW, effectRetry: { attempts: 2, baseMs: 5, capMs: 5 } });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.tracker.comment = async () => {
      throw new Error('Linear down');
    };
    await h.orch.accept(delegation(h));
    await h.orch.drained();
    expect(await h.ticket()).toMatchObject({ blocked: false });
    // The retry is due 5 ms later on the simulated clock (ORC-228): it fails again, its last attempt.
    await h.advance(5);
    expect((await h.store.listEffects('p', 'REL-1')).slice(0, 3).map((r) => [r.effect.kind, r.status])).toEqual([
      ['labels', 'done'],
      ['comment', 'dead'],
      ['start_run', 'failed'],
    ]);
    expect(h.runner.requests).toHaveLength(0);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Erreur : Linear down' });
    expect((await journal(h)).find((e) => e.id === 'effect:REL-1:1:2')).toMatchObject({ type: 'effect.failed', payload: { error: 'Linear down', attempts: 2 } });
    expect(h.tracker.activities().filter((a) => a.type === 'error').map((a) => ('body' in a ? a.body : ''))).toEqual(['Erreur : Linear down']);
  });

  it('decides the effect.failed of an effect it let die at once, even when the result ahead of it was parked as the backoff ended (ORC-290)', async () => {
    let hold = false;
    const claiming = gate();
    const answer = gate();
    const h = createHarness({
      projectYaml: CRASH_WORKFLOW,
      // A backoff no real timer reaches during the test: only the polls below move the worker.
      effectRetry: { attempts: 2, baseMs: 60_000, capMs: 60_000 },
      wrapStore: (inner) =>
        Object.assign(Object.create(inner) as Store, {
          claimEffect: async (...args: Parameters<Store['claimEffect']>) => {
            const claimed = await inner.claimEffect(...args);
            if (hold) {
              hold = false;
              claiming.open();
              await answer.opened;
            }
            return claimed;
          },
        }),
    });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.tracker.comment = async () => {
      throw new Error('Linear down');
    };
    await h.orch.accept(delegation(h));
    await h.orch.drained();
    // A poll is on its way: its claim found the backoff still running, but its answer comes late.
    hold = true;
    void h.orch.poll();
    await claiming.opened;
    // The backoff ends: the result of the labels goes to the store while the comment is due, and is parked.
    h.clock.advance(60_000);
    await h.orch.poll();
    answer.open();
    await h.orch.drained();
    expect((await h.store.listEffects('p', 'REL-1')).slice(0, 2).map((r) => r.status)).toEqual(['done', 'dead']);
    // No poll since the effect died: its death alone lets what waited behind it go.
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Erreur : Linear down' });
    expect(await h.store.pendingInbox(10)).toEqual([]);
  });

  it('decides the rows it releases ahead of a younger row queued while they were parked (ORC-290)', async () => {
    const deciding = gate();
    const answer = gate();
    const decided: string[] = [];
    const h = createHarness({
      projectYaml: CRASH_WORKFLOW,
      effectRetry: { attempts: 2, baseMs: 60_000, capMs: 60_000 },
      wrapStore: (inner) =>
        Object.assign(Object.create(inner) as Store, {
          decide: async (req: DecisionRequest) => {
            const outcome = await inner.decide(req);
            decided.push(`${req.event.id}:${outcome.status}`);
            if (req.event.id === 'younger') {
              deciding.open();
              await answer.opened;
            }
            return outcome;
          },
        }),
    });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    let tries = 0;
    const trying = gate();
    const failing = gate();
    h.tracker.comment = async () => {
      if (++tries === 2) {
        trying.open();
        await failing.opened;
      }
      throw new Error('Linear down');
    };
    await h.orch.accept(delegation(h));
    await h.orch.drained();
    // The result of the labels is parked behind the comment's backoff. The backoff ends, without a
    // poll to release it: the comment's last attempt runs, and a younger row is queued meanwhile.
    h.clock.advance(60_000);
    h.orch.wake();
    await trying.opened;
    await h.orch.accept({ ...TRUSTED, id: 'younger', type: 'status.changed', at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload: { from: 'todo', to: 'todo' } });
    await h.orch.replayInbox();
    failing.open();
    // A pass reads the inbox while the younger row is at the store: whatever it queues must not park.
    await deciding.opened;
    await h.orch.replayInbox();
    answer.open();
    await h.orch.drained();
    // Oldest first: the labels' result, then the younger row, then the comment's death.
    expect(decided.filter((d) => /^(effect:REL-1:1:[12]|younger):committed$/.test(d))).toEqual(['effect:REL-1:1:1:committed', 'younger:committed', 'effect:REL-1:1:2:committed']);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Erreur : Linear down' });
    expect(await h.store.pendingInbox(10)).toEqual([]);
  });

  it('leaves a parked row for the next start when its effect settles during a shutdown (ORC-290)', async () => {
    const h = createHarness({ projectYaml: CRASH_WORKFLOW, effectRetry: { attempts: 2, baseMs: 60_000, capMs: 60_000 } });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    let tries = 0;
    const trying = gate();
    const failing = gate();
    h.tracker.comment = async () => {
      if (++tries === 2) {
        trying.open();
        await failing.opened;
      }
      throw new Error('Linear down');
    };
    await h.orch.accept(delegation(h));
    await h.orch.drained();
    h.clock.advance(60_000);
    h.orch.wake();
    await trying.opened;
    h.orch.stopAll();
    failing.open();
    await h.orch.drained();
    expect((await h.store.listEffects('p', 'REL-1'))[1]).toMatchObject({ status: 'dead' });
    expect((await h.store.pendingInbox(10)).map((e) => e.id)).toContain('effect:REL-1:1:1');
  });

  it('does not loop when the error notice of a dead effect dies too', async () => {
    const h = createHarness({ projectYaml: CRASH_WORKFLOW });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.tracker.comment = async () => {
      throw new Error('Linear down');
    };
    h.tracker.activity = async () => {
      throw new Error('Linear down');
    };
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    // The comment dies, then its notice: two results, nothing more.
    expect((await journal(h)).filter((e) => e.type === 'effect.failed')).toHaveLength(2);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Erreur : Linear down' });
    expect(await h.store.pendingInbox(10)).toEqual([]);
  });

  onSqliteFile('takes up an effect cut by SIGKILL after it acted once its lease expires, and runs it again (criterion 2, at least once)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'factory-worker-')), 'factory.db');
    const { completed } = crashAfterDecision(file, 'acted:1', 300);
    expect(completed).toEqual([]);

    const h = createHarness({ store: new SqliteStore(file), projectYaml: CRASH_WORKFLOW, effectLeaseMs: 300 });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    // The labels were set, but the row is still running under the dead process's claim, with no result.
    expect((await h.store.listEffects('p', 'REL-1'))[0]).toMatchObject({ id: 'REL-1:1:1', status: 'running', attempts: 1 });
    expect(await h.store.pendingInbox(10)).toEqual([]);

    await h.restart();
    const settled = async () => (await h.store.listEffects('p', 'REL-1')).slice(0, 3).every((r) => r.status === 'done');
    for (let i = 0; i < 100 && !(await settled()); i++) {
      await new Promise((r) => setTimeout(r, 20));
      await h.orch.drained();
    }
    const rows = await h.store.listEffects('p', 'REL-1');
    expect(rows.slice(0, 3).map((r) => [r.id, r.status, r.attempts])).toEqual([
      ['REL-1:1:1', 'done', 2],
      ['REL-1:1:2', 'done', 1],
      ['REL-1:1:3', 'done', 1],
    ]);
    // Run again under its new claim: the labels are set a second time here (idempotency per effect: ORC-162).
    expect(h.tracker.calls.filter((c) => c.method === 'setLabels')).toHaveLength(1);
    expect(h.tracker.calls.filter((c) => c.method === 'comment')).toHaveLength(1);
    expect(h.runner.requests).toHaveLength(1);
    // One result per row, whatever its number of attempts.
    expect((await journal(h)).filter((e) => e.id === 'effect:REL-1:1:1')).toHaveLength(1);
  });

  it('hands a queued start lost in a crash out again once its lease expires', async () => {
    const h = createHarness({ projectYaml: CRASH_WORKFLOW });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.store.setMeta('paused', '1');
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect((await h.store.listQueue()).map((q) => q.ticketId)).toEqual(['REL-1']);
    // A daemon takes the item, then dies before the start is recorded.
    expect(await h.store.claimQueued('dev', 1)).toBeDefined();
    h.clock.advance(5);
    await h.store.setMeta('paused', '0');
    await h.orch.tick();
    await h.orch.drained();
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.store.listQueue()).toEqual([]);
    expect(await h.store.claimQueued('dev', 60_000)).toBeUndefined();
  });
});

describe('a stop and an effect held back by its backoff (ORC-150, ORC-138)', () => {
  const RUN_THEN_COMMENT = `
version: 1
on:
  ticket.delegated:
    - { run: dev }
  label.changed:
    - { label: "agent:x", comment: "reçu" }
`;

  it.each([
    { type: 'control.stop' as const, payload: {} },
    { type: 'session.stopped' as const, payload: { linearSessionId: 'ls-1' } },
  ])('lets $type stop the run without waiting for the retry, and keeps its block reason', async ({ type, payload }) => {
    // A minute of backoff: the stop must not wait for it.
    const h = createHarness({ projectYaml: RUN_THEN_COMMENT, effectRetry: { attempts: 8, baseMs: 60_000, capMs: 60_000 } });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const runId = (await h.ticket()).activeRunId!;
    expect(runId).toBeDefined();
    h.tracker.comment = async () => {
      throw new Error('Linear down');
    };
    await h.send('label.changed', { label: 'agent:x', change: 'added' });
    const comment = (await h.store.listEffects('p', 'REL-1')).find((r) => r.effect.kind === 'comment')!;
    expect(comment).toMatchObject({ status: 'pending', attempts: 1, error: 'Linear down' });

    const started = Date.now();
    await h.orch.accept({ ...TRUSTED, id: 'stop-1', type, at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload } as FactoryEvent);
    await waitFor(async () => (await h.store.getRun(runId))?.status === 'stopped');
    await h.orch.drained();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Arrêté à la demande' });
    expect((await h.store.listEffects('p', 'REL-1')).find((r) => r.id === comment.id)).toMatchObject({ status: 'failed', error: 'cancelled by stop-1' });
    // No effect.failed for a cancelled row: nothing rewrites the stop's reason.
    expect((await h.store.recentEvents(100, 'REL-1')).some((e) => e.type === 'effect.failed')).toBe(false);
    expect(await h.store.pendingInbox(10)).toEqual([]);
  });

  it('lets a stop pass the result of an effect of the same decision done before the one in backoff', async () => {
    const LABEL_THEN_COMMENT = `
version: 1
on:
  ticket.delegated:
    - { run: dev }
  label.changed:
    - { label: "agent:x", labels: { add: ["vu"] }, comment: "reçu" }
`;
    const h = createHarness({ projectYaml: LABEL_THEN_COMMENT, effectRetry: { attempts: 8, baseMs: 60_000, capMs: 60_000 } });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const runId = (await h.ticket()).activeRunId!;
    h.tracker.comment = async () => {
      throw new Error('Linear down');
    };
    await h.send('label.changed', { label: 'agent:x', change: 'added' });
    const effects = (await h.store.listEffects('p', 'REL-1')).filter((r) => r.effect.kind === 'labels' || r.effect.kind === 'comment');
    expect(effects.map((r) => [r.effect.kind, r.status])).toEqual([['labels', 'done'], ['comment', 'pending']]);
    expect((await h.store.pendingInbox(10)).map((e) => e.type)).toEqual(['effect.done']);

    await h.orch.accept({ ...TRUSTED, id: 'stop-1', type: 'control.stop', at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload: {} });
    await waitFor(async () => (await h.store.getRun(runId))?.status === 'stopped');
    await h.orch.drained();
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Arrêté à la demande' });
    expect(await h.store.pendingInbox(10)).toEqual([]);
  });

  it('does not let another event pass the backoff', async () => {
    const h = createHarness({ projectYaml: RUN_THEN_COMMENT, effectRetry: { attempts: 8, baseMs: 60_000, capMs: 60_000 } });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    h.tracker.comment = async () => {
      throw new Error('Linear down');
    };
    await h.send('label.changed', { label: 'agent:x', change: 'added' });
    await h.send('label.changed', { label: 'agent:y', change: 'added' });
    expect((await h.store.pendingInbox(10)).map((e) => e.type)).toEqual(['label.changed']);
    h.orch.stopAll();
  });
});

describe('an effect that throws something other than an Error (ORC-150 review)', () => {
  it('records its message and lets it die like any failed effect', async () => {
    const yaml = 'version: 1\non:\n  label.changed:\n    - { label: "agent:x", comment: "reçu" }\n';
    const h = createHarness({ projectYaml: yaml, effectRetry: { attempts: 1, baseMs: 1, capMs: 1 } });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    h.tracker.comment = async () => {
      throw 'Linear down';
    };
    await h.send('label.changed', { label: 'agent:x', change: 'added' });
    expect((await h.store.listEffects('p', 'REL-1')).find((r) => r.effect.kind === 'comment')).toMatchObject({ status: 'dead', error: 'Linear down' });
    expect(await h.store.pendingInbox(10)).toEqual([]);
  });
});

describe('a start that must not run (ORC-150 review)', () => {
  it('blocks the ticket once when a launch fails and its notice fails too: the start is not retried', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.workspaces.prepare = async () => {
      throw new Error('disk full');
    };
    const activity = h.tracker.activity.bind(h.tracker);
    h.tracker.activity = async (sessionId, a) => {
      if (a.type === 'error') throw new Error('Linear down');
      return activity(sessionId, a);
    };
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Erreur au lancement : disk full' });
    expect((await h.store.listEffects('p', 'REL-1')).find((r) => r.effect.kind === 'start_run')).toMatchObject({ status: 'done', attempts: 1 });
    expect(h.runner.requests).toHaveLength(0);
  });

  it('drops a queued dev start of a ticket blocked meanwhile, without a run', async () => {
    const h = createHarness({ projectYaml: 'version: 1\nlimits:\n  parallel_sessions: 1\n' });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.tracker.addIssue({ identifier: 'REL-2', title: 'Import CSV' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-2' }, 'REL-2');
    expect((await h.store.listQueue()).map((q) => q.ticketId)).toEqual(['REL-2']);
    await h.orch.blockTicket('p', 'REL-2', 'Question posée par l\'agent');
    h.runner.release(h.runner.requests[0]!.runId);
    await h.orch.drained();
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.store.listQueue()).toEqual([]);
    const t = await h.ticket('REL-2');
    expect(t.blocked).toBe(true);
    expect(t.activeRunId).toBeUndefined();
  });
});
