import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import type { AgentOutput, AttemptOutcome } from './agent-output.js';
import type { Decision } from './decision.js';
import { CUT_RELAUNCHES, CUT_WINDOW_MS } from '../store/types.js';
import { CUT_BOUND_REASON, decide, isFenced, mayPublish, RECONCILE_MS, reconcileTicket, SENSITIVE_PATHS, sensitivePathsAtLaunch, taintedKnowledge } from './engine.js';
import { blockCause } from './block-cause.js';
import { reduce } from './reduce.js';
import { holds, isUnrouted, unroutedReason } from './routing.js';
import { newTicketState, SCHEMA_VERSION, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });

function ev<T extends EventType>(type: T, payload: EventPayloads[T]): FactoryEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: 3, taint: 'trusted', payload } as FactoryEvent;
}
function ticket(patch: Partial<TicketState> = {}): TicketState {
  return { ...newTicketState('p', 'REL-1', 'Titre', 'todo', 0), delegated: true, ...patch };
}
/** The expected decision; the trace is free text and is checked by its own tests. */
function decision(d: Partial<Omit<Decision, 'trace'>> = {}) {
  return { events: [], effects: [], timers: [], ...d, trace: expect.any(Array) };
}
const kinds = (d: Decision) => ({ events: d.events.map((e) => e.type), effects: d.effects.map((e) => e.kind), timers: d.timers.map((t) => t.kind) });

describe('decide — YAML rules of the standard pack', () => {
  it('starts dev on delegation of a todo ticket', () => {
    expect(decide(ticket(), ev('ticket.delegated', {}), workflow)).toEqual(
      decision({ effects: [{ kind: 'start_run', job: 'dev', input: undefined, inputText: undefined, linearSessionId: undefined }] }),
    );
  });

  it('starts dev on delegation of a ticket it does not track yet, from the snapshot in the event', () => {
    const out = decide(undefined, ev('ticket.delegated', { issue: { title: 'Export CSV', logical: 'todo', priority: 0 } }), workflow);
    expect(out.effects).toEqual([{ kind: 'start_run', job: 'dev', input: undefined, inputText: undefined, linearSessionId: undefined }]);
  });

  it('ignores delegation of a blocked ticket', () => {
    expect(decide(ticket({ blocked: true }), ev('ticket.delegated', {}), workflow)).toEqual(decision());
  });

  it('debounces a reply in human review and records the feedback', () => {
    const out = decide(ticket({ logical: 'human_review', linearSessionId: 's1' }), ev('session.prompted', { linearSessionId: 's1', body: 'boutons mal alignés', author: 'Lilian' }), workflow);
    expect(out).toEqual(
      decision({
        events: [{ type: 'feedback.appended', item: { author: 'Lilian', body: 'boutons mal alignés', at: 1000, source: 'session', taint: 'trusted' } }],
        timers: [{ kind: 'debounce', slot: 'dev-feedback', ms: 180_000, payload: { job: 'dev-feedback' } }],
      }),
    );
  });

  it('relaunches immediately when blocked', () => {
    const out = decide(ticket({ logical: 'dev', blocked: true, linearSessionId: 's1' }), ev('session.prompted', { linearSessionId: 's1', body: 'oui, vas-y', author: 'L' }), workflow);
    expect(kinds(out)).toEqual({ events: ['feedback.appended', 'ticket.unblocked'], effects: ['start_run', 'labels'], timers: [] });
    expect(out.effects[0]).toMatchObject({ job: 'dev-feedback', input: 'feedback' });
  });

  it('records a reply in the dev session when no rule matches its status, so it waits for the next feedback run (ORC-267)', () => {
    for (const logical of ['todo', 'ai_review', 'ready', 'done'] as const) {
      const out = decide(ticket({ logical, linearSessionId: 's1' }), ev('session.prompted', { linearSessionId: 's1', body: 'ok', author: 'Lilian' }), workflow);
      expect(out).toEqual(decision({ events: [{ type: 'feedback.appended', item: { author: 'Lilian', body: 'ok', at: 1000, source: 'session', taint: 'trusted' } }] }));
      expect(out.trace).toContain('no rule for session.prompted');
    }
  });

  it('records a reply in the dev session of a delegated ticket that has no linked session yet (ORC-267)', () => {
    const out = decide(ticket({ logical: 'ai_review' }), ev('session.prompted', { linearSessionId: 's1', body: 'ok', author: 'L' }), workflow);
    expect(kinds(out)).toEqual({ events: ['feedback.appended'], effects: [], timers: [] });
  });

  it('routes a reply in a foreign session to ask', () => {
    const out = decide(ticket({ linearSessionId: 's1' }), ev('session.prompted', { linearSessionId: 's9', body: 'et pour mobile ?', author: 'L' }), workflow);
    expect(out).toEqual(decision({ effects: [{ kind: 'start_run', job: 'ask', input: 'thread', inputText: 'et pour mobile ?', linearSessionId: 's9' }] }));
  });

  it('on a non-delegated ticket, a reply routes to ask and dev-queue rules are skipped', () => {
    const t = ticket({ delegated: false, logical: 'dev' });
    expect(decide(t, ev('session.prompted', { linearSessionId: 's9', body: 'et pourquoi ?', author: 'L' }), workflow)).toEqual(
      decision({ effects: [{ kind: 'start_run', job: 'ask', input: 'thread', inputText: 'et pourquoi ?', linearSessionId: 's9' }] }),
    );
    expect(decide({ ...t, logical: 'ai_review' }, ev('status.changed', { from: 'human_review', to: 'ai_review' }), workflow)).toEqual(decision());
    expect(decide(t, ev('label.changed', { label: 'agent:reprendre', change: 'added' }), workflow)).toEqual(decision());
  });

  it('on a delegated ticket, a reply in a recorded question session routes to ask', () => {
    const out = decide(ticket({ logical: 'dev', questionSessionIds: ['s9'] }), ev('session.prompted', { linearSessionId: 's9', body: 'et ?', author: 'L' }), workflow);
    expect(out.effects[0]).toMatchObject({ kind: 'start_run', job: 'ask', linearSessionId: 's9' });
  });

  it('moves human_review -> dev runs dev-feedback', () => {
    const out = decide(ticket({ logical: 'human_review' }), ev('status.changed', { from: 'human_review', to: 'dev' }), workflow);
    expect(out).toEqual(decision({ effects: [{ kind: 'start_run', job: 'dev-feedback', input: 'feedback', inputText: undefined, linearSessionId: undefined }] }));
  });

  it('a reconciliation timer reconciles the project and arms the next one in 5 minutes (ORC-185)', () => {
    const fired = { ...ev('timer.fired', { kind: 'reconcile', payload: {} }), ticketId: reconcileTicket('p') } as FactoryEvent;
    expect(decide(undefined, fired, workflow)).toEqual(
      decision({ effects: [{ kind: 'reconcile' }], timers: [{ kind: 'reconcile', payload: {}, slot: 'reconcile', ms: RECONCILE_MS }] }),
    );
    expect(RECONCILE_MS).toBe(5 * 60_000);
  });

  describe('statuses of the MVP (ORC-170)', () => {
    const cancelled = ev('status.changed', { from: 'dev', to: null, cancelled: true });

    it('a ticket cancelled by a human cancels its run, without blocking it', () => {
      const out = decide(ticket({ logical: 'dev', delegated: true, activeRunId: 'r1' }), cancelled, workflow);
      expect(out.events).toEqual([{ type: 'work.cancelled' }]);
      expect(out.effects).toEqual([{ kind: 'stop_run' }]);
    });

    it('a cancelled ticket waits for nobody: unblocked, label off, pending replies dropped', () => {
      const waiting = ticket({ logical: 'dev', delegated: true, blocked: true, blockReason: 'x', pendingFeedback: [{ body: 'b', author: 'L', at: 1, source: 'session' }] });
      expect(reduce(waiting, cancelled)).toMatchObject({ blocked: false, pendingFeedback: [] });
      expect(decide(waiting, cancelled, workflow).effects).toContainEqual({ kind: 'labels', add: [], remove: ['Bloqué'] });
    });

    it('cancelling a ticket the factory does not work on decides nothing', () => {
      expect(decide(ticket({ logical: 'dev', delegated: false }), cancelled, workflow).effects).toEqual([]);
    });

    it('a block puts the label Bloqué next to the status, an unblock takes it off', () => {
      const blocked = decide(ticket({ activeRunId: 'r1' }), ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'failure', costUsd: 0, turns: 1, lastText: '' }), workflow);
      expect(blocked.effects).toContainEqual({ kind: 'labels', add: ['Bloqué'], remove: [] });
      const relaunched = decide(ticket({ logical: 'dev', blocked: true, linearSessionId: 's1' }), ev('session.prompted', { linearSessionId: 's1', body: 'vas-y', author: 'L' }), workflow);
      expect(relaunched.effects).toContainEqual({ kind: 'labels', add: [], remove: ['Bloqué'] });
    });

    it('does not put the label again on a ticket already blocked', () => {
      const out = decide(ticket({ blocked: true, activeRunId: 'r1' }), ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'failure', costUsd: 0, turns: 1, lastText: '' }), workflow);
      expect(out.effects.filter((e) => e.kind === 'labels')).toEqual([]);
    });
  });

  it('moving to ai_review runs review', () => {
    const out = decide(ticket({ logical: 'human_review' }), ev('status.changed', { from: 'human_review', to: 'ai_review' }), workflow);
    expect(out.effects[0]).toMatchObject({ kind: 'start_run', job: 'review' });
  });

  it('a mention runs ask with the body in its own session', () => {
    const out = decide(ticket(), ev('session.mentioned', { linearSessionId: 's2', body: 'tu penses quoi ?', author: 'L' }), workflow);
    expect(out).toEqual(decision({ effects: [{ kind: 'start_run', job: 'ask', input: 'thread', inputText: 'tu penses quoi ?', linearSessionId: 's2' }] }));
  });

  it('the retiens command runs remember', () => {
    const out = decide(ticket(), ev('command', { name: 'retiens', body: 'agrégats côté serveur', linearSessionId: 's3', author: 'L' }), workflow);
    expect(out).toEqual(decision({ effects: [{ kind: 'start_run', job: 'remember', input: 'thread', inputText: 'agrégats côté serveur', linearSessionId: 's3' }] }));
  });

  it('the agent:stop label stops', () => {
    const out = decide(ticket({ logical: 'dev' }), ev('label.changed', { label: 'agent:stop', change: 'added' }), workflow);
    expect(kinds(out)).toEqual({ events: ['work.cancelled', 'ticket.blocked'], effects: ['stop_run', 'activity', 'labels'], timers: [] });
  });

  it('a label rule matches only the addition of the label', () => {
    expect(decide(ticket({ logical: 'dev' }), ev('label.changed', { label: 'agent:stop', change: 'removed' }), workflow)).toEqual(decision());
  });

  it('a label.changed rule without label also matches additions only, as label.added did', () => {
    const wf = { ...workflow, on: { ...workflow.on, 'label.changed': [{ comment: 'label modifié' }] } };
    expect(decide(ticket(), ev('label.changed', { label: 'x', change: 'removed' }), wf)).toEqual(decision());
    expect(decide(ticket(), ev('label.changed', { label: 'x', change: 'added' }), wf).effects).toEqual([{ kind: 'comment', body: 'label modifié' }]);
  });

  it('a human push is a typed event that the standard pack does not react to', () => {
    expect(decide(ticket({ logical: 'dev' }), ev('push.human', { branch: 'factory/rel-1', sha: 'abc123', author: 'lilian' }), workflow)).toEqual(decision());
  });

  it('merge moves to done, cleans up and learns', () => {
    const out = decide(ticket({ logical: 'ready' }), ev('pr.merged', { number: 3, url: 'u', branch: 'b' }), workflow);
    expect(kinds(out).effects).toEqual(['stop_run', 'move', 'cleanup', 'start_run']);
    expect(out.effects[3]).toMatchObject({ job: 'learn' });
  });

  it('a PR closed without merge cancels the run: stopped, nothing pending, blocked until a human relaunches (ORC-134)', () => {
    const t = ticket({ logical: 'human_review', prNumber: 3, activeRunId: 'r1', pendingJob: { job: 'dev-feedback' } });
    const out = decide(t, ev('pr.closed', { number: 3, url: 'u', branch: 'b' }), workflow);
    expect(out.events).toEqual([
      { type: 'ticket.patched', patch: { prState: 'CLOSED' } },
      { type: 'work.cancelled' },
      { type: 'ticket.blocked', reason: 'PR #3 fermée sans merge' },
    ]);
    expect(kinds(out).effects).toEqual(['stop_run', 'activity', 'labels']);
    const after = out.events.reduce<TicketState>((s, e) => reduce(s, e)!, t);
    const relaunched = decide(after, ev('label.changed', { label: 'agent:reprendre', change: 'added' }), workflow);
    expect(relaunched.events).toContainEqual({ type: 'ticket.unblocked' });
    expect(kinds(relaunched).effects).toContain('start_run');
  });

  it("the close of another PR than the ticket's, of a closed or merged PR, or of a done ticket cancels nothing (ORC-134)", () => {
    const closed = ev('pr.closed', { number: 3, url: 'u', branch: 'b' });
    expect(decide(ticket({ prNumber: 4, activeRunId: 'r1' }), closed, workflow).effects).toEqual([]);
    expect(decide(ticket({ prNumber: 3, prState: 'MERGED', logical: 'done' }), closed, workflow).effects).toEqual([]);
    expect(decide(ticket({ prNumber: 3, logical: 'done' }), closed, workflow).effects).toEqual([]);
    expect(decide(ticket({ prNumber: 3, prState: 'CLOSED', blocked: true }), closed, workflow).effects).toEqual([]);
  });

  it('the closed PR reopened is open again, without resetting the red-CI count (ORC-134)', () => {
    const out = decide(ticket({ prNumber: 3, prState: 'CLOSED', ciFixAttempts: 1 }), ev('pr.opened', { number: 3, url: 'u', branch: 'b' }), workflow);
    expect(out.events).toEqual([{ type: 'ticket.patched', patch: { prNumber: 3, prUrl: 'u', prState: 'OPEN' } }]);
  });

  it('a review or a conflict reaches decide without any reaction yet (ORC-190, ORC-146)', () => {
    const pr = { number: 3, url: 'u', branch: 'b' };
    const reviewed = { ...ev('pr.reviewed', { ...pr, kind: 'review' as const, author: 'L', body: 'renomme' }), taint: 'untrusted' as const };
    const wf = { ...workflow, on: { ...workflow.on, 'pr.reviewed': [{ run: 'dev-feedback' }], 'pr.conflicted': [{ run: 'dev-feedback' }] } };
    for (const e of [reviewed, ev('pr.conflicted', { ...pr, headSha: 'h', baseRef: 'main' })]) {
      const out = decide(ticket({ logical: 'human_review', prNumber: 3 }), e, wf);
      expect(out).toEqual(decision());
      expect(out.trace).toEqual([`${e.type}: no reaction yet`]);
    }
  });
});

