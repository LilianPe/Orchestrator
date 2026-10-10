import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import { decide } from './engine.js';
import { newTicketState, type EventPayloads, type EventType, type RelaisEvent, type TicketState } from './types.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });
const ctx = { workflow };

function ev<T extends EventType>(type: T, payload: EventPayloads[T]): RelaisEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', payload } as RelaisEvent;
}
function ticket(patch: Partial<TicketState> = {}): TicketState {
  return { ...newTicketState('p', 'REL-1', 'Titre', 'todo', 0), ...patch };
}

describe('decide — YAML rules of the standard pack', () => {
  it('starts dev on delegation of a todo ticket', () => {
    expect(decide(ev('ticket.delegated', {}), ticket(), ctx)).toEqual([{ kind: 'start_run', job: 'dev', input: undefined, inputText: undefined, linearSessionId: undefined }]);
  });

  it('ignores delegation of a blocked ticket', () => {
    expect(decide(ev('ticket.delegated', {}), ticket({ blocked: true }), ctx)).toEqual([]);
  });

  it('debounces a reply in human review and records the feedback', () => {
    const out = decide(ev('session.prompted', { linearSessionId: 's1', body: 'boutons mal alignés', author: 'Lilian' }), ticket({ logical: 'human_review', linearSessionId: 's1' }), ctx);
    expect(out).toEqual([
      { kind: 'append_feedback', item: { author: 'Lilian', body: 'boutons mal alignés', at: 1000, source: 'session' } },
      { kind: 'set_debounce', job: 'dev-feedback', ms: 180_000 },
    ]);
  });

  it('relaunches immediately when blocked', () => {
    const out = decide(ev('session.prompted', { linearSessionId: 's1', body: 'oui, vas-y', author: 'L' }), ticket({ logical: 'dev', blocked: true, linearSessionId: 's1' }), ctx);
    expect(out.map((c) => c.kind)).toEqual(['append_feedback', 'unblock', 'start_run']);
    expect(out[2]).toMatchObject({ job: 'dev-feedback', input: 'feedback' });
  });

  it('routes a reply in a foreign session to ask', () => {
    const out = decide(ev('session.prompted', { linearSessionId: 's9', body: 'et pour mobile ?', author: 'L' }), ticket({ linearSessionId: 's1' }), ctx);
    expect(out).toEqual([{ kind: 'start_run', job: 'ask', input: 'thread', inputText: 'et pour mobile ?', linearSessionId: 's9' }]);
  });

  it('moves human_review -> dev runs dev-feedback', () => {
    const out = decide(ev('ticket.moved', { from: 'human_review', to: 'dev' }), ticket({ logical: 'dev' }), ctx);
    expect(out).toEqual([{ kind: 'start_run', job: 'dev-feedback', input: 'feedback', inputText: undefined, linearSessionId: undefined }]);
  });

  it('moving to ai_review runs review', () => {
    const out = decide(ev('ticket.moved', { from: 'human_review', to: 'ai_review' }), ticket({ logical: 'ai_review' }), ctx);
    expect(out[0]).toMatchObject({ kind: 'start_run', job: 'review' });
  });

  it('a mention runs ask with the body in its own session', () => {
    const out = decide(ev('session.mentioned', { linearSessionId: 's2', body: 'tu penses quoi ?', author: 'L' }), ticket(), ctx);
    expect(out).toEqual([{ kind: 'start_run', job: 'ask', input: 'thread', inputText: 'tu penses quoi ?', linearSessionId: 's2' }]);
  });

  it('the retiens command runs remember', () => {
    const out = decide(ev('command', { name: 'retiens', body: 'agrégats côté serveur', linearSessionId: 's3', author: 'L' }), ticket(), ctx);
    expect(out).toEqual([{ kind: 'start_run', job: 'remember', input: 'thread', inputText: 'agrégats côté serveur', linearSessionId: 's3' }]);
  });

  it('the agent:stop label stops', () => {
    const out = decide(ev('label.added', { label: 'agent:stop' }), ticket({ logical: 'dev' }), ctx);
    expect(out.map((c) => c.kind)).toEqual(['stop_run', 'block', 'activity']);
  });

  it('merge moves to done, cleans up and learns', () => {
    const out = decide(ev('pr.merged', { number: 3, url: 'u', branch: 'b' }), ticket({ logical: 'ready' }), ctx);
    expect(out.map((c) => c.kind)).toEqual(['move', 'cleanup', 'start_run']);
    expect(out[2]).toMatchObject({ job: 'learn' });
  });
});

