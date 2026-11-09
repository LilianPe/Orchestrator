import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import type { AgentOutput } from './agent-output.js';
import { causeOf } from './block-cause.js';
import { decide } from './engine.js';
import { reduce } from './reduce.js';
import type { Spec } from './spec.js';
import { newTicketState, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });

const SPEC: Spec = {
  goal: 'Export the audits as CSV.',
  out_of_scope: ['XLSX'],
  criteria: ['Given 2 audits, when I click CSV, then a file of 3 lines downloads.', 'Given no audit, when I click CSV, then the file holds the header only.'],
  files: ['src/export.ts'],
  architecture: 'None.',
  risks: [],
  assumed: [],
};
const output = (spec: Spec | undefined): AgentOutput => ({ status: 'done', summary: 'Drafted.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], ...(spec ? { spec } : {}) });

const REQUESTER = 'u-requester';
const VALIDATOR = 'u-validator';

let seq = 0;
function ev<T extends EventType>(type: T, payload: EventPayloads[T], extra: Partial<FactoryEvent> = {}): FactoryEvent {
  return { id: `e-${type}-${++seq}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: 3, taint: 'trusted', payload, ...extra } as FactoryEvent;
}
const drafted = (spec: Spec | undefined, runId = 'r1') =>
  ev('run.finished', { runId, job: 'spec', outcome: 'success', costUsd: 0.1, turns: 3, lastText: 'ok', attempt: 'succeeded', output: output(spec) });
/** A command in a reply of the ticket's session, signed by `actor` with `roles`. */
const command = (name: string, body = '', actor = VALIDATOR, roles: string[] = ['validator', 'team_member'], session = 's1') =>
  ev('command', { name, body, linearSessionId: session, author: actor === VALIDATOR ? 'Val' : 'Req', kind: 'command' }, { actor, roles } as Partial<FactoryEvent>);

function ticket(patch: Partial<TicketState> = {}): TicketState {
  return { ...newTicketState('p', 'REL-1', 'Titre', 'todo', 0), delegated: true, activeRunId: 'r1', activeJob: 'spec', linearSessionId: 's1', initiatorId: REQUESTER, risk: 'medium', ...patch };
}
/** The ticket once the decision is applied, its run's end included. */
const after = (t: TicketState, e: FactoryEvent) => decide(t, e, workflow).events.reduce<TicketState | undefined>((s, x) => reduce(s, x), reduce(t, e))!;
/** The ticket waiting for the review of its first version. */
const reviewing = () => after(ticket(), drafted(SPEC));
const approved = () => after(reviewing(), command('/approve'));

describe('spec_draft, spec_check and the spec_review gate (ORC-212)', () => {
  it('spec_draft is an agent step at effort high that writes nothing, moves nothing, and leads to tests once approved', () => {
    expect(workflow.jobs['spec']).toMatchObject({ step: 'spec_draft', queue: 'dev', effort: 'high', structuredOutput: true, pickup: false, onStart: {}, onSuccess: { run: 'tests' } });
    expect(workflow.limits).toMatchObject({ specCheckReturns: 1, specChanges: 3 });
  });

  it('a spec that passes spec_check is published in the session, with its risk and its criteria count, and the ticket waits for review', () => {
    const out = decide(ticket(), drafted(SPEC), workflow);
    const published = out.effects.filter((x) => x.kind === 'activity');
    expect(published).toEqual([expect.objectContaining({ type: 'response', body: expect.stringMatching(/^Spec published \(risk: medium\)\. 2 acceptance criteria → tests\./) })]);
    expect(published[0]).toMatchObject({ body: expect.stringContaining('/approve') });
    expect(published[0]).toMatchObject({ body: expect.stringContaining('**Assumed without verification**\n- (none)') });
    expect(out.effects.some((x) => x.kind === 'start_run' || x.kind === 'move')).toBe(false);
    expect(reviewing()).toMatchObject({ blocked: false, spec: { job: 'spec', version: 1, spec: SPEC, at: 1000 } });
    expect(reviewing().spec).not.toHaveProperty('approval');
  });

  it('criterion 1: a spec without acceptance criterion goes back once to spec_draft, then the run is blocked', () => {
    const noCriterion = { ...SPEC, criteria: [] };
    const first = decide(ticket(), drafted(noCriterion), workflow);
    expect(first.effects).toEqual([expect.objectContaining({ kind: 'start_run', job: 'spec', input: 'spec_check', inputText: expect.stringContaining('No acceptance criterion') })]);
    // In a session of its own: the refused draft goes with the reason, the ticket's session is not resumed.
    expect(first.effects[0]).not.toHaveProperty('resume');
    expect(first.effects[0]).toMatchObject({ inputText: expect.stringContaining('Your spec as it was refused:\n\n**Goal**\nExport the audits as CSV.') });
    const back = after(ticket(), drafted(noCriterion));
    expect(back).toMatchObject({ blocked: false, specCheckReturns: 1 });
    const again = after({ ...back, activeRunId: 'r2' }, drafted(noCriterion, 'r2'));
    expect(again).toMatchObject({ blocked: true, blockedJob: 'spec' });
    expect(causeOf(again.blockKind)).toBe('failed');
    expect(again.blockReason).toContain('spec_check');
    // A spec that passes resets the count for the next draft.
    expect(after({ ...back, activeRunId: 'r2' }, drafted(SPEC, 'r2')).specCheckReturns).toBe(0);
  });

  it('spec_check refuses a missing section, a property without its domain, and a result without spec', () => {
    const out = decide(ticket(), drafted({ ...SPEC, assumed: undefined, properties: [{ statement: 'sorted', target: 'toCsv' }] }), workflow);
    const start = out.effects.find((x) => x.kind === 'start_run');
    expect(start).toMatchObject({ inputText: expect.stringContaining('Section `assumed` is missing.') });
    expect(start).toMatchObject({ inputText: expect.stringContaining('Property 1 has no domain.') });
    expect(decide(ticket(), drafted(undefined), workflow).effects.find((x) => x.kind === 'start_run')).toMatchObject({ inputText: expect.stringContaining('No `spec` in the result.') });
  });

  it('criterion 2: the initiator of the run cannot approve, even as a designated validator', () => {
    const out = decide(reviewing(), command('/approve', '', REQUESTER, ['validator', 'team_member']), workflow);
    expect(out.trace).toContainEqual(expect.stringMatching(/^authz: refused validate_spec to u-requester \(initiator/));
    expect(out.effects).toEqual([expect.objectContaining({ kind: 'activity', type: 'response', body: expect.stringMatching(/^Refused/), linearSessionId: 's1' })]);
    expect(after(reviewing(), command('/approve', '', REQUESTER, ['validator']))?.spec?.approval).toBeUndefined();
  });

  it('only a designated validator approves, in the ticket\'s session; an event without resolved roles never approves', () => {
    expect(decide(reviewing(), command('/approve', '', 'u-member', ['team_member']), workflow).trace).toContainEqual(expect.stringMatching(/^authz: refused validate_spec to u-member \(roles/));
    const elsewhere = decide(reviewing(), command('/approve', '', VALIDATOR, ['validator'], 's-other'), workflow);
    expect(elsewhere.trace).toContainEqual(expect.stringMatching(/^authz: refused validate_spec to u-validator \(channel/));
    const unresolved = { ...command('/approve'), roles: undefined } as FactoryEvent;
    expect(after(reviewing(), unresolved).spec?.approval).toBeUndefined();
  });

  it('an approval records who approved the version, and starts the step after the gate: tests', () => {
    const out = decide(reviewing(), command('/approve'), workflow);
    expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'tests' }));
    expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'activity', type: 'response', body: expect.stringMatching(/^Spec version 1 approved by Val/), linearSessionId: 's1' }));
    expect(approved().spec).toMatchObject({ version: 1, approval: { author: 'Val', authorId: VALIDATOR, at: 1000 } });
  });

  it('nothing to approve: no spec waiting, or a spec already approved', () => {
    expect(decide(ticket({ activeRunId: undefined }), command('/approve'), workflow).effects).toEqual([expect.objectContaining({ kind: 'activity', body: expect.stringMatching(/^No spec waits for review/) })]);
    const twice = decide({ ...approved(), activeRunId: 'r-tests' }, command('/approve'), workflow);
    expect(twice.effects).toEqual([expect.objectContaining({ kind: 'activity', body: expect.stringMatching(/^Version 1 of the spec is already approved/) })]);
    expect(twice.effects.some((x) => x.kind === 'start_run')).toBe(false);
  });

  it('/changes relaunches spec_draft with the comment as feedback for the agent, and a new version asks for a new approval', () => {
    const out = decide(reviewing(), command('/changes', 'Add the XLSX case.'), workflow);
    expect(out.events).toContainEqual({ type: 'feedback.appended', item: expect.objectContaining({ body: 'Add the XLSX case.', kind: 'instruction', source: 'session', authorId: VALIDATOR }) });
    expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'spec', input: 'feedback' }));
    expect(out.effects.find((x) => x.kind === 'start_run')).not.toHaveProperty('resume');
    const changed = after(reviewing(), command('/changes', 'Add the XLSX case.'));
    expect(changed).toMatchObject({ specChanges: 1, spec: { version: 1, drafting: true } });
    const v2 = after({ ...changed, activeRunId: 'r2' }, drafted({ ...SPEC, out_of_scope: [] }, 'r2'));
    expect(v2.spec).toMatchObject({ version: 2 });
    expect(v2.spec).not.toHaveProperty('approval');
  });

  it('while the next version is drafted, even still in the queue (no run on the ticket yet), nothing is approved, rejected or changed', () => {
    const drafting = after(reviewing(), command('/changes', 'Add the XLSX case.'));
    for (const name of ['/approve', '/reject', '/changes']) {
      const out = decide({ ...drafting, activeRunId: undefined }, command(name, 'more'), workflow);
      expect(out.effects).toEqual([expect.objectContaining({ kind: 'activity', body: expect.stringMatching(/^A new version of the spec is being drafted/) })]);
    }
    // Its version published, the mark goes with it.
    expect(after({ ...drafting, activeRunId: 'r2' }, drafted(SPEC, 'r2')).spec).not.toHaveProperty('drafting');
  });

  it('/approve may name the version read: another than the one waiting approves nothing', () => {
    const out = decide(reviewing(), command('/approve', '2'), workflow);
    expect(out.effects).toEqual([expect.objectContaining({ kind: 'activity', body: expect.stringMatching(/^Version 2 is not the one waiting for review: version 1 is/) })]);
    expect(decide(reviewing(), command('/approve', '1'), workflow).effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'tests' }));
  });

  it('a delegation again starts afresh: the spec of the earlier one is no contract any more', () => {
    const delegated = ev('ticket.delegated', { linearSessionId: 's2' }, { actor: REQUESTER, roles: ['team_member', 'repo_writer'] } as Partial<FactoryEvent>);
    const t = after({ ...approved(), activeRunId: undefined, activeJob: undefined, delegated: false }, delegated);
    expect(t.spec).toBeNull();
  });

  it('/changes without a comment asks for one, and counts nothing', () => {
    const out = decide(reviewing(), command('/changes', '  '), workflow);
    expect(out.effects).toEqual([expect.objectContaining({ kind: 'activity', body: expect.stringMatching(/^Say what to change/) })]);
    expect(after(reviewing(), command('/changes', '')).specChanges).toBeUndefined();
  });

  it('criterion 3: after three rounds of /changes, a fourth blocks the run', () => {
    let t = reviewing();
    for (let round = 1; round <= 3; round++) {
      t = after(t, command('/changes', `round ${round}`));
      expect(t).toMatchObject({ blocked: false, specChanges: round });
      t = after({ ...t, activeRunId: `r${round + 1}` }, drafted(SPEC, `r${round + 1}`));
    }
    const out = decide(t, command('/changes', 'round 4'), workflow);
    expect(out.effects.some((x) => x.kind === 'start_run')).toBe(false);
    const blocked = after(t, command('/changes', 'round 4'));
    expect(blocked).toMatchObject({ blocked: true, blockedJob: 'spec' });
    expect(causeOf(blocked.blockKind)).toBe('limit');
    expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'block_comment', block: expect.objectContaining({ step: 'spec_review', max: 3 }) }));
    // A human's reply relaunches spec_draft, its rounds counted again from zero.
    const resumed = decide(blocked, ev('session.prompted', { linearSessionId: 's1', body: 'Go with CSV only.', author: 'Val', kind: 'instruction' }, { actor: VALIDATOR, roles: ['team_member'] } as Partial<FactoryEvent>), workflow);
    expect(resumed.effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'spec' }));
    expect(resumed.events).toContainEqual({ type: 'ticket.patched', patch: { specChanges: 0 } });
  });

  it('/reject stops the ticket on the spec: blocked, a reply drafts again', () => {
    const t = after(reviewing(), command('/reject', 'Not what we need.'));
    expect(t).toMatchObject({ blocked: true, blockedJob: 'spec' });
    expect(causeOf(t.blockKind)).toBe('stopped');
    expect(t.blockReason).toContain('rejected by Val');
  });

  it('/changes and /reject are kept for the same validators: a member is refused', () => {
    for (const name of ['/changes', '/reject']) {
      const out = decide(reviewing(), command(name, 'x', 'u-member', ['team_member']), workflow);
      expect(out.trace).toContainEqual(expect.stringMatching(/^authz: refused validate_spec/));
      expect(out.events).toEqual([]);
    }
  });

  it('criterion 4: a spec approved then changed during the run goes back to spec_review, and asks for a new approval', () => {
    // Approved, nothing at work yet (a start may still wait in the queue): the work is cancelled all the same.
    expect(decide(approved(), command('/changes', 'x'), workflow).effects.map((x) => x.kind)).toEqual(expect.arrayContaining(['stop_run', 'start_run']));
    // The tests step is at work on version 1 when the validator asks for a change.
    const working = { ...approved(), activeRunId: 'r-tests', activeJob: 'tests', logical: 'dev' as const };
    const out = decide(working, command('/changes', 'Exclude archived audits.'), workflow);
    expect(out.events).toContainEqual({ type: 'work.cancelled' });
    expect(out.effects.map((x) => x.kind)).toEqual(expect.arrayContaining(['stop_run', 'start_run']));
    expect(out.effects.findIndex((x) => x.kind === 'stop_run')).toBeLessThan(out.effects.findIndex((x) => x.kind === 'start_run'));
    const changed = after(working, command('/changes', 'Exclude archived audits.'));
    expect(changed.spec).not.toHaveProperty('approval');
    // Its new version is published for review: the run starts again from spec_review, nothing goes on before a new approval.
    const v2 = decide({ ...changed, activeRunId: 'r-spec2', activeJob: 'spec' }, drafted({ ...SPEC, out_of_scope: ['Archived audits'] }, 'r-spec2'), workflow);
    expect(v2.effects).toEqual([expect.objectContaining({ kind: 'activity', body: expect.stringMatching(/^Spec published/) })]);
    const reviewed = after({ ...changed, activeRunId: 'r-spec2', activeJob: 'spec' }, drafted({ ...SPEC, out_of_scope: ['Archived audits'] }, 'r-spec2'));
    expect(reviewed.spec).toMatchObject({ version: 2 });
    expect(decide(reviewed, command('/approve'), workflow).effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'tests' }));
  });

  it('criterion 5: once the tests step froze its tests, the approved criteria are frozen with them, and a /refreeze keeps them', () => {
    const t = { ...approved(), activeRunId: 'r2', activeJob: 'tests', verifyingRunId: 'r2' };
    const frozen = { sha: 'abc', files: { 'test/export.test.ts': 'f1' }, rules: 1 };
    const out = after(t, ev('verify.passed', { runId: 'r2', job: 'tests', red: 'assertion', frozen }));
    expect(out.frozenTests).toEqual({ ...frozen, criteria: SPEC.criteria });
    const refrozen = decide(out, ev('command', { name: '/refreeze', body: '', linearSessionId: 's1', author: 'M', frozen: { sha: 'new', files: {} } }, { roles: ['maintainer'], actor: 'u-m' } as Partial<FactoryEvent>), workflow);
    expect(refrozen.events).toContainEqual({ type: 'ticket.patched', patch: { frozenTests: { sha: 'new', files: {}, criteria: SPEC.criteria, refrozenBy: 'u-m' } } });
  });

  it('a later freeze adds the criteria of the version approved since to those already frozen, as it does the files', () => {
    const first = { sha: 'abc', files: { 'test/a.test.ts': 'f1' }, rules: 1, criteria: ['Old criterion.'] };
    const t = { ...approved(), frozenTests: first, activeRunId: 'r2', activeJob: 'tests', verifyingRunId: 'r2' };
    const out = after(t, ev('verify.passed', { runId: 'r2', job: 'tests', red: 'assertion', frozen: { sha: 'def', files: { 'test/a.test.ts': 'f2', 'test/b.test.ts': 'f3' }, rules: 1 } }));
    expect(out.frozenTests).toEqual({ sha: 'abc', files: { 'test/a.test.ts': 'f1', 'test/b.test.ts': 'f3' }, rules: 1, criteria: ['Old criterion.', ...SPEC.criteria!] });
  });

  it('a ticket with no approved spec freezes as before', () => {
    const t = ticket({ activeRunId: 'r2', activeJob: 'tests', verifyingRunId: 'r2' });
    const frozen = { sha: 'abc', files: {}, rules: 1 };
    expect(after(t, ev('verify.passed', { runId: 'r2', job: 'tests', red: 'assertion', frozen })).frozenTests).toEqual(frozen);
  });
});
