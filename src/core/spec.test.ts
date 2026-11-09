import { describe, expect, it } from 'vitest';
import { parseAgentOutput, parseSubmittedResult } from './agent-output.js';
import { formatSpec, specCheck, type Spec } from './spec.js';

const SPEC: Spec = {
  goal: 'Export the audits as CSV.',
  out_of_scope: [],
  criteria: ['Given 2 audits, when I click CSV, then a file of 3 lines downloads.'],
  files: ['src/export.ts'],
  architecture: 'None.',
  risks: [],
  assumed: [],
};
const result = (spec: unknown) => ({ status: 'done', summary: 'Drafted.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], spec });

describe('spec_check (ORC-212)', () => {
  it('passes a spec with every section and a criterion, empty lists included', () => {
    expect(specCheck(SPEC)).toEqual([]);
  });

  it('names each missing section, an empty criteria list, and a property without its statement, domain or target', () => {
    expect(specCheck({ ...SPEC, goal: ' ', files: undefined, criteria: [], properties: [{ statement: 'sorted', domain: 'any list' }, { statement: 'a', domain: 'b', target: 'c' }] })).toEqual([
      'Section `goal` is missing.',
      'Section `files` is missing.',
      'No acceptance criterion: at least one is required.',
      'Property 1 has no target.',
    ]);
  });

  it('requires each decision of the ticket in the spec, with the answer the human gave', () => {
    const decisions = [{ question: 'CSV or XLSX?', answer: 'CSV' }];
    expect(specCheck(SPEC, decisions)).toEqual(['The decision « CSV or XLSX? » is not in `decisions`.']);
    expect(specCheck({ ...SPEC, decisions: [{ question: 'CSV or XLSX?', answer: 'XLSX' }] }, decisions)).toEqual(['The decision « CSV or XLSX? » was answered « CSV », not « XLSX ».']);
    expect(specCheck({ ...SPEC, decisions: [{ question: 'CSV or XLSX?', answer: 'CSV' }] }, decisions)).toEqual([]);
  });

  it('an empty criterion among others is refused: each one becomes a test', () => {
    expect(specCheck({ ...SPEC, criteria: ['Given a, then b.', ' '] })).toEqual(['Criterion 2 is empty.']);
  });

  it('a result without spec fails it', () => {
    expect(specCheck(undefined)).toEqual(['No `spec` in the result.']);
  });
});

describe('the spec as published (ORC-212)', () => {
  it('shows every section in a fixed order, « assumed without verification » even empty', () => {
    const text = formatSpec({ ...SPEC, decisions: [{ question: 'CSV or XLSX?', answer: 'CSV' }] });
    expect(text.split('\n\n').map((s) => s.split('\n')[0])).toEqual([
      '**Goal**', '**Out of scope**', '**Acceptance criteria**', '**Decisions**', '**Files**', '**Architecture impact**', '**Risks**', '**Assumed without verification**',
    ]);
    expect(text).toContain('**Assumed without verification**\n- (none)');
    expect(text).toContain('1. Given 2 audits');
  });

  it('the result schema takes a spec with sections missing (spec_check judges it), but not an unknown key; submit_result refuses one too long to publish', () => {
    expect(parseAgentOutput(result({ criteria: [] })).ok).toBe(true);
    expect(parseAgentOutput(result({ ...SPEC, extra: 1 })).ok).toBe(false);
    const long = parseSubmittedResult(result({ ...SPEC, criteria: Array.from({ length: 20 }, () => 'x'.repeat(500)) }));
    expect(long).toMatchObject({ ok: false, error: expect.stringContaining('spec: the spec makes a message of') });
  });
});