describe('decide — built-ins', () => {
  it('run success without verify applies on_success', () => {
    const out = decide(ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 1, turns: 3, lastText: 'ok' }), ticket({ logical: 'dev' }), ctx);
    expect(out).toEqual([
      { kind: 'move', to: 'human_review' },
      { kind: 'post_output', style: 'summary', runId: 'r1' },
    ]);
  });

  it('run success on a ticket blocked by an agent question waits for the answer', () => {
    const out = decide(ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 1, turns: 3, lastText: '?' }), ticket({ blocked: true }), ctx);
    expect(out).toEqual([]);
  });

  it('run success with verify asks for verification', () => {
    const wf = { ...workflow, jobs: { ...workflow.jobs, dev: { ...workflow.jobs['dev']!, verify: ['npm test'] } } };
    const out = decide(ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 1, turns: 3, lastText: 'ok' }), ticket(), { workflow: wf });
    expect(out).toEqual([{ kind: 'run_verify', runId: 'r1', job: 'dev' }]);
  });

  it('a failed question run reports an error without blocking', () => {
    const out = decide(ev('run.finished', { runId: 'r9', job: 'ask', outcome: 'failure', costUsd: 0, turns: 1, lastText: '' }), ticket(), ctx);
    expect(out).toEqual([{ kind: 'activity', type: 'error', body: "Je n'ai pas pu terminer (échec ou plafond atteint).", runId: 'r9' }]);
  });

  it('run limit blocks and asks', () => {
    const out = decide(ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'limit', costUsd: 5, turns: 150, lastText: '' }), ticket(), ctx);
    expect(out.map((c) => c.kind)).toEqual(['block', 'activity']);
    expect(out[1]).toMatchObject({ type: 'elicitation' });
  });

  it('verify failure resumes until the cap, then blocks', () => {
    const failures = [{ command: 'npm test', exitCode: 1, output: 'boom' }];
    const first = decide(ev('verify.failed', { runId: 'r1', job: 'dev', failures }), ticket({ verifyAttempts: 0 }), ctx);
    expect(first[0]).toEqual({ kind: 'patch_ticket', patch: { verifyAttempts: 1 } });
    expect(first[1]).toMatchObject({ kind: 'start_run', job: 'dev', input: 'verify_failures', resume: true });
    const last = decide(ev('verify.failed', { runId: 'r2', job: 'dev', failures }), ticket({ verifyAttempts: 1 }), ctx);
    expect(last.map((c) => c.kind)).toEqual(['block', 'activity']);
  });

  it('debounce fired starts the job', () => {
    expect(decide(ev('debounce.fired', { job: 'dev-feedback' }), ticket({ logical: 'human_review' }), ctx)).toEqual([
      { kind: 'start_run', job: 'dev-feedback', input: 'feedback' },
    ]);
  });

  it('pr.opened records and links the PR', () => {
    expect(decide(ev('pr.opened', { number: 7, url: 'https://gh/pr/7', branch: 'b' }), ticket(), ctx)).toEqual([
      { kind: 'patch_ticket', patch: { prNumber: 7, prUrl: 'https://gh/pr/7' } },
      { kind: 'link_pr', url: 'https://gh/pr/7' },
    ]);
  });

  it('pause and resume', () => {
    expect(decide(ev('control.pause', {}), undefined, ctx)).toEqual([{ kind: 'set_paused', paused: true }]);
    expect(decide(ev('control.resume', {}), undefined, ctx)).toEqual([{ kind: 'set_paused', paused: false }]);
  });
});
