import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import type { Decision } from './decision.js';
import { decide, isFenced, SENSITIVE_PATHS, sensitivePathsAtLaunch, taintedKnowledge } from './engine.js';
import { reduce } from './reduce.js';
import { newTicketState, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });

function ev<T extends EventType>(type: T, payload: EventPayloads[T]): FactoryEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: 2, taint: 'trusted', payload } as FactoryEvent;
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
        timers: [{ kind: 'debounce', job: 'dev-feedback', ms: 180_000 }],
      }),
    );
  });

  it('relaunches immediately when blocked', () => {
    const out = decide(ticket({ logical: 'dev', blocked: true, linearSessionId: 's1' }), ev('session.prompted', { linearSessionId: 's1', body: 'oui, vas-y', author: 'L' }), workflow);
    expect(kinds(out)).toEqual({ events: ['feedback.appended', 'ticket.unblocked'], effects: ['start_run'], timers: [] });
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
    const out = decide(ticket({ logical: 'dev' }), ev('status.changed', { from: 'human_review', to: 'dev' }), workflow);
    expect(out).toEqual(decision({ effects: [{ kind: 'start_run', job: 'dev-feedback', input: 'feedback', inputText: undefined, linearSessionId: undefined }] }));
  });

  it('moving to ai_review runs review', () => {
    const out = decide(ticket({ logical: 'ai_review' }), ev('status.changed', { from: 'human_review', to: 'ai_review' }), workflow);
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
    expect(kinds(out)).toEqual({ events: ['work.cancelled', 'ticket.blocked'], effects: ['stop_run', 'activity'], timers: [] });
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
    expect(decide(merged(), ev('debounce.fired', { job: 'dev-feedback' }), workflow)).toEqual(decision());
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
    expect(decide(t, ev('debounce.fired', { job: 'dev-feedback' }), workflow).effects).toEqual([
      { kind: 'start_run', job: 'dev-feedback', input: 'feedback', sensitivePaths: SENSITIVE_PATHS },
    ]);
  });

  it('applies the taint of the pending feedback to a run started by a trusted rule that consumes it (ORC-269)', () => {
    const t = ticket({ logical: 'dev', pendingFeedback: pending('untrusted') });
    expect(decide(t, ev('label.changed', { label: 'agent:reprendre', change: 'added' }), workflow).effects[0]).toMatchObject({ job: 'dev-feedback', sensitivePaths: SENSITIVE_PATHS });
    expect(decide(t, ev('status.changed', { from: 'human_review', to: 'dev' }), workflow).effects[0]).toMatchObject({ job: 'dev-feedback', sensitivePaths: SENSITIVE_PATHS });
  });

  it('reads a pending item written before ORC-269, without taint, as trusted, as upcast reads a version 1 event', () => {
    const t = ticket({ logical: 'human_review', pendingFeedback: pending() });
    expect(decide(t, ev('debounce.fired', { job: 'dev-feedback' }), workflow).effects[0]).not.toHaveProperty('sensitivePaths');
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
    const out = decide(ticket({ blocked: true, pendingFeedback: pending('untrusted') }), ev('debounce.fired', { job: 'remember' }), wf);
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
    const out = decide(ticket({ logical: 'dev', activeRunId: 'r1' }), ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 1, turns: 3, lastText: 'ok' }), workflow);
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
    expect(kinds(out)).toEqual({ events: ['ticket.blocked'], effects: ['activity'], timers: [] });
    expect(out.effects[0]).toMatchObject({ type: 'elicitation' });
  });

  it('verify failure resumes until the cap, then blocks', () => {
    const failures = [{ command: 'npm test', exitCode: 1, output: 'boom' }];
    const first = decide(ticket({ verifyAttempts: 0, verifyingRunId: 'r1' }), ev('verify.failed', { runId: 'r1', job: 'dev', failures }), workflow);
    expect(first.events).toEqual([{ type: 'ticket.patched', patch: { verifyAttempts: 1 } }]);
    expect(first.effects[0]).toMatchObject({ kind: 'start_run', job: 'dev', input: 'verify_failures', resume: true });
    const last = decide(ticket({ verifyAttempts: 1, verifyingRunId: 'r2' }), ev('verify.failed', { runId: 'r2', job: 'dev', failures }), workflow);
    expect(kinds(last)).toEqual({ events: ['ticket.blocked'], effects: ['activity'], timers: [] });
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
          effects: [{ kind: 'activity', type: 'elicitation', body: `${reason}\n- \`test\`\n- \`lint\`\nRépondez dans ce fil pour relancer.` }],
        }),
      );
      // Blocked, the ticket gets no fix-ci from a later red CI either, and no second notice.
      const after = reduce(reduce(inReview({ ciFixAttempts: 2 }), red), out.events[0]!);
      expect(decide(after, red, workflow)).toEqual(decision());
    });

    it('ci_fix_attempts: 0 blocks at the first red CI', () => {
      const wf = { ...workflow, limits: { ...workflow.limits, ciFixAttempts: 0 } };
      expect(kinds(decide(inReview(), red, wf))).toEqual({ events: ['ticket.blocked'], effects: ['activity'], timers: [] });
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
      const timer = decide(blocked, ev('debounce.fired', { job: 'dev-feedback' }), workflow);
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
    expect(decide(ticket({ logical: 'human_review' }), ev('debounce.fired', { job: 'dev-feedback' }), workflow)).toEqual(
      decision({ effects: [{ kind: 'start_run', job: 'dev-feedback', input: 'feedback' }] }),
    );
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
        effects: [{ kind: 'activity', type: 'error', body: 'Erreur : Linear down' }],
      }),
    );
    // The notice of a dead effect dies too: blocked, no new notice (no loop while the tracker is down).
    expect(decide(ticket(), ev('effect.failed', { ...result, kind: 'activity', eventId: 'effect:REL-1:1:2', error: 'Linear down' }), workflow)).toEqual(
      decision({ events: [{ type: 'ticket.blocked', reason: 'Erreur : Linear down' }] }),
    );
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

