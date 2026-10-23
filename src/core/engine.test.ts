import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import type { Decision } from './decision.js';
import { decide, SENSITIVE_PATHS, taintedKnowledge } from './engine.js';
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
        events: [{ type: 'feedback.appended', item: { author: 'Lilian', body: 'boutons mal alignés', at: 1000, source: 'session' } }],
        timers: [{ kind: 'debounce', job: 'dev-feedback', ms: 180_000 }],
      }),
    );
  });

  it('relaunches immediately when blocked', () => {
    const out = decide(ticket({ logical: 'dev', blocked: true, linearSessionId: 's1' }), ev('session.prompted', { linearSessionId: 's1', body: 'oui, vas-y', author: 'L' }), workflow);
    expect(kinds(out)).toEqual({ events: ['feedback.appended', 'ticket.unblocked'], effects: ['start_run'], timers: [] });
    expect(out.effects[0]).toMatchObject({ job: 'dev-feedback', input: 'feedback' });
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

  it('a human push is a typed event that the standard pack does not react to', () => {
    expect(decide(ticket({ logical: 'dev' }), ev('push.human', { branch: 'factory/rel-1', sha: 'abc123', author: 'lilian' }), workflow)).toEqual(decision());
  });

  it('merge moves to done, cleans up and learns', () => {
    const out = decide(ticket({ logical: 'ready' }), ev('pr.merged', { number: 3, url: 'u', branch: 'b' }), workflow);
    expect(kinds(out).effects).toEqual(['move', 'cleanup', 'start_run']);
    expect(out.effects[2]).toMatchObject({ job: 'learn' });
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
    expect(kinds(out).effects).toEqual(['move', 'cleanup', 'activity']);
    expect(out.effects[2]).toEqual({ kind: 'activity', type: 'response', body: taintedKnowledge('learn'), linearSessionId: undefined });
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

  it('debounce fired starts the job', () => {
    expect(decide(ticket({ logical: 'human_review' }), ev('debounce.fired', { job: 'dev-feedback' }), workflow)).toEqual(
      decision({ effects: [{ kind: 'start_run', job: 'dev-feedback', input: 'feedback' }] }),
    );
  });

  it('pr.opened records and links the PR', () => {
    expect(decide(ticket(), ev('pr.opened', { number: 7, url: 'https://gh/pr/7', branch: 'b' }), workflow)).toEqual(
      decision({
        events: [{ type: 'ticket.patched', patch: { prNumber: 7, prUrl: 'https://gh/pr/7' } }],
        effects: [{ kind: 'link_pr', url: 'https://gh/pr/7' }],
      }),
    );
  });

  it('pause and resume', () => {
    expect(decide(undefined, ev('control.pause', {}), workflow)).toEqual(decision({ effects: [{ kind: 'set_paused', paused: true }] }));
    expect(decide(undefined, ev('control.resume', {}), workflow)).toEqual(decision({ effects: [{ kind: 'set_paused', paused: false }] }));
  });
});