describe('decide — after the merge (ORC-268)', () => {
  const merged = (patch: Partial<TicketState> = {}) => ticket({ logical: 'done', prState: 'MERGED', ...patch });
  const devStarts = (d: Decision) => d.effects.filter((e) => e.kind === 'start_run' && workflow.jobs[e.job]?.queue === 'dev');

  it('a merge stops the dev work in flight, pending, queued or debounced, before its rule cleans up and learns', () => {
    const t = ticket({ logical: 'ready', activeRunId: 'r1', pendingJob: { job: 'dev-feedback' }, verifyingRunId: 'r1' });
    const out = decide(t, ev('pr.merged', { number: 3, url: 'u', branch: 'b' }), workflow);
    expect(out.events).toEqual([{ type: 'work.cancelled' }]);
    expect(out.effects).toEqual([
      { kind: 'stop_run' },
      { kind: 'move', to: 'done' },
      { kind: 'cleanup' },
      { kind: 'start_run', job: 'learn', input: undefined, inputText: undefined, linearSessionId: undefined },
    ]);
  });

  it('a new PR reopens a merged ticket; the merged PR seen again does not', () => {
    const t = merged({ logical: 'human_review', prNumber: 3 });
    const again = decide(t, ev('pr.opened', { number: 3, url: 'u', branch: 'b' }), workflow);
    expect(again.events).toEqual([{ type: 'ticket.patched', patch: { prNumber: 3, prUrl: 'u' } }]);
    const fresh = decide(t, ev('pr.opened', { number: 4, url: 'u4', branch: 'b' }), workflow);
    expect(fresh.events).toEqual([{ type: 'ticket.patched', patch: { prNumber: 4, prUrl: 'u4', prState: 'OPEN' } }]);
    const reopened = fresh.events.reduce<TicketState | undefined>((s, e) => reduce(s, e), t);
    expect(devStarts(decide(reopened, ev('label.changed', { label: 'agent:reprendre', change: 'added' }), workflow))).toHaveLength(1);
  });

  it('a human who takes the ticket out of done, or delegates it again, can relaunch dev work', () => {
    const back = decide(merged(), ev('status.changed', { from: 'done', to: 'human_review' }), workflow);
    expect(devStarts(decide(reduce(merged(), ev('status.changed', { from: 'done', to: 'human_review' })), ev('label.changed', { label: 'agent:reprendre', change: 'added' }), workflow))).toHaveLength(1);
    expect(back.trace).toContain('no rule for status.changed');
    expect(devStarts(decide(merged({ logical: 'todo' }), ev('ticket.delegated', {}), workflow))).toEqual([expect.objectContaining({ job: 'dev' })]);
  });

  it('a relaunch by label starts no dev run on a merged ticket, and leaves it as it is', () => {
    const out = decide(merged({ blocked: true }), ev('label.changed', { label: 'agent:reprendre', change: 'added' }), workflow);
    expect(out).toEqual(decision());
    expect(out.trace).toContain('merged: refused dev-feedback');
  });

  it('a human status change reopens a merged ticket the factory could not move to done', () => {
    const stuck = merged({ logical: 'human_review' });
    expect(devStarts(decide(stuck, ev('status.changed', { from: 'human_review', to: 'dev' }), workflow))).toEqual([expect.objectContaining({ job: 'dev-feedback' })]);
    expect(devStarts(decide(stuck, ev('status.changed', { from: 'human_review', to: 'done' }), workflow))).toEqual([]);
  });

  it('no rule nor timer starts dev work on a merged ticket', () => {
    expect(devStarts(decide(merged({ logical: 'human_review' }), ev('pr.checks_failed', { number: 3, url: 'u', branch: 'b', failures: ['test'] }), workflow))).toEqual([]);
    expect(decide(merged(), ev('timer.fired', { kind: 'debounce', payload: { job: 'dev-feedback' } }), workflow)).toEqual(decision());
    const reply = decide(merged({ logical: 'human_review', linearSessionId: 's1' }), ev('session.prompted', { linearSessionId: 's1', body: 'encore ?', author: 'L' }), workflow);
    expect(kinds(reply)).toEqual({ events: ['feedback.appended'], effects: [], timers: [] });
  });

  it('ignores the end of the dev run in flight at the merge, and its verification is fenced', () => {
    const finished = ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 1, turns: 3, lastText: 'ok' });
    const out = decide(merged({ activeRunId: 'r1' }), finished, workflow);
    expect(out).toEqual(decision());
    expect(out.trace).toEqual(['merged: ignored run.finished for run r1']);
    const failed = ev('verify.failed', { runId: 'r1', job: 'dev', failures: [{ command: 'npm test', exitCode: 1, output: 'rouge' }] });
    // pr.merged cancelled the verification awaited: a late result is stale.
    const late = decide(merged(), failed, workflow);
    expect(late).toEqual(decision());
    expect(late.trace[0]).toMatch(/^fenced: /);
  });

  it('still answers questions and still posts the learn run of a merged ticket', () => {
    const question = decide(merged({ linearSessionId: 's1' }), ev('session.mentioned', { linearSessionId: 's2', body: '?', author: 'L' }), workflow);
    expect(question.effects[0]).toMatchObject({ kind: 'start_run', job: 'ask' });
    const learned = decide(merged(), ev('run.finished', { runId: 'r9', job: 'learn', outcome: 'success', costUsd: 0, turns: 1, lastText: '' }), workflow);
    expect(learned.trace).not.toContain('merged: ignored run.finished for run r9');
  });
});

