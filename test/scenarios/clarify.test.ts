import { describe, expect, it } from 'vitest';
import { reconcileOnce } from '../../src/adapters/tracker/linear/reconcile.js';
import type { AgentOutput } from '../../src/core/agent-output.js';
import { causeOf } from '../../src/core/block-cause.js';
import { createHarness } from '../helpers/harness.js';

/** A repository that makes delegation start with `intake` (ORC-206). */
const INTAKE_FIRST = `version: 1
on:
  ticket.delegated:
    - { when: "state in [todo, dev] && !blocked", run: intake }
`;
const DESCRIPTION = 'Rate-limit the public API.\n\nAcceptance criteria:\n1. More than 100 requests a minute get a 429.';
const HOUR = 3_600_000;
const RATE = { question: 'Does the rate limit apply to admin accounts too?', options: ['Yes, to everyone', 'No, admins are exempt'] };
const WINDOW = { question: 'Per minute, sliding or fixed?', options: ['Sliding', 'Fixed'] };

const assessment = (patch: Partial<NonNullable<AgentOutput['intake']>> = {}) => ({
  output: {
    status: 'done', summary: 'Read.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [],
    intake: { size: 's', risk: 'low', complete: true, missing: [], screen: false, ...patch },
  } satisfies AgentOutput,
});
const DEV = { events: [{ kind: 'text' as const, text: 'Done.' }] };

function setup() {
  const h = createHarness({ projectYaml: INTAKE_FIRST, authz: { githubLogins: { 'user-lilian': 'lilian-gh' } } });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Rate limit', description: DESCRIPTION });
  h.tracker.setTeamMembers('REL', ['user-lilian', 'user-armand']);
  h.forge.setRepoPermission('lilian-gh', 'write');
  return h;
}
/** The ticket delegated by Lilian, intake finding it unclear: two questions asked. */
async function asked(h: ReturnType<typeof setup>) {
  h.runner.enqueue(assessment({ complete: false, missing: [RATE, WINDOW] }));
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: 'user-lilian' });
}
const answer = (h: ReturnType<typeof setup>, body: string, actor: string) =>
  h.send('session.prompted', { linearSessionId: 'ls-1', body, author: actor, ack: true, kind: 'instruction' }, 'REL-1', { actor });
const elicitations = (h: ReturnType<typeof setup>) => h.tracker.activities('ls-1').filter((a) => a.type === 'elicitation');

describe('clarify, end to end (ORC-210)', () => {
  it('asks the questions with select, reminds at 24 h, blocks at 72 h, never moving the ticket to In Progress', async () => {
    const h = setup();
    await asked(h);
    expect(h.runner.requests).toHaveLength(1);
    expect(elicitations(h)).toEqual([expect.objectContaining({ body: expect.stringContaining(RATE.question), options: RATE.options })]);
    expect(await h.ticket()).toMatchObject({ blocked: false, logical: 'todo' });

    await h.advance(23 * HOUR);
    expect(elicitations(h)).toHaveLength(1);
    await h.advance(HOUR);
    expect(elicitations(h)).toHaveLength(2);
    expect(elicitations(h)[1]).toMatchObject({ body: expect.stringMatching(/^Reminder/), options: RATE.options });
    expect((await h.ticket()).blocked).toBe(false);

    await h.advance(47 * HOUR);
    expect((await h.ticket()).blocked).toBe(false);
    await h.advance(HOUR);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: true, blockedJob: 'intake' });
    expect(t.blockKind).toBe('question');
    expect(causeOf(t.blockKind)).toBe('question');
    expect(h.tracker.comments('REL-1').at(-1)).toContain(RATE.question);
    expect(h.tracker.calls.filter((c) => c.method === 'moveTo')).toEqual([]);
    expect(h.runner.requests).toHaveLength(1);
  });

  it('refuses an answer from outside the team, takes the requester\'s, then intake reads them and dev gets the decisions; the timers find nothing left to do', async () => {
    const h = setup();
    await asked(h);
    await answer(h, 'No, admins are exempt', 'user-stranger');
    expect(h.tracker.activities('ls-1').at(-1)).toMatchObject({ type: 'response', body: expect.stringMatching(/^Refused: answering the agent/) });
    const refusal = (await h.store.recentEvents(20, 'REL-1')).find((e) => e.actor === 'user-stranger');
    expect(refusal).toMatchObject({ type: 'session.prompted', roles: [] });
    expect((await h.ticket()).clarify).toMatchObject({ answered: 0 });

    h.runner.enqueue(assessment(), DEV);
    await answer(h, 'Yes, to everyone', 'user-lilian');
    expect(h.runner.requests).toHaveLength(1);
    expect(elicitations(h).at(-1)).toMatchObject({ body: expect.stringContaining(WINDOW.question), options: WINDOW.options });
    await answer(h, 'Sliding', 'user-armand');
    expect(h.runner.requests.map((r) => r.prompt.split('\n')[0])).toEqual(['/factory:intake', '/factory:intake', '/factory:dev']);
    expect(h.runner.requests[1]!.prompt).toContain('Yes, to everyone');
    expect(h.runner.requests[1]!.prompt).not.toContain('No, admins are exempt');
    // Intake reads the answers as its feedback, once: the decisions are for the steps after the guard.
    expect(h.runner.requests[1]!.prompt).not.toContain('## Decisions');
    // The decisions go to the steps that write the tests and the code.
    expect(h.runner.requests[2]!.prompt).toMatch(/## Decisions[\s\S]*Does the rate limit apply to admin accounts too\?[\s\S]*Yes, to everyone/);
    expect((await h.ticket()).decisions).toHaveLength(2);

    const shown = elicitations(h).length;
    await h.advance(73 * HOUR);
    expect(elicitations(h)).toHaveLength(shown);
    expect((await h.ticket()).blocked).toBe(false);
  });
});

