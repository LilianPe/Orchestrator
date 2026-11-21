import { describe, expect, it } from 'vitest';
import { causeOf } from '../../src/core/block-cause.js';
import type { Spec } from '../../src/core/spec.js';
import { assessment, chainHarness, delegate, drafted, RED_ASSERTION, REQUESTER, SPEC, VALIDATOR, WORKTREE } from '../helpers/chain.js';
import type { createHarness } from '../helpers/harness.js';

/**
 * ORC-212: `spec_draft` writes the spec, `spec_check` checks it, the factory publishes it in the ticket's session and a
 * designated validator, never the run's initiator, approves it (`/approve`), asks for changes (`/changes`) or rejects it.
 * Once approved, its criteria go to the `tests` step and are frozen with its tests.
 */
const TEST = "it('exports', () => expect(toCsv([])).toBe(''));\n";

type Harness = ReturnType<typeof createHarness>;

/**
 * A ticket delegated by the requester, a designated validator: intake finds it complete (ORC-395), then the spec is drafted as
 * `specs` say, one run each.
 */
async function delegated(...specs: Spec[]): Promise<Harness> {
  return delegatedOn(chainHarness(), ...specs);
}

async function delegatedOn(h: Harness, ...specs: Spec[]): Promise<Harness> {
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Export the audits as CSV from the audit list.' });
  h.workspaces.heads.set(WORKTREE, 'sha-tests');
  h.workspaces.steps.set(WORKTREE, { changed: [{ path: 'src/export.test.ts', deleted: false }], head: { 'src/export.test.ts': TEST } });
  h.runner.enqueue(assessment(), ...specs.map((s) => drafted(s)));
  await delegate(h);
  return h;
}

const command = (h: Harness, name: string, actor: string, body = '') =>
  h.send('command', { name, body, linearSessionId: 'ls-1', author: actor === VALIDATOR ? 'Lilian' : 'Armand', kind: 'command' }, 'REL-1', { actor });
const skills = (h: Harness) => h.runner.requests.map((r) => r.prompt.split('\n')[0]);
const said = (h: Harness) => h.tracker.activities('ls-1').map((a) => (a.type === 'action' ? a.parameter : a.body));