describe('decide — verify on the same commit (ORC-151)', () => {
  const running = (): TicketState => ({ ...newTicketState('p', 'REL-1', 'T', 'dev', 0), delegated: true, activeRunId: 'r1', activeJob: 'dev', linearSessionId: 'ls-1' });
  const event = <T extends EventType>(type: T, payload: EventPayloads[T]) => ({ id: 'e', type, at: 1, projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint: 'trusted', payload }) as FactoryEvent;

  it('a dev run that declares no command still goes through verify', () => {
    expect(workflow.jobs['dev']!.verify).toEqual([]);
    const out = decide(running(), event('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 0, turns: 1, lastText: '' }), workflow);
    expect(out.effects).toContainEqual({ kind: 'run_verify', runId: 'r1', job: 'dev' });
    expect(out.effects.some((e) => e.kind === 'move')).toBe(false);
  });

  it('a review goes through it too, and a failure blocks: the review did not write the commit (a push since)', () => {
    expect(workflow.jobs['review']!.repoChecks).toBe(true);
    const t = { ...running(), verifyingRunId: 'r1', activeRunId: undefined };
    const out = decide(t, event('verify.failed', { runId: 'r1', job: 'review', failures: [{ command: 'npm test', exitCode: 1, output: 'red' }] }), workflow);
    expect(out.effects.some((e) => e.kind === 'start_run')).toBe(false);
    expect(out.events).toContainEqual({ type: 'ticket.blocked', reason: expect.stringMatching(/^Vérifications en échec après review/) });
    expect(blockCause((out.events[0] as { reason: string }).reason)).toBe('failed');
  });

  it('so do the jobs that fix what it wrote, and not those that only answer', () => {
    expect(workflow.jobs['dev-feedback']!.repoChecks).toBe(true);
    expect(workflow.jobs['fix-ci']!.repoChecks).toBe(true);
    expect(workflow.jobs['ask']!.repoChecks).toBeUndefined();
  });

  it('a green verify records its commit, and only then goes on', () => {
    const out = decide({ ...running(), verifyingRunId: 'r1' }, event('verify.passed', { runId: 'r1', job: 'dev', sha: 'abc' }), workflow);
    expect(out.events).toContainEqual({ type: 'ticket.patched', patch: expect.objectContaining({ verifiedSha: 'abc', verifyAttempts: 0 }) });
    expect(out.effects).toContainEqual({ kind: 'move', to: 'human_review' });
  });

  it('a commit green once may be published, a new one asks for its own', () => {
    expect(mayPublish({ verifiedSha: 'abc' }, 'abc', workflow)).toBe(true);
    expect(mayPublish({ verifiedSha: 'abc' }, 'def', workflow)).toBe(false);
    expect(mayPublish({}, 'abc', workflow)).toBe(false);
  });

  it('a workflow frozen before these checks publishes as it did', () => {
    const before = structuredClone(workflow);
    for (const job of Object.values(before.jobs)) delete job.repoChecks;
    expect(mayPublish({}, 'abc', before)).toBe(true);
  });

  it('the 3 returns of the default preset: the 4th failure blocks, the agent resumed three times with the logs', () => {
    const failures = [{ command: 'npm test', exitCode: 1, output: 'red' }];
    let t: TicketState = { ...running(), activeRunId: undefined, activeJob: undefined };
    const returned: Decision[] = [];
    for (let i = 0; i < 4; i++) {
      t = { ...t, verifyingRunId: 'r1' };
      const e = event('verify.failed', { runId: 'r1', job: 'dev', failures });
      const out = decide(t, e, workflow);
      returned.push(out);
      t = out.events.reduce((s, x) => reduce(s, { kind: 'internal', event: x } as never) ?? s, reduce(t, e)!);
      t = { ...t, ...Object.assign({}, ...out.events.filter((x) => x.type === 'ticket.patched').map((x) => (x as { patch: object }).patch)) };
    }
    expect(returned.map((d) => d.effects.some((x) => x.kind === 'start_run' && x.input === 'verify_failures'))).toEqual([true, true, true, false]);
    expect(returned[3]!.events).toContainEqual({ type: 'ticket.blocked', reason: expect.stringMatching(/^Vérifications toujours en échec/) });
  });
});

describe('decide — verify.errored (ORC-151)', () => {
  const checking = (): TicketState => ({ ...newTicketState('p', 'REL-1', 'T', 'dev', 0), delegated: true, verifyingRunId: 'r1', verifyAttempts: 1, linearSessionId: 'ls-1' });
  const errored = (runId = 'r1') => ({ id: 'e', type: 'verify.errored', at: 1, projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint: 'trusted', payload: { runId, job: 'dev', error: 'engine down' } }) as FactoryEvent;

  it('blocks with the breakdown, moves no counter, and gives the agent nothing to fix', () => {
    const out = decide(checking(), errored(), workflow);
    expect(out.effects.some((e) => e.kind === 'start_run')).toBe(false);
    expect(out.events).toEqual([{ type: 'ticket.blocked', reason: expect.stringMatching(/^La vérification de dev n'a pas pu tourner : panne d'infrastructure/) }]);
    expect(out.effects).toContainEqual({ kind: 'activity', type: 'elicitation', body: expect.stringContaining('engine down') });
    expect(blockCause((out.events[0] as { reason: string }).reason)).toBe('infra');
  });

  it('is no longer awaited once it arrived, and a stale one is fenced', () => {
    expect(reduce(checking(), errored())!.verifyingRunId).toBeUndefined();
    expect(isFenced(decide(checking(), errored('old'), workflow))).toBe(true);
  });
});

describe('decide — purity', () => {
  it('gives the same decision twice for the same state, event and workflow, and leaves the state untouched', () => {
    const state = ticket({ logical: 'dev', blocked: true, linearSessionId: 's1' });
    const before = structuredClone(state);
    const event = ev('session.prompted', { linearSessionId: 's1', body: 'oui, vas-y', author: 'L' });
    expect(decide(state, event, workflow)).toEqual(decide(state, event, workflow));
    expect(state).toEqual(before);
  });
});

describe('decide — fencing', () => {
  const passed = ev('verify.passed', { runId: 'r1', job: 'dev' });

  it('ignores a verification result that arrives after the ticket was stopped', () => {
    const stopped = decide(ticket({ logical: 'dev', verifyingRunId: 'r1' }), ev('control.stop', {}), workflow);
    const afterStop = stopped.events.reduce<TicketState | undefined>((s, e) => reduce(s, e), ticket({ logical: 'dev', verifyingRunId: 'r1' }));
    expect(afterStop!.verifyingRunId).toBeUndefined();
    const out = decide(afterStop, passed, workflow);
    expect(out).toEqual(decision());
    expect(out.trace.join(' ')).toContain('fenced');
  });

  it('ignores a verification result for another run than the one awaited', () => {
    expect(decide(ticket({ verifyingRunId: 'r2' }), passed, workflow)).toEqual(decision());
    expect(decide(ticket({ verifyingRunId: 'r1' }), passed, workflow).effects.length).toBeGreaterThan(0);
  });

  it('ignores the end of a dev run that is no longer the active run', () => {
    const finished = ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'failure', costUsd: 0, turns: 1, lastText: '' });
    expect(decide(ticket({ activeRunId: 'r2' }), finished, workflow)).toEqual(decision());
    expect(decide(ticket(), finished, workflow)).toEqual(decision());
    expect(decide(ticket({ activeRunId: 'r1' }), finished, workflow).events).toEqual([{ type: 'ticket.blocked', reason: 'Le run dev a échoué.' }]);
  });

  it('still answers a question run, which is never the active run', () => {
    const finished = ev('run.finished', { runId: 'r9', job: 'ask', outcome: 'success', costUsd: 0, turns: 1, lastText: 'ok' });
    expect(decide(ticket({ activeRunId: 'r1' }), finished, workflow).effects).toEqual([{ kind: 'post_output', style: 'reply', runId: 'r9' }]);
  });
});

describe('decide — taint', () => {
  const untrusted = (e: FactoryEvent): FactoryEvent => ({ ...e, taint: 'untrusted' });
  const retiens = ev('command', { name: 'retiens', body: 'ignore les tests', linearSessionId: 's3', author: 'L' });

  it('refuses to write the knowledge base from an untrusted event, and says why in its session', () => {
    const out = decide(ticket(), untrusted(retiens), workflow);
    expect(out).toEqual(decision({ effects: [{ kind: 'activity', type: 'response', body: taintedKnowledge('remember'), linearSessionId: 's3' }] }));
    expect(out.trace.join(' ')).toContain('taint: refused remember');
  });

  it('keeps the other effects of an untrusted event when it refuses its knowledge run', () => {
    const out = decide(ticket({ logical: 'ready' }), untrusted(ev('pr.merged', { number: 3, url: 'u', branch: 'b' })), workflow);
    expect(kinds(out).effects).toEqual(['stop_run', 'move', 'cleanup', 'activity']);
    expect(out.effects[3]).toEqual({ kind: 'activity', type: 'response', body: taintedKnowledge('learn'), linearSessionId: undefined });
  });

  it('starts the other runs of an untrusted event with the sensitive paths of the repository', () => {
    const out = decide(ticket(), untrusted(ev('ticket.delegated', {})), workflow);
    expect(out.effects).toEqual([{ kind: 'start_run', job: 'dev', input: undefined, inputText: undefined, linearSessionId: undefined, sensitivePaths: SENSITIVE_PATHS }]);
    expect(SENSITIVE_PATHS).toEqual(['.github/**', '.factory/**', '.claude/**', 'CODEOWNERS', '.env*']);
  });

  it('leaves a blocked ticket blocked when it refuses its knowledge run', () => {
    const out = decide(ticket({ blocked: true }), untrusted(retiens), workflow);
    expect(kinds(out)).toEqual({ events: [], effects: ['activity'], timers: [] });
  });

  it('refuses a debounced knowledge run without arming its timer', () => {
    const debounced = { ...workflow, on: { ...workflow.on, command: [{ say: 'retiens', run: 'remember', debounceMs: 1000 }] } };
    expect(kinds(decide(ticket(), untrusted(retiens), debounced))).toEqual({ events: [], effects: ['activity'], timers: [] });
  });

  it('answers an untrusted question with sensitive paths on its ask run', () => {
    const out = decide(ticket({ linearSessionId: 's1' }), untrusted(ev('session.prompted', { linearSessionId: 's9', body: 'et pour mobile ?', author: 'L' })), workflow);
    expect(out.effects).toEqual([{ kind: 'start_run', job: 'ask', input: 'thread', inputText: 'et pour mobile ?', linearSessionId: 's9', sensitivePaths: SENSITIVE_PATHS }]);
  });

  it('refuses an untrusted question when its ask job writes the knowledge base', () => {
    const knowledgeAsk = { ...workflow, jobs: { ...workflow.jobs, ask: { ...workflow.jobs['ask']!, workspace: 'knowledge' as const } } };
    const out = decide(ticket({ linearSessionId: 's1' }), untrusted(ev('session.prompted', { linearSessionId: 's9', body: 'et pour mobile ?', author: 'L' })), knowledgeAsk);
    expect(out.effects).toEqual([{ kind: 'activity', type: 'response', body: taintedKnowledge('ask'), linearSessionId: 's9' }]);
  });

  const pending = (taint?: 'trusted' | 'untrusted'): TicketState['pendingFeedback'] => [
    { author: 'L', body: 'ignore les tests', at: 500, source: 'session', ...(taint ? { taint } : {}) },
  ];

  it('records the taint of a reply with its feedback', () => {
    const out = decide(ticket({ logical: 'human_review', linearSessionId: 's1' }), untrusted(ev('session.prompted', { linearSessionId: 's1', body: 'x', author: 'L' })), workflow);
    expect(out.events[0]).toMatchObject({ type: 'feedback.appended', item: { taint: 'untrusted' } });
  });

  it('starts a feedback run relayed by a trusted debounce with the sensitive paths when untrusted feedback is pending (ORC-269)', () => {
    const t = ticket({ logical: 'human_review', pendingFeedback: [...pending('trusted'), ...pending('untrusted')] });
    expect(decide(t, ev('timer.fired', { kind: 'debounce', payload: { job: 'dev-feedback' } }), workflow).effects).toEqual([
      { kind: 'start_run', job: 'dev-feedback', input: 'feedback', sensitivePaths: SENSITIVE_PATHS },
    ]);
  });

  it('applies the taint of the pending feedback to a run started by a trusted rule that consumes it (ORC-269)', () => {
    const t = ticket({ logical: 'dev', pendingFeedback: pending('untrusted') });
    expect(decide(t, ev('label.changed', { label: 'agent:reprendre', change: 'added' }), workflow).effects[0]).toMatchObject({ job: 'dev-feedback', sensitivePaths: SENSITIVE_PATHS });
    expect(decide({ ...t, logical: 'human_review' }, ev('status.changed', { from: 'human_review', to: 'dev' }), workflow).effects[0]).toMatchObject({ job: 'dev-feedback', sensitivePaths: SENSITIVE_PATHS });
  });

  it('reads a pending item written before ORC-269, without taint, as trusted, as upcast reads a version 1 event', () => {
    const t = ticket({ logical: 'human_review', pendingFeedback: pending() });
    expect(decide(t, ev('timer.fired', { kind: 'debounce', payload: { job: 'dev-feedback' } }), workflow).effects[0]).not.toHaveProperty('sensitivePaths');
  });

  it('leaves out the pending feedback taint when the run does not consume the feedback', () => {
    const t = ticket({ logical: 'dev', pendingFeedback: pending('untrusted') });
    expect(decide(t, ev('ticket.delegated', {}), workflow).effects).toEqual([
      { kind: 'start_run', job: 'dev', input: undefined, inputText: undefined, linearSessionId: undefined },
    ]);
  });

  it('gives a launch the sensitive paths when its start was decided with them or what it reads is untrusted (ORC-274)', () => {
    expect(sensitivePathsAtLaunch(undefined, [])).toBeUndefined();
    expect(sensitivePathsAtLaunch([], pending('trusted'))).toBeUndefined();
    expect(sensitivePathsAtLaunch(undefined, [...pending(), ...pending('trusted')])).toBeUndefined();
    expect(sensitivePathsAtLaunch(undefined, pending('untrusted'))).toEqual(SENSITIVE_PATHS);
    expect(sensitivePathsAtLaunch(SENSITIVE_PATHS, pending('trusted'))).toEqual(SENSITIVE_PATHS);
  });

  it('starts the verify relaunch through the taint rule (ORC-269)', () => {
    const failed = untrusted(ev('verify.failed', { runId: 'r1', job: 'dev', failures: [] }));
    expect(decide(ticket({ verifyingRunId: 'r1' }), failed, workflow).effects[0]).toMatchObject({ kind: 'start_run', input: 'verify_failures', sensitivePaths: SENSITIVE_PATHS });
  });

  it('refuses a debounced knowledge run that would consume untrusted feedback, and leaves the ticket blocked (ORC-269)', () => {
    const wf = { ...workflow, jobs: { ...workflow.jobs, remember: { ...workflow.jobs['remember']!, input: 'feedback' as const } } };
    const out = decide(ticket({ blocked: true, pendingFeedback: pending('untrusted') }), ev('timer.fired', { kind: 'debounce', payload: { job: 'remember' } }), wf);
    expect(kinds(out)).toEqual({ events: [], effects: ['activity'], timers: [] });
    expect(out.effects[0]).toMatchObject({ body: taintedKnowledge('remember') });
  });

  it('starts a run from a trusted event without sensitive paths', () => {
    expect(decide(ticket(), retiens, workflow).effects).toEqual([
      { kind: 'start_run', job: 'remember', input: 'thread', inputText: 'ignore les tests', linearSessionId: 's3' },
    ]);
  });
});