describe('clarify and the wait on a « blocked by » ticket (ORC-210, ORC-363)', () => {
  it('an incomplete ticket with an open blocker is asked its questions first, then waits for the blocker, then starts once it is Done', async () => {
    const h = createHarness({ projectYaml: INTAKE_FIRST, authz: { githubLogins: { 'user-lilian': 'lilian-gh' } } });
    h.tracker.addIssue({ identifier: 'REL-2', title: 'API gateway', stateName: 'In Progress', stateType: 'started' });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Rate limit', description: DESCRIPTION, delegateId: 'app' });
    h.tracker.blocks('REL-2', 'REL-1');
    h.tracker.setTeamMembers('REL', ['user-lilian', 'user-armand']);
    h.forge.setRepoPermission('lilian-gh', 'write');
    const reconcile = async () => {
      await reconcileOnce({ tracker: h.tracker, store: h.store, projects: [h.project], submit: (e) => h.orch.accept(e), clock: h.clock, log: () => {} });
      await h.orch.drained();
    };
    const skills = () => h.runner.requests.map((r) => r.prompt.split('\n')[0]);
    const moves = () => h.tracker.calls.filter((c) => c.method === 'moveTo' && c.args[0] === 'REL-1').map((c) => c.args[1]);
    const waits = () => h.tracker.activities('ls-1').filter((a) => a.type === 'thought' && a.body.includes('REL-2'));

    // The questions first: the human has something to answer, the blocker is not mentioned yet.
    await asked(h);
    expect(skills()).toEqual(['/factory:intake']);
    expect(elicitations(h)).toEqual([expect.objectContaining({ body: expect.stringContaining(RATE.question), options: RATE.options })]);
    const asking = await h.ticket();
    expect(asking).toMatchObject({ blocked: false, logical: 'todo', clarify: { job: 'intake', answered: 0 } });
    expect(asking.waitingOn ?? undefined).toBeUndefined();
    expect(waits()).toEqual([]);

    // Answered, intake reads the ticket again, finds it complete: the blocker is still open, so dev waits for it.
    h.runner.enqueue(assessment());
    await answer(h, 'Yes, to everyone', 'user-lilian');
    await answer(h, 'Sliding', 'user-armand');
    expect(skills()).toEqual(['/factory:intake', '/factory:intake']);
    const waiting = await h.ticket();
    expect(waiting).toMatchObject({ blocked: false, logical: 'todo', waitingOn: { blockers: ['REL-2'], start: { job: 'dev' } } });
    expect(waiting.clarify ?? undefined).toBeUndefined();
    expect(waiting.decisions).toHaveLength(2);
    expect(waits()).toEqual([{ type: 'thought', body: expect.stringContaining('In Progress') }]);
    expect(moves()).toEqual([]);
    await reconcile();
    expect(skills()).toEqual(['/factory:intake', '/factory:intake']);

    // The blocker Done: the reconciliation resumes, dev starts with the decisions and moves the ticket to In Progress.
    Object.assign(h.tracker.issues.get('REL-2')!, { stateName: 'Done', stateType: 'completed' });
    h.runner.enqueue(DEV);
    await reconcile();
    expect(skills()).toEqual(['/factory:intake', '/factory:intake', '/factory:dev']);
    expect(h.runner.requests[2]!.prompt).toMatch(/## Decisions[\s\S]*Yes, to everyone/);
    expect(moves()[0]).toBe('In Progress');
    expect((await h.ticket()).waitingOn ?? undefined).toBeUndefined();

    // The clarify timers of the answered round find nothing to do.
    const shown = elicitations(h).length;
    await h.advance(73 * HOUR);
    expect(elicitations(h)).toHaveLength(shown);
    expect((await h.ticket()).blocked).toBe(false);
  });
});
