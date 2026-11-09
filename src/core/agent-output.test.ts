import { describe, expect, it } from 'vitest';
import { attemptOutcome, parseAgentOutput, type AgentOutput } from './agent-output.js';

const done: AgentOutput = {
  status: 'done', summary: 'Export CSV ajouté', tests_added: ['src/export.test.ts'], why: 'demande du ticket',
  assumptions: [], risks: [], untested: [], review_hints: [{ file: 'src/export.ts', reason: 'encodage' }],
};

describe('parseAgentOutput', () => {
  it('accepts the documented output', () => {
    expect(parseAgentOutput(done)).toEqual({ ok: true, output: done });
    const blocked = { ...done, status: 'blocked', question: 'Quel séparateur ?', visual_scenario: { url: '/export', steps: ['clic'] } };
    expect(parseAgentOutput(blocked).ok).toBe(true);
  });

  it('names the offending field', () => {
    const r = parseAgentOutput({ ...done, review_hints: [{ file: '' , reason: 'x' }] });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('review_hints.0.file') });
    expect(parseAgentOutput({ ...done, status: 'blocked' })).toEqual({ ok: false, error: expect.stringContaining('question') });
    expect(parseAgentOutput({ ...done, reason: 'spec_impossible' })).toEqual({ ok: false, error: expect.stringContaining('reason') });
    expect(parseAgentOutput({ ...done, extra: 1 }).ok).toBe(false);
    expect(parseAgentOutput('texte libre').ok).toBe(false);
  });

  it("takes intake's assessment, with its questions when the ticket is not complete (ORC-206)", () => {
    const intake = { size: 'm', risk: 'high', complete: true, missing: [], screen: true } as const;
    expect(parseAgentOutput({ ...done, intake }).ok).toBe(true);
    expect(parseAgentOutput({ ...done, intake: { ...intake, complete: false } })).toEqual({ ok: false, error: expect.stringContaining('intake.missing') });
    expect(parseAgentOutput({ ...done, intake: { ...intake, complete: false, missing: ['CSV or XLSX?'] } }).ok).toBe(true);
    expect(parseAgentOutput({ ...done, intake: { ...intake, risk: 'none' } })).toEqual({ ok: false, error: expect.stringContaining('intake.risk') });
    expect(parseAgentOutput({ ...done, intake: { ...intake, complete: false, missing: ['a?', 'b?', 'c?', 'd?'] } })).toEqual({ ok: false, error: expect.stringContaining('intake.missing') });
  });

  it('takes the duplicates, the code to reuse and the scope intake found, each optional and bounded (ORC-207)', () => {
    const intake = { size: 'xl', risk: 'low', complete: true, missing: [], screen: false } as const;
    const found = {
      duplicates: [{ url: 'https://github.com/acme/app/pull/12', why: 'Same export.' }],
      reuse: [{ path: 'src/csv.ts', symbol: 'toCsv', why: 'Writes a line.' }, { path: 'src/io/', why: 'Helpers.' }],
      scope: { refuse: 'Too big.', split: [{ title: 'One', summary: 'First.' }] },
    };
    expect(parseAgentOutput({ ...done, intake: { ...intake, ...found } }).ok).toBe(true);
    expect(parseAgentOutput({ ...done, intake: { ...intake, scope: { refuse: 'Too big.' } } }).ok).toBe(true);
    const dup = found.duplicates[0]!;
    expect(parseAgentOutput({ ...done, intake: { ...intake, duplicates: [dup, dup, dup, dup] } })).toEqual({ ok: false, error: expect.stringContaining('intake.duplicates') });
    expect(parseAgentOutput({ ...done, intake: { ...intake, duplicates: [{ url: '', why: 'x' }] } })).toEqual({ ok: false, error: expect.stringContaining('intake.duplicates') });
    expect(parseAgentOutput({ ...done, intake: { ...intake, scope: { refuse: '' } } })).toEqual({ ok: false, error: expect.stringContaining('intake.scope') });
    expect(parseAgentOutput({ ...done, intake: { ...intake, reuse: [{ path: 'a', why: 'b', line: 3 }] } })).toEqual({ ok: false, error: expect.stringContaining('intake.reuse') });
  });

  it('takes a conflict the rebase step stops on, with its case, and only with a blocked status (ORC-146)', () => {
    const stops = { ...done, status: 'blocked', reason: 'conflict', conflict: 'migrations', question: 'Which migration goes first?' };
    expect(parseAgentOutput(stops).ok).toBe(true);
    expect(attemptOutcome({ outcome: 'success' }, parseAgentOutput(stops).ok ? (stops as AgentOutput) : undefined)).toBe('needs_input');
    expect(parseAgentOutput({ ...stops, conflict: undefined })).toEqual({ ok: false, error: expect.stringContaining('conflict') });
    expect(parseAgentOutput({ ...stops, conflict: 'style' })).toEqual({ ok: false, error: expect.stringContaining('conflict') });
    expect(parseAgentOutput({ ...done, status: 'blocked', question: 'q', conflict: 'logic' })).toEqual({ ok: false, error: expect.stringContaining('conflict') });
  });
});