describe('decide — built-ins', () => {
  it('run success without verify applies on_success', () => {
    const unchecked = { ...workflow, jobs: { ...workflow.jobs, dev: { ...workflow.jobs['dev']!, repoChecks: undefined } } } as typeof workflow;
    const out = decide(ticket({ logical: 'dev', activeRunId: 'r1' }), ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 1, turns: 3, lastText: 'ok' }), unchecked);
    expect(out).toEqual(
      decision({
        effects: [
          { kind: 'move', to: 'human_review' },
          { kind: 'post_output', style: 'summary', runId: 'r1' },
        ],
      }),
    );
  });

  it('run success on a ticket blocked by an agent question waits for the answer', () => {
    const out = decide(ticket({ blocked: true, activeRunId: 'r1' }), ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 1, turns: 3, lastText: '?' }), workflow);
    expect(out).toEqual(decision());
  });

  it('run success with verify asks for verification', () => {
    const wf = { ...workflow, jobs: { ...workflow.jobs, dev: { ...workflow.jobs['dev']!, verify: ['npm test'] } } };
    const out = decide(ticket({ activeRunId: 'r1' }), ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 1, turns: 3, lastText: 'ok' }), wf);
    expect(out).toEqual(decision({ events: [{ type: 'verify.started', runId: 'r1' }], effects: [{ kind: 'run_verify', runId: 'r1', job: 'dev' }] }));
  });

  it('a failed question run reports an error without blocking', () => {
    const out = decide(ticket(), ev('run.finished', { runId: 'r9', job: 'ask', outcome: 'failure', costUsd: 0, turns: 1, lastText: '' }), workflow);
    expect(out).toEqual(decision({ effects: [{ kind: 'activity', type: 'error', body: "Je n'ai pas pu terminer (échec ou plafond atteint).", runId: 'r9' }] }));
  });

  it('run limit blocks and asks', () => {
    const out = decide(ticket({ activeRunId: 'r1' }), ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'limit', costUsd: 5, turns: 150, lastText: '' }), workflow);
    expect(kinds(out)).toEqual({ events: ['ticket.blocked'], effects: ['activity', 'labels'], timers: [] });
    expect(out.effects[0]).toMatchObject({ type: 'elicitation' });
  });

  it('verify failure goes back to the run 3 times, then the 4th failure blocks (preset bound, ORC-187)', () => {
    const failures = [{ command: 'npm test', exitCode: 1, output: 'boom' }];
    const first = decide(ticket({ verifyAttempts: 0, verifyingRunId: 'r1' }), ev('verify.failed', { runId: 'r1', job: 'dev', failures }), workflow);
    expect(first.events).toEqual([{ type: 'ticket.patched', patch: { verifyAttempts: 1 } }]);
    expect(first.effects[0]).toMatchObject({ kind: 'start_run', job: 'dev', input: 'verify_failures', resume: true });
    const third = decide(ticket({ verifyAttempts: 2, verifyingRunId: 'r3' }), ev('verify.failed', { runId: 'r3', job: 'dev', failures }), workflow);
    expect(third.effects[0]).toMatchObject({ kind: 'start_run', job: 'dev', input: 'verify_failures' });
    const fourth = decide(ticket({ verifyAttempts: 3, verifyingRunId: 'r4' }), ev('verify.failed', { runId: 'r4', job: 'dev', failures }), workflow);
    expect(kinds(fourth)).toEqual({ events: ['ticket.blocked'], effects: ['activity', 'labels'], timers: [] });
  });

  describe('stagnation of an attempt, read from the journaled event (ORC-136)', () => {
    const dev = ticket({ logical: 'dev', activeRunId: 'r1' });
    const loop = { kind: 'loop', command: 'npm test', failure: 'sha256:f', tree: 'abc', count: 3 } as const;
    const finished = (stagnation?: EventPayloads['run.finished']['stagnation'], extra: Partial<EventPayloads['run.finished']> = {}) =>
      ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'limit', costUsd: 1, turns: 3, lastText: 'ok', attempt: 'timeout', ...(stagnation ? { stagnation } : {}), ...extra });

    it('a loop at the bound blocks, cause « boucle », naming the command', () => {
      const out = decide(dev, finished(loop), workflow);
      expect(kinds(out)).toEqual({ events: ['ticket.blocked'], effects: ['activity', 'labels'], timers: [] });
      const reason = (out.events[0] as { reason: string }).reason;
      expect(blockCause(reason)).toBe('loop');
      expect(out.effects[0]).toMatchObject({ type: 'elicitation', body: expect.stringContaining('`npm test`') });
    });

    it('the bound is the frozen workflow\'s: under it, or on a version without it, the fact decides nothing and the cap speaks', () => {
      const cap = decide(dev, finished(), workflow);
      expect(decide(dev, finished({ ...loop, count: 2 }), workflow)).toEqual(cap);
      const older = { ...workflow, limits: { ...workflow.limits, repeatedFailures: undefined } };
      expect(decide(dev, finished(loop), older)).toEqual(decide(dev, finished(), older));
    });

    it('a silent agent blocks, on the cap cause, the minutes in the reason', () => {
      const out = decide(dev, finished({ kind: 'silent', silentMs: 30 * 60_000 }), workflow);
      const reason = (out.events[0] as { reason: string }).reason;
      expect(reason).toContain("n'a rien écrit depuis 30 min");
      expect(blockCause(reason)).toBe('limit');
    });

    it('an event without the fact, as journaled before it, decides as it did', () => {
      const old = ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'limit', costUsd: 1, turns: 3, lastText: 'ok' });
      const out = decide(dev, old, workflow);
      expect(out.events[0]).toMatchObject({ reason: 'Le run dev a atteint un plafond (tours, durée ou budget).' });
    });

    it('a ticket already blocked keeps its reason and is not told twice', () => {
      const blocked = ticket({ logical: 'dev', activeRunId: 'r1', blocked: true, blockReason: "En attente d'une réponse" });
      expect(decide(blocked, finished(loop), workflow).events).toEqual([]);
    });

    it('a build that asked through `ask` then ended its turn, no output: its question stays, no second notice', () => {
      const asked = ticket({ logical: 'dev', activeRunId: 'r1', blocked: true, blockReason: "Question posée par l'agent" });
      const out = decide(asked, ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 1, turns: 3, lastText: 'ok', attempt: 'failed' }), workflow);
      expect(out.events).toEqual([]);
      expect(out.effects).toEqual([]);
    });

    it('a stopped run is a stop, whatever it had seen', () => {
      const out = decide(dev, finished(loop, { outcome: 'stopped', attempt: 'errored' }), workflow);
      expect(out.events).toEqual([]);
    });

    it('a question run ends on its error notice: a loop blocks no ticket from there', () => {
      const q = decide(ticket(), ev('run.finished', { runId: 'r9', job: 'ask', outcome: 'limit', costUsd: 0, turns: 1, lastText: '', stagnation: loop }), workflow);
      expect(q.events).toEqual([]);
      expect(q.effects[0]).toMatchObject({ kind: 'activity', type: 'error' });
    });
  });

  describe('closed outcome of the attempt (ORC-289)', () => {
    const output: AgentOutput = { status: 'done', summary: 'Export CSV ajouté.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [] };
    const finished = (attempt: AttemptOutcome, extra: Partial<EventPayloads['run.finished']> = {}) =>
      ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 1, turns: 3, lastText: 'ok', attempt, ...extra });
    const dev = ticket({ logical: 'dev', activeRunId: 'r1' });
    const today = (outcome: 'success' | 'failure' | 'limit') => decide(dev, ev('run.finished', { runId: 'r1', job: 'dev', outcome, costUsd: 1, turns: 3, lastText: 'ok' }), workflow);
    const structured = workflow;
    // A job the pack does not ask `submit_result` of yet, as `dev` was before ORC-136.
    const unstructured = { ...workflow, jobs: { ...workflow.jobs, dev: { ...workflow.jobs['dev']!, structuredOutput: false } } };

    it('succeeded decides as a success, timeout as a cap', () => {
      expect(decide(dev, finished('succeeded'), workflow)).toEqual(today('success'));
      expect(decide(dev, finished('timeout', { outcome: 'limit' }), workflow)).toEqual(today('limit'));
    });

    it('failed decides as a failure, but a success without output stays a success until the job is structured', () => {
      expect(decide(dev, finished('failed', { outcome: 'failure' }), workflow)).toEqual(today('failure'));
      const success = decide(dev, ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 1, turns: 3, lastText: 'ok' }), unstructured);
      expect(decide(dev, finished('failed'), unstructured)).toEqual(success);
      const out = decide(dev, finished('failed'), structured);
      expect(kinds(out)).toEqual({ events: ['ticket.blocked'], effects: ['activity', 'labels'], timers: [] });
    });

    it('errored blocks on the infrastructure and starts no correction run', () => {
      const out = decide(dev, finished('errored', { outcome: 'failure' }), workflow);
      expect(kinds(out)).toEqual({ events: ['ticket.blocked'], effects: ['activity', 'labels'], timers: [] });
      expect(out.events[0]).toMatchObject({ reason: expect.stringContaining("panne d'infrastructure, l'agent n'est pas en cause") });
    });

    it('needs_input blocks with the question, spec_impossible with the justification', () => {
      const asked = decide(dev, finished('needs_input', { output: { ...output, status: 'blocked', question: 'Quel séparateur ?' } }), workflow);
      expect(kinds(asked)).toEqual({ events: ['ticket.blocked'], effects: ['activity', 'labels'], timers: [] });
      expect(asked.effects[0]).toMatchObject({ type: 'elicitation', body: expect.stringContaining('Quel séparateur ?') });
      const contested = decide(dev, finished('spec_impossible', { output: { ...output, status: 'blocked', reason: 'spec_impossible', question: 'Les critères se contredisent.' } }), workflow);
      expect(contested.events[0]).toMatchObject({ type: 'ticket.blocked', reason: expect.stringContaining('conteste') });
      expect(contested.effects[0]).toMatchObject({ type: 'elicitation', body: expect.stringContaining('Les critères se contredisent.') });
    });

    it('a ticket already blocked (the agent asked) is not blocked again nor told twice', () => {
      const blocked = ticket({ logical: 'dev', activeRunId: 'r1', blocked: true, blockReason: "En attente d'une réponse" });
      const asked = { ...output, status: 'blocked' as const, question: 'Quel séparateur ?' };
      expect(decide(blocked, finished('needs_input', { output: asked }), workflow)).toEqual(decision());
      expect(decide(blocked, finished('spec_impossible', { output: { ...asked, reason: 'spec_impossible' } }), workflow)).toEqual(decision());
      expect(decide(blocked, finished('errored', { outcome: 'failure' }), workflow)).toEqual(decision());
    });

    it('post_output carries the validated output, through verify too; omitted without one', () => {
      const unchecked = { ...workflow, jobs: { ...workflow.jobs, dev: { ...workflow.jobs['dev']!, repoChecks: undefined } } } as typeof workflow;
      expect(decide(dev, finished('succeeded', { output }), unchecked).effects).toContainEqual({ kind: 'post_output', style: 'summary', runId: 'r1', output });
      expect(decide(dev, ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 1, turns: 3, lastText: 'ok' }), unchecked).effects).toContainEqual({ kind: 'post_output', style: 'summary', runId: 'r1' });
      expect(decide(dev, finished('succeeded', { output }), workflow).effects).toContainEqual({ kind: 'run_verify', runId: 'r1', job: 'dev', output });
      const passed = decide(ticket({ verifyingRunId: 'r1' }), ev('verify.passed', { runId: 'r1', job: 'dev', output }), workflow);
      expect(passed.effects).toContainEqual({ kind: 'post_output', style: 'summary', runId: 'r1', output });
    });

    it('a stopped run stays ignored, whatever its attempt', () => {
      expect(decide(dev, finished('errored', { outcome: 'stopped' }), workflow)).toEqual(decision());
    });
  });

  describe('same command, same failure, unchanged diff (ORC-187)', () => {
    const failures = [{ command: 'npm test', exitCode: 1, output: 'boom at 12:00' }];
    const failed = (runId: string, tree?: string, f = failures) => ev('verify.failed', { runId, job: 'dev', failures: f, ...(tree ? { tree } : {}) });

    it('blocks with the cause « boucle » at the third occurrence', () => {
      let t = ticket({ verifyingRunId: 'r1' });
      for (const [i, runId] of ['r1', 'r2'].entries()) {
        const out = decide({ ...t, verifyingRunId: runId }, failed(runId, 'abc'), workflow);
        expect(out.effects[0], `occurrence ${i + 1}`).toMatchObject({ kind: 'start_run' });
        t = out.events.reduce<TicketState>((s, e) => reduce(s, e)!, { ...t, verifyingRunId: runId });
      }
      expect(t.repeatedFailure).toMatchObject({ count: 2 });
      const third = decide({ ...t, verifyingRunId: 'r3' }, failed('r3', 'abc'), workflow);
      expect(kinds(third)).toEqual({ events: ['ticket.patched', 'ticket.blocked'], effects: ['activity', 'labels'], timers: [] });
      expect(third.events[1]).toMatchObject({ type: 'ticket.blocked', reason: expect.stringMatching(/^Boucle :/) });
    });

    it('starts over when the diff changes, the failed command changes, or the check passes', () => {
      const seen = ticket({ verifyingRunId: 'r3', repeatedFailure: { signature: 'dev|abc|npm test:1', count: 2 } });
      expect(decide(seen, failed('r3', 'def'), workflow).events[0]).toEqual({ type: 'ticket.patched', patch: { verifyAttempts: 1, repeatedFailure: { signature: 'dev|def|npm test:1', count: 1 } } });
      const lint = [{ command: 'npm run lint', exitCode: 1, output: '' }];
      expect(decide(seen, failed('r3', 'abc', lint), workflow).events[0]).toMatchObject({ patch: { repeatedFailure: { count: 1 } } });
      // null, not undefined: the reset must survive the JSON of the journal.
      expect(decide(seen, ev('verify.passed', { runId: 'r3', job: 'dev' }), workflow).events[0]).toStrictEqual({ type: 'ticket.patched', patch: { verifyAttempts: 0, repeatedFailure: null } });
    });

    it('counts each job apart', () => {
      const once = decide(ticket({ verifyingRunId: 'r1' }), failed('r1', 'abc'), workflow);
      const seen = once.events.reduce<TicketState>((s, e) => reduce(s, e)!, ticket({ verifyingRunId: 'r2' }));
      const same = decide(seen, failed('r2', 'abc'), workflow);
      const other = decide(seen, ev('verify.failed', { runId: 'r2', job: 'dev-feedback', failures, tree: 'abc' }), workflow);
      expect(same.events[0]).toMatchObject({ patch: { repeatedFailure: { count: 2 } } });
      expect(other.events[0]).toMatchObject({ patch: { repeatedFailure: { count: 1 } } });
    });

    it('gives the whole bound back when a human relaunches the ticket', () => {
      const looped = ticket({ logical: 'dev', blocked: true, linearSessionId: 's1', repeatedFailure: { signature: 'dev|abc|npm test:1', count: 3 } });
      const out = decide(looped, ev('session.prompted', { linearSessionId: 's1', body: 'réessaie', author: 'L' }), workflow);
      expect(out.events).toContainEqual({ type: 'ticket.patched', patch: { repeatedFailure: null } });
    });

    it('is not tracked without a fingerprint of the worktree', () => {
      const out = decide(ticket({ verifyingRunId: 'r1' }), failed('r1'), workflow);
      expect(out.events).toEqual([{ type: 'ticket.patched', patch: { verifyAttempts: 1 } }]);
    });
  });

  describe('red CI loop bounded by limits.ci_fix_attempts (I5, ORC-270)', () => {
    const red = ev('pr.checks_failed', { number: 3, url: 'u', branch: 'b', failures: ['test', 'lint'] });
    const inReview = (patch: Partial<TicketState> = {}) => ticket({ logical: 'human_review', ...patch });

    it('starts fix-ci and counts it while the count is under the bound', () => {
      expect(workflow.limits.ciFixAttempts).toBe(2);
      for (const used of [0, 1]) {
        const out = decide(inReview({ ciFixAttempts: used }), red, workflow);
        expect(out.events).toEqual([{ type: 'ticket.patched', patch: { ciFixAttempts: used + 1 } }]);
        expect(out.effects).toEqual([{ kind: 'start_run', job: 'fix-ci', input: 'ci_failures', inputText: undefined, linearSessionId: undefined }]);
      }
    });

    it('blocks once the bound is reached, with the checks still red and no fix-ci', () => {
      const out = decide(inReview({ ciFixAttempts: 2 }), red, workflow);
      const reason = 'CI toujours en échec après 2 tentatives de fix-ci.';
      expect(out).toEqual(
        decision({
          events: [{ type: 'ticket.blocked', reason }],
          effects: [{ kind: 'activity', type: 'elicitation', body: `${reason}\n- \`test\`\n- \`lint\`\nRépondez dans ce fil pour relancer.` }, { kind: 'labels', add: ['Bloqué'], remove: [] }],
        }),
      );
      // Blocked, the ticket gets no fix-ci from a later red CI either, and no second notice.
      const after = reduce(reduce(inReview({ ciFixAttempts: 2 }), red), out.events[0]!);
      expect(decide(after, red, workflow)).toEqual(decision());
    });

    it('ci_fix_attempts: 0 blocks at the first red CI', () => {
      const wf = { ...workflow, limits: { ...workflow.limits, ciFixAttempts: 0 } };
      expect(kinds(decide(inReview(), red, wf))).toEqual({ events: ['ticket.blocked'], effects: ['activity', 'labels'], timers: [] });
    });

    it('a green CI resets the count, and records nothing when it is already 0', () => {
      const green = ev('pr.checks_passed', { number: 3, url: 'u', branch: 'b' });
      expect(decide(inReview({ ciFixAttempts: 2 }), green, workflow).events).toEqual([{ type: 'ticket.patched', patch: { ciFixAttempts: 0 } }]);
      expect(decide(inReview(), green, workflow).events).toEqual([]);
    });

    it('a green CI lifts the block of the red-CI bound, and only that block', () => {
      const green = ev('pr.checks_passed', { number: 3, url: 'u', branch: 'b' });
      const ciBlocked = inReview({ ciFixAttempts: 2, blocked: true, blockReason: 'CI toujours en échec après 2 tentatives de fix-ci.' });
      expect(decide(ciBlocked, green, workflow).events).toEqual([{ type: 'ticket.patched', patch: { ciFixAttempts: 0 } }, { type: 'ticket.unblocked' }]);
      const otherwise = inReview({ ciFixAttempts: 1, blocked: true, blockReason: 'Le run dev a échoué.' });
      expect(decide(otherwise, green, workflow).events).toEqual([{ type: 'ticket.patched', patch: { ciFixAttempts: 0 } }]);
    });

    it('another PR resets the count; the same PR seen again does not', () => {
      const opened = (number: number) => ev('pr.opened', { number, url: `u${number}`, branch: 'b' });
      const used = inReview({ ciFixAttempts: 2, prNumber: 3 });
      expect(decide(used, opened(4), workflow).events[0]).toEqual({ type: 'ticket.patched', patch: { ciFixAttempts: 0 } });
      expect(decide(used, opened(3), workflow).events).toEqual([{ type: 'ticket.patched', patch: { prNumber: 3, prUrl: 'u3' } }]);
    });

    it('a human who relaunches the blocked ticket resets the count', () => {
      const blocked = inReview({ ciFixAttempts: 2, blocked: true, linearSessionId: 's1' });
      const reply = decide(blocked, ev('session.prompted', { linearSessionId: 's1', body: 'corrige le lint', author: 'L' }), workflow);
      expect(reply.events.map((e) => e.type)).toEqual(['feedback.appended', 'ticket.unblocked', 'ticket.patched']);
      expect(reply.events[2]).toEqual({ type: 'ticket.patched', patch: { ciFixAttempts: 0 } });
      const label = decide(blocked, ev('label.changed', { label: 'agent:reprendre', change: 'added' }), workflow);
      expect(label.events).toEqual([{ type: 'ticket.unblocked' }, { type: 'ticket.patched', patch: { ciFixAttempts: 0 } }]);
      const moved = decide(blocked, ev('status.changed', { from: 'human_review', to: 'dev' }), workflow);
      expect(moved.events).toEqual([{ type: 'ticket.unblocked' }, { type: 'ticket.patched', patch: { ciFixAttempts: 0 } }]);
      // A timer armed before the block is no human relaunch: it would undo the bound.
      const timer = decide(blocked, ev('timer.fired', { kind: 'debounce', payload: { job: 'dev-feedback' } }), workflow);
      expect(timer.events).toEqual([{ type: 'ticket.unblocked' }]);
    });

    it('counts nothing when no fix-ci starts: no rule, or a merged PR', () => {
      expect(decide(ticket({ logical: 'dev', ciFixAttempts: 1 }), red, workflow)).toEqual(decision());
      const merged = decide(inReview({ prState: 'MERGED', ciFixAttempts: 1 }), red, workflow);
      expect(merged).toEqual(decision());
      expect(merged.trace).toContain('merged: refused fix-ci');
    });
  });

  it('debounce fired starts the job', () => {
    expect(decide(ticket({ logical: 'human_review' }), ev('timer.fired', { kind: 'debounce', payload: { job: 'dev-feedback' } }), workflow)).toEqual(
      decision({ effects: [{ kind: 'start_run', job: 'dev-feedback', input: 'feedback' }] }),
    );
  });

  it('decides nothing yet on the clarify and usage-limit timers, whose rules are ORC-210 and ORC-215 (ORC-161)', () => {
    for (const kind of ['clarify.remind', 'clarify.expire', 'usage.reset'] as const) {
      const out = decide(ticket({ logical: 'dev', blocked: true }), ev('timer.fired', { kind, payload: {} }), workflow);
      expect(out).toEqual(decision());
      expect(out.trace).toContain(`timer.fired ${kind}: no rule decides it yet`);
    }
  });

  it('pr.opened records and links the PR', () => {
    expect(decide(ticket(), ev('pr.opened', { number: 7, url: 'https://gh/pr/7', branch: 'b' }), workflow)).toEqual(
      decision({
        events: [{ type: 'ticket.patched', patch: { prNumber: 7, prUrl: 'https://gh/pr/7', prState: 'OPEN' } }],
        effects: [{ kind: 'link_pr', url: 'https://gh/pr/7' }],
      }),
    );
  });

  it('pause and resume', () => {
    expect(decide(undefined, ev('control.pause', {}), workflow)).toEqual(decision({ effects: [{ kind: 'set_paused', paused: true }] }));
    expect(decide(undefined, ev('control.resume', {}), workflow)).toEqual(decision({ effects: [{ kind: 'set_paused', paused: false }] }));
  });

  it('an effect result decides nothing; a dead effect blocks the ticket and says so once (ORC-150)', () => {
    const result = { effectId: 'REL-1:1:2', kind: 'comment', eventId: 'd1', attempts: 8 };
    expect(decide(ticket(), ev('effect.done', result), workflow)).toEqual(decision());
    expect(decide(ticket(), ev('effect.failed', { ...result, error: 'Linear down' }), workflow)).toEqual(
      decision({
        events: [{ type: 'ticket.blocked', reason: 'Erreur : Linear down' }],
        effects: [{ kind: 'activity', type: 'error', body: 'Erreur : Linear down' }, { kind: 'labels', add: ['Bloqué'], remove: [] }],
      }),
    );
    // The notice of a dead effect dies too: blocked, no new notice (no loop while the tracker is down).
    expect(decide(ticket(), ev('effect.failed', { ...result, kind: 'activity', eventId: 'effect:REL-1:1:2', error: 'Linear down' }), workflow)).toEqual(
      decision({ events: [{ type: 'ticket.blocked', reason: 'Erreur : Linear down' }] }),
    );
    // Nor a label: a dead label is the same tracker down (ORC-170).
    expect(decide(ticket(), ev('effect.failed', { ...result, kind: 'labels', error: 'Linear down' }), workflow).effects.filter((e) => e.kind === 'labels')).toEqual([]);
    // ... and on a ticket already blocked, the reason the notice carried stays.
    expect(
      decide(ticket({ blocked: true, blockReason: 'Erreur : disk full' }), ev('effect.failed', { ...result, kind: 'activity', eventId: 'effect:REL-1:1:2', error: 'Linear down' }), workflow),
    ).toEqual(decision());
    // A step of the shell, or an unknown ticket: nothing to block.
    expect(decide(ticket(), ev('effect.failed', { ...result, kind: 'settle', error: 'x' }), workflow)).toEqual(decision());
    expect(decide(undefined, ev('effect.failed', { ...result, error: 'x' }), workflow)).toEqual(decision());
    // Delivered, or stopped by a human (the reason stays): nothing to block.
    expect(decide(ticket({ logical: 'done' }), ev('effect.failed', { ...result, error: 'x' }), workflow)).toEqual(decision());
    expect(decide(ticket({ prState: 'MERGED' }), ev('effect.failed', { ...result, error: 'x' }), workflow)).toEqual(decision());
    expect(decide(ticket({ blocked: true, blockReason: 'Arrêté à la demande' }), ev('effect.failed', { ...result, error: 'x' }), workflow)).toEqual(decision());
  });
});

