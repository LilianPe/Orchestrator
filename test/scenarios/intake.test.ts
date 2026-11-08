import { describe, expect, it } from 'vitest';
import type { AgentOutput } from '../../src/core/agent-output.js';
import { causeOf } from '../../src/core/block-cause.js';
import { createHarness } from '../helpers/harness.js';

/** A repository that makes delegation start with `intake` (ORC-206), as the pack's own comment says. */
const INTAKE_FIRST = `version: 1
on:
  ticket.delegated:
    - { when: "state in [todo, dev] && !blocked", run: intake }
`;
const DESCRIPTION = 'Export the audits as CSV from the audit list.\n\nAcceptance criteria:\n1. A CSV button downloads the list.';

/** What intake submits: a complete ticket of size `s`, low risk, no screen, unless `patch` says otherwise. */
const assessment = (patch: Partial<NonNullable<AgentOutput['intake']>> = {}) => ({
  output: {
    status: 'done', summary: 'Read.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [],
    intake: { size: 's', risk: 'low', complete: true, missing: [], screen: false, ...patch },
  } satisfies AgentOutput,
});
const DEV = { events: [{ kind: 'text' as const, text: 'Done.' }] };
const skills = (h: ReturnType<typeof createHarness>) => h.runner.requests.map((r) => r.prompt.split('\n')[0]);

describe('intake, the first step (ORC-206)', () => {
  it('records size and risk, plans the visual proof, then starts dev: only dev moves the ticket to In Progress', async () => {
    const h = createHarness({ projectYaml: INTAKE_FIRST });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: DESCRIPTION });
    h.runner.enqueue(assessment({ risk: 'medium', screen: true }), DEV);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(skills(h)).toEqual(['/factory:intake', '/factory:dev']);
    expect(h.runner.requests[0]!.effort).toBe('low');
    const t = await h.ticket();
    expect(t).toMatchObject({ size: 's', risk: 'medium', visualProof: 'required', blocked: false });
    const moves = h.tracker.calls.filter((c) => c.method === 'moveTo').map((c) => c.args[1]);
    expect(moves[0]).toBe('In Progress');
    // The dev attempt carries the risk intake assessed (ORC-226 labels).
    const dev = await h.store.getRun(h.runner.requests[1]!.runId);
    expect(dev?.labels?.risk).toBe('medium');
  });

  it('an incomplete ticket goes to clarify instead of starting: blocked with its questions, never moved to In Progress', async () => {
    const h = createHarness({ projectYaml: INTAKE_FIRST });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export', description: DESCRIPTION });
    h.runner.enqueue(assessment({ complete: false, missing: ['CSV or XLSX?'] }));
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.runner.requests).toHaveLength(1);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: true, blockedJob: 'intake', logical: 'todo', size: 's', risk: 'low' });
    expect(causeOf(t.blockKind)).toBe('pickup');
    expect(h.tracker.calls.filter((c) => c.method === 'moveTo')).toEqual([]);
    expect(h.tracker.comments('REL-1').at(-1)).toContain('CSV or XLSX?');

    // The answer relaunches intake, which reads the ticket again; complete now, dev starts.
    h.runner.enqueue(assessment(), DEV);
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'CSV', author: 'Lilian', ack: true, kind: 'instruction' });
    expect(skills(h)).toEqual(['/factory:intake', '/factory:intake', '/factory:dev']);
    expect(h.runner.requests[1]!.prompt).toContain('CSV');
  });

  it('the deterministic checks no longer block directly: they are inputs of the guard, which blocks after intake', async () => {
    const h = createHarness({ projectYaml: INTAKE_FIRST });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Flou', description: 'trop court' });
    h.runner.enqueue(assessment({ size: 'xs' }));
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(skills(h)).toEqual(['/factory:intake']);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: true, blockedJob: 'intake', size: 'xs' });
    expect(t.blockReason).toContain('The description is shorter than 30 characters.');
  });

  it('the checks hold before the first run only: a ticket delegated again after its dev run is not refused for its own branch', async () => {
    const h = createHarness({ projectYaml: INTAKE_FIRST });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: DESCRIPTION });
    h.runner.enqueue(assessment(), DEV);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    // The dev run published its branch; the ticket goes back to In Progress and is delegated again.
    h.workspaces.remoteBranches.add('factory/rel-1-export-csv');
    await h.send('status.changed', { from: 'human_review', to: 'dev' });
    await h.orch.drained();
    const before = h.runner.requests.length;
    h.runner.enqueue(assessment(), DEV);
    await h.send('ticket.delegated', { linearSessionId: 'ls-2' });
    expect((await h.ticket()).blocked).toBe(false);
    expect(skills(h)[before]).toBe('/factory:intake');
  });
});
