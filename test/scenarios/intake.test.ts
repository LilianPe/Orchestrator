import { describe, expect, it } from 'vitest';
import type { AgentOutput } from '../../src/core/agent-output.js';
import { WRITE_TOOLS } from '../../src/presets/tools.js';
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

  it('runs on a clone of its own with the read and search tools only: a write or a command is refused by the run, not the skill (ORC-367)', async () => {
    const h = createHarness({ projectYaml: INTAKE_FIRST });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: DESCRIPTION });
    h.runner.enqueue(assessment(), DEV);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const [intake, dev] = h.runner.requests;
    // No write tool and no shell: `claude --tools Read,Grep,Glob`, as the AI review's lenses. No plan mode either, which could refuse `submit_result`.
    expect(intake).toMatchObject({ tools: ['Read', 'Grep', 'Glob'], readOnly: false });
    expect(intake!.cwd).toBe(`/tmp/factory-fake/${h.project.id}/_trunk/${intake!.runId}`);
    expect(h.workspaces.prepared[0]).toMatchObject({ kind: 'trunk-readonly', runId: intake!.runId });
    expect(h.workspaces.released).toContain(intake!.cwd);
    // dev, which writes, has the write tools, in the ticket's worktree (ORC-383).
    expect(dev!.tools).toEqual(WRITE_TOOLS);
    expect(dev!.cwd).toBe(`/tmp/factory-fake/${h.project.id}/REL-1`);
  });

  it('an incomplete ticket leaves no worktree behind: intake never made one (ORC-367)', async () => {
    const h = createHarness({ projectYaml: INTAKE_FIRST });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export', description: DESCRIPTION });
    h.runner.enqueue(assessment({ complete: false, missing: ['CSV or XLSX?'] }));
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect((await h.ticket()).clarify).toMatchObject({ job: 'intake' });
    expect(h.workspaces.prepared.map((r) => r.kind)).toEqual(['trunk-readonly']);
    expect(h.workspaces.released).toEqual([h.runner.requests[0]!.cwd]);
    expect((await h.ticket()).worktreePath).toBeUndefined();
  });

  it('an incomplete ticket goes to clarify instead of starting: asked its questions, never moved to In Progress', async () => {
    const h = createHarness({ projectYaml: INTAKE_FIRST });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export', description: DESCRIPTION });
    h.runner.enqueue(assessment({ complete: false, missing: ['CSV or XLSX?'] }));
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.runner.requests).toHaveLength(1);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: false, logical: 'todo', size: 's', risk: 'low', clarify: { job: 'intake' } });
    expect(h.tracker.calls.filter((c) => c.method === 'moveTo')).toEqual([]);
    expect(h.tracker.activities('ls-1').at(-1)).toMatchObject({ type: 'elicitation', body: expect.stringContaining('CSV or XLSX?') });

    // The answer relaunches intake, which reads the ticket again; complete now, dev starts.
    h.runner.enqueue(assessment(), DEV);
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'CSV', author: 'Lilian', ack: true, kind: 'instruction' });
    expect(skills(h)).toEqual(['/factory:intake', '/factory:intake', '/factory:dev']);
    expect(h.runner.requests[1]!.prompt).toContain('CSV');
  });

  it('the deterministic checks no longer block directly: they are inputs of the guard, which asks after intake', async () => {
    const h = createHarness({ projectYaml: INTAKE_FIRST });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Flou', description: 'trop court' });
    h.runner.enqueue(assessment({ size: 'xs' }));
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(skills(h)).toEqual(['/factory:intake']);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: false, size: 'xs' });
    expect(t.clarify?.questions[0]?.question).toContain('The description is shorter than 30 characters.');
  });

  it('the checks hold before the first run only: a ticket delegated again after its dev run is not refused for its own branch', async () => {
    const h = createHarness({ projectYaml: INTAKE_FIRST });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: DESCRIPTION });
    h.runner.enqueue(assessment(), DEV);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    // The dev run published its branch; the ticket goes back to In Progress and is delegated again.
    h.forge.branchNames.push('factory/rel-1-export-csv');
    await h.send('status.changed', { from: 'human_review', to: 'dev' });
    await h.orch.drained();
    const before = h.runner.requests.length;
    h.runner.enqueue(assessment(), DEV);
    await h.send('ticket.delegated', { linearSessionId: 'ls-2' });
    expect((await h.ticket()).blocked).toBe(false);
    expect(skills(h)[before]).toBe('/factory:intake');
  });
});