describe('decide — the tests step and the red check (ORC-123)', () => {
  const blocking = { ...workflow, jobs: { ...workflow.jobs, tests: { ...workflow.jobs['tests']!, red: { ...workflow.jobs['tests']!.red!, mode: 'blocking' as const } } } };
  const unverified = (runId: string, red: 'compile' | 'scope' | 'infra' = 'compile') =>
    ev('verify.failed', { runId, job: 'tests', failures: [{ command: 'npm test -- a.test.ts', exitCode: 1, output: 'SyntaxError' }], red });

  it('asks for the red check after the tests step, which has no verify commands', () => {
    const out = decide(ticket({ activeRunId: 'r1' }), ev('run.finished', { runId: 'r1', job: 'tests', outcome: 'success', costUsd: 1, turns: 3, lastText: 'ok' }), workflow);
    expect(out).toEqual(decision({ events: [{ type: 'verify.started', runId: 'r1' }], effects: [{ kind: 'run_verify', runId: 'r1', job: 'tests' }] }));
  });

  it('a verified red starts the build', () => {
    const out = decide(ticket({ verifyingRunId: 'r1', redAttempts: 1 }), ev('verify.passed', { runId: 'r1', job: 'tests', red: 'assertion' }), workflow);
    expect(out.events).toEqual([{ type: 'ticket.patched', patch: { verifyAttempts: 0, redAttempts: 0 } }]);
    expect(out.effects).toEqual([{ kind: 'start_run', job: 'dev', input: undefined }]);
  });

  it('in measure mode, an unverified red is traced « aurait bloqué » and the build starts all the same', () => {
    const out = decide(ticket({ verifyingRunId: 'r1' }), unverified('r1'), workflow);
    expect(out.events).toEqual([]);
    expect(out.effects).toEqual([{ kind: 'start_run', job: 'dev', input: undefined }]);
    expect(out.trace).toContain('red: aurait bloqué (compile), mode mesure : le run continue');
  });

  it('in blocking mode, an unverified red goes back to the tests step twice, then the 3rd blocks (counter red = 2)', () => {
    const first = decide(ticket({ verifyingRunId: 'r1' }), unverified('r1'), blocking);
    expect(first.events).toEqual([{ type: 'ticket.patched', patch: { redAttempts: 1 } }]);
    expect(first.effects[0]).toMatchObject({ kind: 'start_run', job: 'tests', input: 'verify_failures', resume: true });
    const second = decide(ticket({ verifyingRunId: 'r2', redAttempts: 1 }), unverified('r2', 'scope'), blocking);
    expect(second.effects[0]).toMatchObject({ kind: 'start_run', job: 'tests', input: 'verify_failures' });
    const third = decide(ticket({ verifyingRunId: 'r3', redAttempts: 2 }), unverified('r3'), blocking);
    expect(kinds(third)).toEqual({ events: ['ticket.blocked'], effects: ['activity', 'labels'], timers: [] });
    expect(third.events[0]).toMatchObject({ reason: 'Rouge non vérifié après 3 tentatives de tests.' });
  });

  it('in measure mode, a tests step that wrote something else than tests is recorded and the build starts', () => {
    const out = decide(ticket({ verifyingRunId: 'r1' }), unverified('r1', 'scope'), workflow);
    expect(out.effects).toEqual([{ kind: 'start_run', job: 'dev', input: undefined }]);
    expect(out.trace).toContain('red: aurait bloqué (scope), mode mesure : le run continue');
  });

  it('a red check that could not run blocks in both modes, and never resumes the agent', () => {
    for (const wf of [workflow, blocking]) {
      const out = decide(ticket({ verifyingRunId: 'r1' }), unverified('r1', 'infra'), wf);
      expect(kinds(out)).toEqual({ events: ['ticket.blocked'], effects: ['activity', 'labels'], timers: [] });
      expect(out.events[0]).toMatchObject({ reason: expect.stringContaining("panne d'infrastructure") });
    }
  });

  it('a human relaunch gives the red loop its whole bound back', () => {
    const out = decide(ticket({ logical: 'dev', blocked: true, linearSessionId: 's1', redAttempts: 2 }), ev('session.prompted', { linearSessionId: 's1', body: 'vas-y', author: 'L' }), workflow);
    expect(out.events).toContainEqual({ type: 'ticket.patched', patch: { redAttempts: 0 } });
  });
});