describe('findings of a review lens (ORC-183)', () => {
  const finding = { file: 'src/auth.ts', line: 12, severity: 'blocking', explanation: 'The token is compared with ==.', suggestion: 'Use timingSafeEqual.' } as const;

  it('takes structured findings, a violated fact optional', () => {
    expect(parseAgentOutput({ ...done, findings: [] }).ok).toBe(true);
    expect(parseAgentOutput({ ...done, findings: [finding, { ...finding, severity: 'minor', fact: 'F-12' }, { ...finding, severity: 'out_of_scope', suggestion: '' }] }).ok).toBe(true);
  });

  it('refuses a severity, a line or a field outside the schema, naming it', () => {
    expect(parseAgentOutput({ ...done, findings: [{ ...finding, severity: 'important' }] })).toEqual({ ok: false, error: expect.stringContaining('findings.0.severity') });
    expect(parseAgentOutput({ ...done, findings: [{ ...finding, line: 0 }] })).toEqual({ ok: false, error: expect.stringContaining('findings.0.line') });
    expect(parseAgentOutput({ ...done, findings: [{ ...finding, file: '' }] })).toEqual({ ok: false, error: expect.stringContaining('findings.0.file') });
    expect(parseAgentOutput({ ...done, findings: [{ ...finding, explanation: '' }] })).toEqual({ ok: false, error: expect.stringContaining('findings.0.explanation') });
    expect(parseAgentOutput({ ...done, findings: [{ ...finding, extra: 1 }] }).ok).toBe(false);
    expect(parseAgentOutput({ ...done, findings: Array.from({ length: 51 }, () => finding) })).toEqual({ ok: false, error: expect.stringContaining('findings') });
  });
});

describe('what the fix of the review loop did with each finding (ORC-184)', () => {
  it('criterion 1: takes each finding fixed by its own commit, or contested with a justification', () => {
    const out = { ...done, fixed: [{ finding: 'correctness-1', commit: 'a1b2c3d' }, { finding: 'security-1', commit: 'e4f5a6b7c8d9' }], contested: [{ finding: 'security-2', justification: 'Hashed first.' }] };
    expect(parseAgentOutput(out).ok).toBe(true);
  });

  it('criterion 1: refuses two findings fixed by one commit, a short sha of the same commit included', () => {
    expect(parseAgentOutput({ ...done, fixed: [{ finding: 'correctness-1', commit: 'a1b2c3d' }, { finding: 'correctness-2', commit: 'a1b2c3d' }] })).toEqual({ ok: false, error: expect.stringContaining('one commit per finding') });
    expect(parseAgentOutput({ ...done, fixed: [{ finding: 'correctness-1', commit: 'a1b2c3d' }, { finding: 'correctness-2', commit: 'a1b2c3d4e5f6' }] }).ok).toBe(false);
  });

  it('refuses a finding both fixed and contested, a contest without its justification, and a commit that is no sha', () => {
    expect(parseAgentOutput({ ...done, fixed: [{ finding: 'security-1', commit: 'a1b2c3d' }], contested: [{ finding: 'security-1', justification: 'No.' }] })).toEqual({ ok: false, error: expect.stringContaining('each finding once') });
    expect(parseAgentOutput({ ...done, contested: [{ finding: 'security-1', justification: '' }] })).toEqual({ ok: false, error: expect.stringContaining('contested.0.justification') });
    expect(parseAgentOutput({ ...done, fixed: [{ finding: 'security-1', commit: 'HEAD' }] })).toEqual({ ok: false, error: expect.stringContaining('fixed.0.commit') });
  });
});

describe('the relay of a question through the run inbox (ORC-182)', () => {
  it("takes the answer agent's relay, on a done status only", () => {
    expect(parseAgentOutput({ ...done, relay: true }).ok).toBe(true);
    expect(parseAgentOutput({ ...done, status: 'blocked', question: 'Q ?', relay: true })).toEqual({ ok: false, error: expect.stringContaining('relay') });
  });

  it("takes the implementer's answers to the relayed questions, each question once", () => {
    expect(parseAgentOutput({ ...done, answers: [{ question: 'run-1', answer: 'Parce que le ticket le demande.' }] }).ok).toBe(true);
    expect(parseAgentOutput({ ...done, answers: [{ question: 'run-1', answer: '' }] })).toEqual({ ok: false, error: expect.stringContaining('answers.0.answer') });
    const twice = [{ question: 'run-1', answer: 'a' }, { question: 'run-1', answer: 'b' }];
    expect(parseAgentOutput({ ...done, answers: twice })).toEqual({ ok: false, error: expect.stringContaining('answers') });
  });
});

describe('attemptOutcome', () => {
  const blocked = (reason?: 'needs_input' | 'spec_impossible'): AgentOutput => ({ ...done, status: 'blocked', question: '?', ...(reason ? { reason } : {}) });
  it.each([
    [{ outcome: 'success' as const }, done, 'succeeded'],
    // A done claimed by a run that failed is not a success; a question asked before failing still holds.
    [{ outcome: 'failure' as const }, done, 'failed'],
    [{ outcome: 'failure' as const }, blocked(), 'needs_input'],
    [{ outcome: 'failure' as const }, blocked('spec_impossible'), 'spec_impossible'],
    [{ outcome: 'success' as const }, blocked(), 'needs_input'],
    [{ outcome: 'success' as const }, blocked('needs_input'), 'needs_input'],
    [{ outcome: 'success' as const }, blocked('spec_impossible'), 'spec_impossible'],
    [{ outcome: 'success' as const }, undefined, 'failed'],
    [{ outcome: 'failure' as const }, undefined, 'failed'],
    [{ outcome: 'limit' as const }, done, 'timeout'],
    [{ outcome: 'stopped' as const }, done, 'errored'],
    [{ outcome: 'failure' as const, infraError: true }, undefined, 'errored'],
  ])('%j with %j → %s', (run, output, expected) => {
    expect(attemptOutcome(run, output)).toBe(expected);
  });
});
