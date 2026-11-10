import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuditList, AuditSheet, auditHash, auditTicketOf } from './Audit.js';
import type { AuditSheetView, ReviewDefectView } from './types.js';

const tokens = { input: 1_000, output: 2_000, cacheRead: 30_000, cacheCreation: 4_000 };
const defect = (patch: Partial<ReviewDefectView> = {}): ReviewDefectView => ({
  id: 'd1', projectId: 'p', ticketId: 'REL-1', prNumber: 3, description: 'The header row is missing.', findingId: null, definition: null, enteredBy: 'dashboard:armand', at: 90_000, ...patch,
});
const sheet = (patch: Partial<AuditSheetView> = {}): AuditSheetView => ({
  projectId: 'p',
  ticketId: 'REL-1',
  definition: null,
  task: { title: 'Export CSV', spec: { goal: 'Export the list as CSV', criteria: ['Given a list, when exported, then a CSV comes out'] } },
  path: {
    steps: [{ job: 'dev', attempts: 2, tokens, attemptsWithoutTokens: 0, turns: 9, workMs: 120_000, costUsd: 0 }],
    attempts: [{ id: 'r1', job: 'dev', role: 'implementer', status: 'success', startedAt: 0, endedAt: 60_000, durationMs: 60_000, tokens, costUsd: 0, turns: 5 }],
    checks: [{ id: 'v', at: 61_000, check: 'verify', result: 'passed', runId: 'r1', job: 'dev', names: ['npm test'], red: null }],
    findings: [{ id: 'rv1:correctness:0', sha: 'abc1234', at: 70_000, lens: 'correctness', runId: 'rv1', file: 'src/export.ts', line: 12, severity: 'blocking', explanation: 'Off by one.', suggestion: '' }],
  },
  result: {
    prs: [{ number: 3, url: 'https://gh/pr/3', state: 'merged', mergedAt: 100_000 }],
    reviews: [{ id: 'rh', at: 80_000, author: 'lilian-gh', pr: 3, kind: 'review', state: 'changes_requested' }],
    mergedAt: 100_000,
    firstTry: false,
    reworks: [{ cause: 'changes_requested', id: 'rh' }],
    revertedWithin14Days: null,
  },
  defects: [defect(), defect({ id: 'd2', findingId: 'rv1:correctness:0', description: 'Off by one, seen by the AI.' })],
  ...patch,
});
const render = (s: AuditSheetView) => renderToStaticMarkup(createElement(AuditSheet, { sheet: s, onDefect: async () => true }));

describe('the audit sheet page (ORC-229)', () => {
  it('shows the three parts of a reviewed PR: the task, the agent path, the result', () => {
    const html = render(sheet());
    for (const part of ['The task', 'The agent’s path', 'The result']) expect(html).toContain(part);
    expect(html).toContain('Export the list as CSV');
    expect(html).toContain('Given a list, when exported, then a CSV comes out');
    expect(html).toContain('src/export.ts:12');
    expect(html).toContain('npm test');
    expect(html).toContain('PR #3');
    expect(html).toContain('merged');
    expect(html).toContain('lilian-gh');
    expect(html).toContain('changes requested');
  });

  it('lists the defects humans entered, each linked to its AI finding or said missed, and counts none without a definition (ORC-153)', () => {
    const html = render(sheet());
    expect(html).toContain('The header row is missing.');
    expect(html).toContain('missed by the AI reviewers');
    expect(html).toContain('seen by finding rv1:correctness:0');
    expect(html).toContain('audit.serious_defect');
    expect(html).not.toMatch(/\d+ defects?/);
    expect(html).not.toMatch(/\d+ missed/);
  });

  it('says when the finding a defect is linked to is no longer kept: its lens read the commit again', () => {
    expect(render(sheet({ defects: [defect({ findingId: 'rv0:correctness:0' })] }))).toContain('seen by finding rv0:correctness:0 (no longer kept)');
  });

  it('says the definition the defects are counted by once one is set, and which defects it leaves out', () => {
    const html = render(sheet({ definition: 'Loses data', defects: [defect({ definition: 'Loses data' }), defect({ id: 'd0' })] }));
    expect(html).toContain('Loses data');
    expect(html).toContain('entered under no definition: not counted');
  });

  it('offers the entry of a defect on a PR of the ticket, linked to one of its findings or to none', () => {
    const html = render(sheet());
    expect(html).toContain('<form');
    expect(html).toContain('value="rv1:correctness:0"');
    expect(html).toContain('None: the AI reviewers missed it');
    expect(html).toContain('value="3"');
  });

  it('lists the PRs a human reviewed, each to its sheet', () => {
    const html = renderToStaticMarkup(createElement(AuditList, { list: { definition: null, sheets: [{ projectId: 'p', ticketId: 'REL-1', title: 'Export CSV', logical: 'done', prUrl: 'https://gh/pr/3', mergedAt: 100_000 }] } }));
    expect(html).toContain(`href="${auditHash('p', 'REL-1')}"`);
    expect(html).toContain('Export CSV');
    expect(renderToStaticMarkup(createElement(AuditList, { list: { definition: null, sheets: [] } }))).toContain('No PR reviewed by a human yet');
  });

  it('finds the sheet a link names, and none for a malformed one', () => {
    expect(auditTicketOf(auditHash('p 1', 'REL-1'))).toEqual({ projectId: 'p 1', ticketId: 'REL-1' });
    expect(auditTicketOf('#audit')).toBeUndefined();
    expect(auditTicketOf('#audit/%E0%A4%A/REL-1')).toBeUndefined();
    expect(auditTicketOf('#audit/p')).toBeUndefined();
  });
});