describe('decide — an attempt lost (ORC-220)', () => {
  const lost = (cause: 'restart' | 'lease', runId = 'r1') => ev('run.lost', { runId, job: 'dev', cause });
  const active = (patch: Partial<TicketState> = {}) => ticket({ logical: 'dev', delegated: true, activeRunId: 'r1', activeJob: 'dev', ...patch });

  it('a dev attempt cut by a restart is started again, counted at the time of the event, and the lease bound is untouched', () => {
    const out = decide(active({ leaseRelaunches: 1 }), lost('restart'), workflow);
    expect(out.effects).toContainEqual({ kind: 'start_run', job: 'dev', relaunchOf: 'r1' });
    expect(out.events).toEqual([{ type: 'ticket.patched', patch: { cutRelaunches: [1000] } }]);
  });

  it('the first expired lease relaunches once and counts it; the second blocks', () => {
    const first = decide(active(), lost('lease'), workflow);
    expect(first.effects).toContainEqual({ kind: 'start_run', job: 'dev', relaunchOf: 'r1' });
    expect(first.events).toEqual([{ type: 'ticket.patched', patch: { leaseRelaunches: 1, cutRelaunches: [1000] } }]);
    const second = decide(active({ activeRunId: 'r2', leaseRelaunches: 1 }), lost('lease', 'r2'), workflow);
    expect(second.effects.some((e) => e.kind === 'start_run')).toBe(false);
    expect(second.events).toEqual([{ type: 'ticket.blocked', reason: expect.stringContaining('bail') }]);
    expect(second.effects).toContainEqual(expect.objectContaining({ kind: 'activity', type: 'elicitation' }));
    expect(second.effects).toContainEqual({ kind: 'labels', add: ['Bloqué'], remove: [] });
  });

  it('is fenced for an attempt that is not the active one', () => {
    const out = decide(active({ activeRunId: 'r2' }), lost('restart'), workflow);
    expect(isFenced(out)).toBe(true);
    expect(out.effects).toEqual([]);
  });

  it.each([
    ['blocked', { blocked: true, blockReason: 'Arrêté à la demande' }],
    ['not delegated', { delegated: false }],
    ['merged', { prState: 'MERGED' as const }],
  ])('a ticket %s is not started again, and no longer holds the attempt', (_, patch) => {
    const t = active(patch);
    expect(decide(t, lost('restart'), workflow).effects).toEqual([]);
    expect(reduce(t, lost('restart'))).toMatchObject({ activeRunId: undefined, activeJob: undefined });
  });

  it('a question lost is told in its own thread, never started again, and leaves the ticket alone', () => {
    const question = ev('run.lost', { runId: 'q1', job: 'ask', cause: 'restart' });
    const out = decide(active({ logical: 'todo', delegated: false, activeRunId: 'r0' }), question, workflow);
    expect(out.effects).toEqual([{ kind: 'activity', type: 'error', body: expect.stringContaining('Reposez la question'), runId: 'q1' }]);
    expect(reduce(active({ activeRunId: 'r0' }), question)).toMatchObject({ activeRunId: 'r0' });
  });

  it('a finished attempt gives the lease bound back, a human relaunch too', () => {
    const done = decide(active({ leaseRelaunches: 1 }), ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'failure', costUsd: 0, turns: 1, lastText: '' }), workflow);
    expect(done.events).toContainEqual({ type: 'ticket.patched', patch: { leaseRelaunches: 0 } });
    const human = decide(ticket({ logical: 'dev', delegated: true, blocked: true, linearSessionId: 's1', leaseRelaunches: 1 }), ev('session.prompted', { linearSessionId: 's1', body: 'vas-y', author: 'L' }), workflow);
    expect(human.events).toContainEqual({ type: 'ticket.patched', patch: { leaseRelaunches: 0 } });
  });

  it('a check lost runs again, carrying the output of its run', () => {
    const output = { status: 'done', summary: 's', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [] } as never;
    const out = decide(active({ activeRunId: undefined, verifyingRunId: 'r1' }), ev('verify.lost', { runId: 'r1', job: 'dev', output }), workflow);
    expect(out.effects).toEqual([{ kind: 'run_verify', runId: 'r1', job: 'dev', output }]);
    expect(out.events).toEqual([{ type: 'ticket.patched', patch: { cutRelaunches: [1000] } }]);
    expect(reduce(active({ verifyingRunId: 'r1' }), ev('verify.lost', { runId: 'r1', job: 'dev' }))).toMatchObject({ verifyingRunId: 'r1' });
  });

  it('a check lost is fenced when it is not the one awaited', () => {
    const out = decide(active({ verifyingRunId: 'r2' }), ev('verify.lost', { runId: 'r1', job: 'dev' }), workflow);
    expect(isFenced(out)).toBe(true);
    expect(out.effects).toEqual([]);
  });
});

