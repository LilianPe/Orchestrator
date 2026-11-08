import { describe, expect, it } from 'vitest';
import { reconcileOnce } from '../../src/adapters/tracker/linear/reconcile.js';
import type { AgentOutput } from '../../src/core/agent-output.js';
import { createHarness } from '../helpers/harness.js';

/** A repository that makes delegation start with `intake` (ORC-206). */
const INTAKE_FIRST = `version: 1
on:
  ticket.delegated:
    - { when: "state in [todo, dev] && !blocked", run: intake }
`;
const DESCRIPTION = 'Export the audits as CSV from the audit list.\n\nAcceptance criteria:\n1. A CSV button downloads the list.';
const DEV = { events: [{ kind: 'text' as const, text: 'Done.' }] };
const ASSESSED = {
  output: {
    status: 'done', summary: 'Read.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [],
    intake: { size: 's', risk: 'low', complete: true, missing: [], screen: false },
  } satisfies AgentOutput,
};

/** REL-1, delegated to the app, « blocked by » REL-2 in `blocker`'s state. */
function setup(blocker: { stateName: string; stateType: string }, projectYaml?: string, ticket: { stateName?: string; stateType?: string } = {}) {
  const h = createHarness(projectYaml ? { projectYaml } : {});
  h.tracker.addIssue({ identifier: 'REL-2', title: 'Audit list', ...blocker });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: DESCRIPTION, delegateId: 'app', ...ticket });
  h.tracker.blocks('REL-2', 'REL-1');
  const reconcile = async () => {
    await reconcileOnce({ tracker: h.tracker, store: h.store, projects: [h.project], submit: (e) => h.orch.accept(e), clock: h.clock, log: () => {} });
    await h.orch.drained();
  };
  const done = () => Object.assign(h.tracker.issues.get('REL-2')!, { stateName: 'Done', stateType: 'completed' });
  const skills = () => h.runner.requests.map((r) => r.prompt.split('\n')[0]);
  const moves = () => h.tracker.calls.filter((c) => c.method === 'moveTo' && c.args[0] === 'REL-1').map((c) => c.args[1]);
  return { h, reconcile, done, skills, moves };
}

describe('a ticket « blocked by » a Linear ticket that is not done waits (ORC-363)', () => {
  it('intake off (the pack): nothing starts, the session says what it waits for, and nothing is asked of the human', async () => {
    const { h, skills, moves } = setup({ stateName: 'In Progress', stateType: 'started' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(skills()).toEqual([]);
    expect(moves()).toEqual([]);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: false, delegated: true, logical: 'todo', waitingOn: { blockers: ['REL-2'], start: { job: 'dev' } } });
    const said = h.tracker.activities('ls-1').filter((a) => 'body' in a && a.body.includes('REL-2'));
    expect(said).toEqual([{ type: 'thought', body: expect.stringContaining('In Progress') }]);
    // A wait is no block: no elicitation, no blocking comment, no Bloqué label.
    expect(h.tracker.activities('ls-1').some((a) => a.type === 'elicitation')).toBe(false);
    expect(h.tracker.issues.get('REL-1')!.labels).toEqual([]);
  });

  it('resumes on its own once the reconciliation sees the blocker Done: dev starts and moves the ticket to In Progress', async () => {
    const { h, reconcile, done, skills, moves } = setup({ stateName: 'In Progress', stateType: 'started' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    // Still not done: a pass changes nothing.
    await reconcile();
    expect(skills()).toEqual([]);
    done();
    h.runner.enqueue(DEV);
    await reconcile();
    expect(skills()).toEqual(['/factory:dev']);
    expect(moves()[0]).toBe('In Progress');
    expect((await h.ticket()).waitingOn ?? undefined).toBeUndefined();
    // A later pass starts nothing again.
    await reconcile();
    expect(skills()).toEqual(['/factory:dev']);
  });

  it('a blocker already done: the ticket starts normally', async () => {
    const { h, skills, moves } = setup({ stateName: 'Done', stateType: 'completed' });
    h.runner.enqueue(DEV);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(skills()).toEqual(['/factory:dev']);
    expect(moves()[0]).toBe('In Progress');
    expect((await h.ticket()).waitingOn ?? undefined).toBeUndefined();
  });

  it('intake on: the blocker is an input of the guard after intake; dev starts once it is Done', async () => {
    const { h, reconcile, done, skills, moves } = setup({ stateName: 'Todo', stateType: 'unstarted' }, INTAKE_FIRST);
    h.runner.enqueue(ASSESSED);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(skills()).toEqual(['/factory:intake']);
    expect(moves()).toEqual([]);
    expect(await h.ticket()).toMatchObject({ blocked: false, size: 's', waitingOn: { blockers: ['REL-2'], start: { job: 'dev' } } });
    expect(h.tracker.activities('ls-1')).toContainEqual({ type: 'thought', body: expect.stringContaining('REL-2') });
    done();
    h.runner.enqueue(DEV);
    await reconcile();
    expect(skills()).toEqual(['/factory:intake', '/factory:dev']);
    expect(moves()[0]).toBe('In Progress');
  });

  it('a reply while it waits starts nothing, even In Progress where a reply starts dev-feedback: the message is kept', async () => {
    const { h, reconcile, done, skills } = setup({ stateName: 'In Progress', stateType: 'started' }, undefined, { stateName: 'In Progress', stateType: 'started' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(await h.ticket()).toMatchObject({ logical: 'dev', waitingOn: { blockers: ['REL-2'] } });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'Use a semicolon separator', author: 'Lilian', ack: true, kind: 'instruction' });
    await h.advance(10 * 60_000);
    expect(skills()).toEqual([]);
    expect((await h.ticket()).humanInbox.map((m) => m.body)).toEqual(['Use a semicolon separator']);
    done();
    h.runner.enqueue(DEV);
    await reconcile();
    expect(skills()).toEqual(['/factory:dev']);
  });
});
