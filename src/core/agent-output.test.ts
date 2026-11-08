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