describe('decide — the bound of the relaunches after a cut (ORC-220)', () => {
  const at = (ms: number, e: FactoryEvent): FactoryEvent => ({ ...e, at: ms });
  const NOW = 10 * CUT_WINDOW_MS;
  const full = Array.from({ length: CUT_RELAUNCHES }, (_, i) => NOW - i - 1);
  const lost = (cause: 'restart' | 'lease') => at(NOW, ev('run.lost', { runId: 'r1', job: 'dev', cause }));
  const active = (patch: Partial<TicketState> = {}) => ticket({ logical: 'dev', delegated: true, activeRunId: 'r1', activeJob: 'dev', ...patch });

  it.each(['restart', 'lease'] as const)('a run lost by %s past the limit is not started again: blocked, with its stable reason', (cause) => {
    const out = decide(active({ cutRelaunches: full }), lost(cause), workflow);
    expect(out.effects.some((e) => e.kind === 'start_run')).toBe(false);
    expect(out.events).toEqual([{ type: 'ticket.blocked', reason: expect.stringMatching(CUT_BOUND_REASON) }]);
    expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'activity', type: 'elicitation' }));
    expect(out.effects).toContainEqual({ kind: 'labels', add: ['Bloqué'], remove: [] });
  });

  it('forgets the relaunches out of the window, exactly at its edge', () => {
    const out = decide(active({ cutRelaunches: [NOW - CUT_WINDOW_MS, NOW - 2, NOW - 1] }), lost('restart'), workflow);
    expect(out.effects).toContainEqual({ kind: 'start_run', job: 'dev', relaunchOf: 'r1' });
    expect(out.events).toEqual([{ type: 'ticket.patched', patch: { cutRelaunches: [NOW - 2, NOW - 1, NOW] } }]);
  });

  it('a check lost past the limit runs no more: the ticket no longer waits for its verdict, a relaunch can start', () => {
    const t = active({ activeRunId: undefined, verifyingRunId: 'r1', cutRelaunches: full });
    const out = decide(t, at(NOW, ev('verify.lost', { runId: 'r1', job: 'dev' })), workflow);
    expect(out.effects.some((e) => e.kind === 'run_verify')).toBe(false);
    expect(out.events).toContainEqual({ type: 'ticket.blocked', reason: expect.stringMatching(CUT_BOUND_REASON) });
    let after = reduce(t, at(NOW, ev('verify.lost', { runId: 'r1', job: 'dev' })));
    for (const x of out.events) after = reduce(after, x);
    expect(after).toMatchObject({ blocked: true, verifyingRunId: undefined });
  });

  it('a check lost past the limit on a ticket already blocked keeps its reason', () => {
    const t = active({ activeRunId: undefined, verifyingRunId: 'r1', cutRelaunches: full, blocked: true, blockReason: 'Arrêté à la demande' });
    const out = decide(t, at(NOW, ev('verify.lost', { runId: 'r1', job: 'dev' })), workflow);
    expect(out.events).toEqual([{ type: 'work.cancelled' }]);
    expect(out.effects).toEqual([]);
  });

  it('a question lost asks for no relaunch: it is not counted', () => {
    const out = decide(active({ cutRelaunches: full }), at(NOW, ev('run.lost', { runId: 'q1', job: 'ask', cause: 'restart' })), workflow);
    expect(out.events).toEqual([]);
    expect(out.effects).toEqual([expect.objectContaining({ kind: 'activity', type: 'error' })]);
  });

  it('the normal end of an attempt does not reset the count; a human relaunch does', () => {
    const done = decide(active({ cutRelaunches: full }), ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 0, turns: 1, lastText: '' }), workflow);
    expect(JSON.stringify(done.events)).not.toContain('cutRelaunches');
    const human = decide(ticket({ logical: 'dev', delegated: true, blocked: true, linearSessionId: 's1', cutRelaunches: full }), ev('session.prompted', { linearSessionId: 's1', body: 'vas-y', author: 'L' }), workflow);
    expect(human.events).toContainEqual({ type: 'ticket.patched', patch: { cutRelaunches: [] } });
  });

  it('an old ticket, without the field, gets no reset: its recorded decisions replay as they were', () => {
    const human = decide(ticket({ logical: 'dev', delegated: true, blocked: true, linearSessionId: 's1' }), ev('session.prompted', { linearSessionId: 's1', body: 'vas-y', author: 'L' }), workflow);
    expect(JSON.stringify(human.events)).not.toContain('cutRelaunches');
  });

  it('the decision reads the time of the event, not the clock: the same event decides the same, whenever', () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(NOW + 100 * CUT_WINDOW_MS);
    try {
      expect(decide(active({ cutRelaunches: full }), lost('restart'), workflow).effects.some((e) => e.kind === 'start_run')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('decide — dead letters (ORC-175)', () => {
  const added = { eventId: 'l1', eventType: 'label.changed', error: 'boom', failures: 1 };
  const reason = 'Événement l1 mis de côté (label.changed) : sa décision a échoué (boom).';
  const delegation = { ...ev('ticket.delegated', {}), id: 'l1' };

  it('blocks the ticket of a dead-lettered event and says which event, once', () => {
    expect(decide(ticket(), ev('dead_letter.added', added), workflow)).toEqual(
      decision({
        events: [{ type: 'ticket.blocked', reason }],
        effects: [{ kind: 'activity', type: 'error', body: `${reason} Un mainteneur peut le réparer : \`factory run repair REL-1\`.` }, { kind: 'labels', add: ['Bloqué'], remove: [] }],
      }),
    );
    // An unknown ticket, a delivered or a stopped one: nothing to block.
    expect(decide(undefined, ev('dead_letter.added', added), workflow)).toEqual(decision());
    expect(decide(ticket({ logical: 'done' }), ev('dead_letter.added', added), workflow)).toEqual(decision());
    expect(decide(ticket({ blocked: true, blockReason: 'Arrêté à la demande' }), ev('dead_letter.added', added), workflow)).toEqual(decision());
    // Already blocked for another reason: that reason stays (its repair would lift a block not its own), the event is announced.
    expect(decide(ticket({ blocked: true, blockReason: 'Erreur : linear down' }), ev('dead_letter.added', added), workflow)).toEqual(
      decision({ effects: [{ kind: 'activity', type: 'error', body: `${reason} Un mainteneur peut le réparer : \`factory run repair REL-1\`.` }] }),
    );
  });

  it('a repair lifts the block of its event only, and says so', () => {
    const notice = { kind: 'activity' as const, type: 'response' as const, body: 'Événement l1 réparé par ops (ignoré) : le ticket est débloqué.' };
    const skip = ev('dead_letter.repaired', { eventId: 'l1', action: 'skip', by: 'ops', event: delegation });
    // The lift happens in reduce, without ticket.unblocked: the label still comes off (ORC-170).
    expect(decide(ticket({ blocked: true, blockReason: reason }), skip, workflow)).toEqual(decision({ effects: [notice, { kind: 'labels', add: [], remove: ['Bloqué'] }] }));
    expect(reduce(ticket({ blocked: true, blockReason: reason }), skip)).toMatchObject({ blocked: false, blockReason: undefined });
    // Blocked for another reason (another event, a human stop): the block stays.
    const other = ticket({ blocked: true, blockReason: 'Arrêté à la demande' });
    expect(decide(other, skip, workflow)).toEqual(decision());
    expect(reduce(other, skip)).toEqual(other);
    const l10 = ticket({ blocked: true, blockReason: reason.replace('l1', 'l10') });
    expect(reduce(l10, skip)).toEqual(l10);
  });

  it('replay decides the event again on the unblocked ticket; force records its facts without its decision', () => {
    const blocked = ticket({ delegated: false, blocked: true, blockReason: reason });
    const replay = ev('dead_letter.repaired', { eventId: 'l1', action: 'replay', by: 'ops', event: delegation });
    // On the blocked ticket, the delegation would be ignored: the replay sees it unblocked and starts dev.
    expect(kinds(decide(blocked, replay, workflow)).effects).toEqual(['start_run', 'activity', 'labels']);
    expect(reduce(blocked, replay)).toMatchObject({ delegated: true, blocked: false });
    const force = ev('dead_letter.repaired', { eventId: 'l1', action: 'force', by: 'ops', event: delegation });
    expect(kinds(decide(blocked, force, workflow)).effects).toEqual(['activity', 'labels']);
    expect(reduce(blocked, force)).toMatchObject({ delegated: true, blocked: false });
  });

  it('a replayed result of an inactive attempt is still fenced', () => {
    const stale = { ...ev('run.finished', { runId: 'old', job: 'dev', outcome: 'success', costUsd: 0, turns: 1, lastText: '' }), id: 'l1' };
    const out = decide(ticket({ activeRunId: 'new' }), ev('dead_letter.repaired', { eventId: 'l1', action: 'replay', by: 'ops', event: stale }), workflow);
    expect(out.effects).toEqual([]);
    expect(isFenced(out)).toBe(true);
  });
});

describe('decide — a ticket whose repo is not known (ORC-291)', () => {
  const unrouted = ev('ticket.delegated', { issue: { title: 'T', logical: 'todo', priority: 0 }, repos: ['web', 'api'] });

  const blocked = decide(undefined, unrouted, workflow).events.reduce((t, e) => reduce(t, e), reduce(undefined, unrouted))!;

  it('blocks the delegation, even unsigned, labels it and asks which repo, listing them', () => {
    const out = decide(undefined, { ...unrouted, taint: 'untrusted', roles: [] }, workflow);
    expect(kinds(out)).toEqual({ events: ['ticket.blocked', 'ticket.patched'], effects: ['activity', 'labels'], timers: [] });
    expect(out.effects[0]).toMatchObject({ type: 'elicitation', body: expect.stringContaining('`repo:web`, `repo:api`') });
    expect(blocked.awaitingRepo).toEqual(['web', 'api']);
  });

  it('a ticket no project holds, blocked for another reason, waits for its repo: delegated under another reason, it would hold this repo', () => {
    const out = decide(ticket({ blocked: true, blockReason: 'Tests rouges' }), unrouted, workflow);
    expect(kinds(out)).toEqual({ events: ['ticket.blocked', 'ticket.patched'], effects: ['activity'], timers: [] });
    expect(isUnrouted(out.events.reduce((s, e) => reduce(s, e), reduce(ticket({ blocked: true, blockReason: 'Tests rouges' }), unrouted)))).toBe(true);
  });

  it('asks again in the session a new delegation opened, not in the one the ticket first waited in', () => {
    const again = ev('ticket.delegated', { linearSessionId: 's2', repos: ['web', 'api'] });
    const out = decide({ ...blocked, linearSessionId: 's1' }, again, workflow);
    expect(out.events).toEqual([]);
    expect(out.effects).toEqual([{ kind: 'activity', type: 'elicitation', body: expect.stringContaining('`repo:api`'), linearSessionId: 's2' }]);
  });

  it('a delegation naming the repo the ticket waits in lifts the wait and runs its rule', () => {
    const out = decide(blocked, ev('ticket.delegated', { linearSessionId: 's2' }), workflow);
    expect(out.events.map((e) => e.type)).toContain('ticket.unblocked');
    expect(out.effects.map((e) => e.kind)).toContain('start_run');
    expect(out.effects).toContainEqual({ kind: 'labels', add: [], remove: ['Bloqué'] });
    // The session the delegation opened is the ticket's from now on: its replies are dev feedback, not questions.
    expect(out.events.reduce((t, e) => reduce(t, e), reduce({ ...blocked, linearSessionId: 's1' }, ev('ticket.delegated', { linearSessionId: 's2' })))?.linearSessionId).toBe('s2');
  });

  it('a new ticket that waited in another repo takes the Bloqué label off, as nothing there will', () => {
    const moved = ev('ticket.delegated', { issue: { title: 'T', logical: 'todo', priority: 0 }, waitedIn: 'web' });
    expect(decide(undefined, moved, workflow).effects).toContainEqual({ kind: 'labels', add: [], remove: ['Bloqué'] });
  });

  it('a cancel ends the wait: the ticket holds no repo, its label is read again at its next delegation', () => {
    const after = reduce(blocked, ev('status.changed', { from: 'todo', to: null, cancelled: true }))!;
    expect(after).toMatchObject({ blocked: false, delegated: false, awaitingRepo: null });
    expect(holds(after)).toBe(false);
  });

  it('answers a mention, a command, a reply or a stop with the same question, and starts nothing', () => {
    const mention = ev('session.mentioned', { linearSessionId: 's9', body: 'ça va ?', author: 'L', repos: ['web', 'api'], issue: { title: 'T', logical: 'todo', priority: 0 } });
    expect(decide(undefined, mention, workflow).effects).toEqual([{ kind: 'activity', type: 'response', body: expect.stringContaining('`repo:api`'), linearSessionId: 's9' }]);
    for (const e of [ev('session.prompted', { linearSessionId: 's1', body: 'vas-y', author: 'L' }), ev('session.stopped', { linearSessionId: 's1' })]) {
      expect(decide(blocked, e, workflow)).toEqual(decision({ effects: [{ kind: 'activity', type: 'response', body: blocked.blockReason!, linearSessionId: 's1' }] }));
    }
  });

  it('decides nothing else on a ticket waiting for its repo: no rule may start work in a repo picked by default', () => {
    for (const e of [ev('status.changed', { from: 'todo', to: 'dev' }), ev('label.changed', { label: 'agent:reprendre', change: 'added' })]) {
      const out = decide(blocked, e, workflow);
      expect(out).toEqual(decision());
      expect(out.trace).toContain(`${e.type}: repo to choose first`);
    }
  });

  it('a timer or a failed effect neither starts work nor replaces the wait: the ticket would then hold the repo picked by default', () => {
    const timer = ev('timer.fired', { kind: 'debounce', payload: { job: 'dev-feedback' } } as never);
    const failed = ev('effect.failed', { kind: 'activity', error: 'Linear down', eventId: 'linear:session:s1' } as never);
    for (const e of [timer, failed]) {
      const out = decide(blocked, e, workflow);
      expect(out.events).toEqual([]);
      expect(out.effects.map((f) => f.kind)).not.toContain('start_run');
    }
  });

  it('a delegation without a snapshot blocks nothing and asks nothing: no ticket comes out of it (ORC-302)', () => {
    const out = decide(undefined, ev('ticket.delegated', { linearSessionId: 's1', repos: ['web', 'api'] }), workflow);
    expect(out.events).toEqual([]);
    expect(out.effects.map((e) => e.kind)).not.toContain('activity');
  });

  it('leaves what is no human action to its usual handling: the end of a question run under way, a dead letter', () => {
    for (const e of [ev('run.finished', { runId: 'gone', job: 'ask', outcome: 'success', costUsd: 0, turns: 0, lastText: '' }), ev('dead_letter.added', { eventId: 'e', eventType: 'pr.opened', error: 'x', failures: 1 })]) {
      expect(decide(blocked, e, workflow).trace).not.toContain(`${e.type}: repo to choose first`);
    }
  });

  it('still asks the question from the field when another block replaced the reason', () => {
    const replaced = { ...blocked, blockReason: 'Erreur : Linear down' };
    const reply = decide(replaced, ev('session.prompted', { linearSessionId: 's1', body: 'vas-y', author: 'L' }), workflow);
    expect(reply.effects).toEqual([{ kind: 'activity', type: 'response', body: unroutedReason(['web', 'api']), linearSessionId: 's1' }]);
  });

  it('a ticket that never waited gets no trace of the field, so that old journals replay as they were', () => {
    const cancelled = reduce(ticket(), ev('status.changed', { from: 'dev', to: null, cancelled: true }))!;
    expect('awaitingRepo' in cancelled).toBe(false);
  });

  it('lifts that block once the ticket is no longer delegated here, the label kept when its repo blocks it too', () => {
    const lift = decide(blocked, ev('ticket.undelegated', {}), workflow);
    expect(kinds(lift)).toEqual({ events: ['ticket.unblocked', 'ticket.patched'], effects: ['labels'], timers: [] });
    expect(lift.events.reduce((t, e) => reduce(t, e), reduce(blocked, ev('ticket.undelegated', {})))).toMatchObject({ blocked: false, awaitingRepo: null });
    expect(kinds(decide(blocked, ev('ticket.undelegated', { keepLabel: true }), workflow))).toEqual({ events: ['ticket.unblocked', 'ticket.patched'], effects: [], timers: [] });
  });

  it('tells a human adding the label of another repo of the team that a ticket at work does not change repo, and what can', () => {
    const out = decide(ticket(), ev('label.changed', { label: 'Repo:Api', change: 'added', otherRepo: true }), workflow);
    expect(out.effects).toEqual([{ kind: 'comment', body: expect.stringContaining('reste sur le dépôt p') }]);
    expect(out.effects[0]).toMatchObject({ body: expect.stringContaining('nouveau ticket') });
    expect(out.effects[0]).toMatchObject({ body: expect.stringContaining('5 minutes') });
  });

  it('says nothing of a repo: label that names no other repo of the team', () => {
    expect(decide(ticket(), ev('label.changed', { label: 'repo:frontend', change: 'added' }), workflow).effects).toEqual([]);
  });
});