describe('decide — dead letters (ORC-175)', () => {
  const added = { eventId: 'l1', eventType: 'label.changed', error: 'boom', failures: 1 };
  const reason = 'Événement l1 mis de côté (label.changed) : sa décision a échoué (boom).';
  const delegation = { ...ev('ticket.delegated', {}), id: 'l1' };

  it('blocks the ticket of a dead-lettered event and says which event, once', () => {
    expect(decide(ticket(), ev('dead_letter.added', added), workflow)).toEqual(
      decision({
        events: [{ type: 'ticket.blocked', reason }],
        effects: [{ kind: 'activity', type: 'error', body: `${reason} Un mainteneur peut le réparer : \`factory run repair REL-1\`.` }],
      }),
    );
    // An unknown ticket, a delivered or a stopped one: nothing to block.
    expect(decide(undefined, ev('dead_letter.added', added), workflow)).toEqual(decision());
    expect(decide(ticket({ logical: 'done' }), ev('dead_letter.added', added), workflow)).toEqual(decision());
    expect(decide(ticket({ blocked: true, blockReason: 'Arrêté à la demande' }), ev('dead_letter.added', added), workflow)).toEqual(decision());
  });

  it('a repair lifts the block of its event only, and says so', () => {
    const notice = { kind: 'activity' as const, type: 'response' as const, body: 'Événement l1 réparé par ops (ignoré) : le ticket est débloqué.' };
    const skip = ev('dead_letter.repaired', { eventId: 'l1', action: 'skip', by: 'ops' });
    expect(decide(ticket({ blocked: true, blockReason: reason }), skip, workflow)).toEqual(decision({ effects: [notice] }));
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
    expect(kinds(decide(blocked, replay, workflow)).effects).toEqual(['start_run', 'activity']);
    expect(reduce(blocked, replay)).toMatchObject({ delegated: true, blocked: false });
    const force = ev('dead_letter.repaired', { eventId: 'l1', action: 'force', by: 'ops', event: delegation });
    expect(kinds(decide(blocked, force, workflow)).effects).toEqual(['activity']);
    expect(reduce(blocked, force)).toMatchObject({ delegated: true, blocked: false });
  });

  it('a replayed result of an inactive attempt is still fenced', () => {
    const stale = { ...ev('run.finished', { runId: 'old', job: 'dev', outcome: 'success', costUsd: 0, turns: 1, lastText: '' }), id: 'l1' };
    const out = decide(ticket({ activeRunId: 'new' }), ev('dead_letter.repaired', { eventId: 'l1', action: 'replay', by: 'ops', event: stale }), workflow);
    expect(out.effects).toEqual([]);
    expect(isFenced(out)).toBe(true);
  });
});