describe('the spec and its human gate (ORC-212)', () => {
  it('publishes the spec; the initiator cannot approve it; a validator\'s approval starts tests, whose criteria are frozen', async () => {
    const h = await delegated(SPEC);
    expect(skills(h)).toEqual(['/factory:intake', '/factory:spec-draft']);
    expect(h.runner.requests[1]!.effort).toBe('high');
    expect(said(h)).toContainEqual(expect.stringMatching(/^Spec published \(risk: low\)\. 1 acceptance criterion → tests\./));
    expect(await h.ticket()).toMatchObject({ blocked: false, logical: 'spec', spec: { version: 1 } });

    // Criterion 2: the run's initiator is refused, even though a team member; nothing starts.
    await command(h, '/approve', REQUESTER);
    expect(said(h).at(-1)).toMatch(/^Refused: validating the spec is reserved for validators designated by the project/);
    expect(skills(h)).toEqual(['/factory:intake', '/factory:spec-draft']);
    expect((await h.ticket()).spec?.approval).toBeUndefined();

    // Criterion 5: the validator approves, the tests step gets the criteria, and they are frozen with its tests.
    h.checks.failNext(RED_ASSERTION);
    h.runner.enqueue({}, { hold: true });
    await command(h, '/approve', VALIDATOR);
    expect(skills(h)).toEqual(['/factory:intake', '/factory:spec-draft', '/factory:tests', '/factory:build']);
    expect(h.runner.requests[2]!.prompt).toContain('## Approved spec (version 1)');
    expect(h.runner.requests[2]!.prompt).toContain('1. Given 2 audits, when I click CSV, then a file of 3 lines downloads.');
    const t = await h.ticket();
    expect(t.spec).toMatchObject({ version: 1, approval: { authorId: VALIDATOR } });
    expect(t.frozenTests).toMatchObject({ sha: 'sha-tests', criteria: SPEC.criteria });
    h.runner.release(h.runner.requests[3]!.runId);
    await h.orch.drained();
  });

  it('criterion 1: a spec without criterion goes back once to spec_draft with the reason, then the ticket is blocked', async () => {
    const h = await delegated({ ...SPEC, criteria: [] }, { ...SPEC, criteria: [] });
    expect(skills(h)).toEqual(['/factory:intake', '/factory:spec-draft', '/factory:spec-draft']);
    expect(h.runner.requests[2]!.prompt).toContain('No acceptance criterion: at least one is required.');
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: true, blockedJob: 'spec' });
    expect(causeOf(t.blockKind)).toBe('failed');
    expect(said(h).some((b) => b.startsWith('Spec published'))).toBe(false);
  });

  it('criterion 3: three rounds of /changes draft three new versions, the fourth blocks the ticket', async () => {
    const h = await delegated(SPEC, SPEC, SPEC, SPEC);
    for (const round of [1, 2, 3]) await command(h, '/changes', VALIDATOR, `round ${round}`);
    expect(skills(h)).toEqual(['/factory:intake', ...Array(4).fill('/factory:spec-draft')]);
    // The comment reaches the agent through the human inbox, beside its last version.
    expect(h.runner.requests[2]!.prompt).toContain('## Spec under review (version 1)');
    expect(h.runner.requests[2]!.prompt).toContain('round 1');
    expect((await h.ticket()).spec).toMatchObject({ version: 4 });
    await command(h, '/changes', VALIDATOR, 'round 4');
    expect(skills(h)).toHaveLength(5);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: true, blockedJob: 'spec' });
    expect(causeOf(t.blockKind)).toBe('limit');
  });

  it('criterion 4: a spec approved then changed during the run stops the work, goes back to spec_review, and waits for a new approval', async () => {
    const h = await delegated(SPEC);
    h.runner.enqueue({ hold: true });
    await command(h, '/approve', VALIDATOR);
    expect(skills(h)).toEqual(['/factory:intake', '/factory:spec-draft', '/factory:tests']);
    h.runner.enqueue(drafted({ ...SPEC, out_of_scope: ['XLSX', 'Archived audits'] }));
    await command(h, '/changes', VALIDATOR, 'Exclude archived audits.');
    await h.orch.drained();
    expect(skills(h)).toEqual(['/factory:intake', '/factory:spec-draft', '/factory:tests', '/factory:spec-draft']);
    const t = await h.ticket();
    expect(t.spec).toMatchObject({ version: 2 });
    expect(t.spec?.approval).toBeUndefined();
    expect(said(h).filter((b) => b.startsWith('Spec published'))).toHaveLength(2);
    // Nothing goes on before the new version is approved; once it is, the tests step starts again.
    h.checks.failNext(RED_ASSERTION);
    h.runner.enqueue({}, {});
    await command(h, '/approve', VALIDATOR);
    expect(skills(h).slice(4, 5)).toEqual(['/factory:tests']);
    expect(h.runner.requests[4]!.prompt).toContain('## Approved spec (version 2)');
  });
});

/** The spec's comments on the ticket, the factory's: each version's. */
const specComments = (h: Harness) => h.tracker.comments('REL-1').filter((b) => b.startsWith('**Spec, version'));

describe('the spec in a comment of the ticket (ORC-382)', () => {
  it('criterion 2: publishes the spec in a comment the session points to, and a revision adds a new comment', async () => {
    const h = await delegated(SPEC, { ...SPEC, out_of_scope: ['XLSX', 'Archived audits'] });
    expect(specComments(h)).toEqual([expect.stringMatching(/^\*\*Spec, version 1\*\*[\s\S]*1\. Given 2 audits, when I click CSV[\s\S]*\*\*Assumed without verification\*\*\n- The browser saves/)]);
    // The session, where the commands are replied, says where to read it.
    expect(said(h)).toContainEqual(expect.stringMatching(/^Spec published \(risk: low\)\. 1 acceptance criterion → tests\. Version 1, waiting for review\.\n\nRead it in this ticket's comment « \*\*Spec, version 1\*\* »\.[\s\S]*`\/approve`/));
    expect(said(h).some((b) => b.includes('**Acceptance criteria**'))).toBe(false);

    await command(h, '/changes', VALIDATOR, 'Exclude archived audits.');
    expect(specComments(h)).toHaveLength(2);
    expect(specComments(h)[1]).toMatch(/^\*\*Spec, version 2\*\*[\s\S]*- Archived audits/);
    expect(h.tracker.documents('REL-1')).toEqual([]);
  });

  it('criterion 3: a spec longer than the threshold goes to a document linked to the ticket, the comment gives its summary and its link', async () => {
    const h = await delegatedOn(chainHarness({ specPublication: { mode: 'comment+doc', threshold: 200 } }), SPEC);
    expect(h.tracker.documents('REL-1')).toEqual([{ title: 'REL-1: spec, version 1', body: expect.stringMatching(/^\*\*Goal\*\*\nExport the audits as CSV\.[\s\S]*\*\*Acceptance criteria\*\*\n1\. Given 2 audits/) }]);
    const [comment] = specComments(h);
    expect(comment).toMatch(/^\*\*Spec, version 1\*\*\n\nExport the audits as CSV\.\n\n1 acceptance criterion\. The whole spec: \[REL-1: spec, version 1\]\(https:\/\/linear\.test\/document\/REL-1-1\)/);
    expect(comment).not.toContain('**Acceptance criteria**');
    expect(said(h)).toContainEqual(expect.stringContaining('Read it in its document: https://linear.test/document/REL-1-1'));
  });

  it('ORC-457 criterion 1: with no setting, the ticket shows Spec while its spec is drafted and reviewed, then In Progress once approved', async () => {
    const h = await delegated(SPEC);
    expect(h.tracker.issues.get('REL-1')!.stateName).toBe('Spec');
    expect(await h.ticket()).toMatchObject({ logical: 'spec', spec: { version: 1 } });
    h.checks.failNext(RED_ASSERTION);
    h.runner.enqueue({}, { hold: true });
    await command(h, '/approve', VALIDATOR);
    expect(skills(h)).toEqual(['/factory:intake', '/factory:spec-draft', '/factory:tests', '/factory:build']);
    expect(h.tracker.issues.get('REL-1')!.stateName).toBe('In Progress');
    h.runner.release(h.runner.requests[3]!.runId);
    await h.orch.drained();
  });

  it('ORC-457 criterion 2: `statuses: { spec_draft: off }` keeps the ticket in Todo through its spec, which still waits for /approve', async () => {
    const h = await delegatedOn(chainHarness({ statuses: { spec_draft: 'off' } }), SPEC);
    expect(h.tracker.issues.get('REL-1')!.stateName).toBe('Todo');
    expect(await h.ticket()).toMatchObject({ logical: 'todo', spec: { version: 1 } });
    expect(skills(h)).toEqual(['/factory:intake', '/factory:spec-draft']);
    h.checks.failNext(RED_ASSERTION);
    h.runner.enqueue({}, { hold: true });
    await command(h, '/approve', VALIDATOR);
    expect(skills(h)).toEqual(['/factory:intake', '/factory:spec-draft', '/factory:tests', '/factory:build']);
    expect(h.tracker.issues.get('REL-1')!.stateName).toBe('In Progress');
    h.runner.release(h.runner.requests[3]!.runId);
    await h.orch.drained();
  });

  it('a tracker that keeps no document beside a ticket publishes the whole spec in the comment', async () => {
    const h = chainHarness({ specPublication: { mode: 'doc', threshold: 200 } });
    h.tracker.keepsDocuments = false;
    await delegatedOn(h, SPEC);
    expect(specComments(h)).toEqual([expect.stringContaining('**Acceptance criteria**\n1. Given 2 audits')]);
  });
});
