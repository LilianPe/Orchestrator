import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Measures, runHash, runIdOf } from './Measures.js';
import { RunDetail } from './RunDetail.js';
import type { MeasuredTicketView, RunDetailView, RunMeasureView, TicketMeasuresView } from './types.js';

const tokens = { input: 1_000, output: 2_000, cacheRead: 30_000, cacheCreation: 4_000 };
const attempt = (patch: Partial<RunMeasureView> = {}): RunMeasureView => ({
  id: 'r1', job: 'dev', role: 'implementer', status: 'success', startedAt: 0, endedAt: 60_000, durationMs: 60_000, tokens, costUsd: 0, turns: 5, ...patch,
});

const detail = (patch: Partial<RunDetailView> = {}): RunDetailView => ({
  run: { ...attempt(), projectId: 'p', ticketId: 'REL-1', queue: 'dev', outcome: 'succeeded', infra: false, labels: null },
  timeline: [
    { id: 'd', type: 'ticket.delegated', at: 0, ofRun: false, what: 'Delegated to the factory' },
    { id: 'f', type: 'run.finished', at: 60_000, ofRun: true, what: 'dev ended: succeeded, 5 turns' },
  ],
  decisions: [{ id: 'd', type: 'ticket.delegated', at: 0, channel: 'linear', who: 'Lilian', what: 'Delegated to the factory' }],
  gates: [{ gate: 'merge', openedAt: 70_000, closedAt: 90_000, outcome: 'merged', decisionId: 'mg' }],
  findings: [
    { source: 'human', id: 'rv', at: 80_000, author: 'lilian-gh', pr: 3, kind: 'review', state: 'changes_requested' },
    { source: 'ai', runId: 'r2', at: 75_000, job: 'review', status: 'success', outcome: 'succeeded' },
  ],
  checks: [{ id: 'v', at: 61_000, check: 'verify', result: 'failed', runId: 'r1', job: 'dev', names: ['factory/anti-triche', 'factory/taille-du-diff'], red: null }],
  steps: [
    { job: 'dev', attempts: 2, tokens, attemptsWithoutTokens: 1, turns: 9, workMs: 120_000, costUsd: 0 },
    { job: 'review', attempts: 1, tokens: null, attemptsWithoutTokens: 1, turns: 3, workMs: 30_000, costUsd: 0 },
  ],
  attempts: [attempt(), attempt({ id: 'r2', job: 'review', role: 'reviewer' })],
  output: { status: 'done', summary: 'Export CSV added.', tests_added: ['export.test.ts'], why: '', assumptions: [], risks: ['large lists'], untested: [], review_hints: [] },
  transcript: { status: 'kept', lines: [{ kind: 'text', text: 'Adding the export.' }, { kind: 'tool', name: 'Bash', input: 'npm test' }] },
  ...patch,
});

const render = (d: RunDetailView) => renderToStaticMarkup(createElement(RunDetail, { detail: d, now: 100_000 }));

describe('the run detail page (ORC-298)', () => {
  it('a finished run shows its timeline, gates and decisions, findings, checks, cost per step, output and transcript', () => {
    const html = render(detail());
    for (const text of [
      'REL-1', 'succeeded',
      'Timeline', 'Delegated to the factory', 'dev ended: succeeded, 5 turns',
      'Gates and human decisions', 'merge', 'merged', 'Lilian', 'linear',
      'Findings', 'lilian-gh', 'changes_requested', 'AI review',
      'Checks', 'factory/anti-triche, factory/taille-du-diff', 'failed',
      'Cost per step', '37.0 k', '9 turns', '1 without tokens',
      'Structured output', 'Export CSV added.', 'large lists',
      'Transcript', 'Adding the export.', 'npm test',
    ]) expect(html, text).toContain(text);
    // The run's own events stand out in the ticket's timeline.
    expect(html).toMatch(/<li class="of-run"[^>]*>.*dev ended/);
  });

  it('says a transcript purged at 30 days, and one never written, instead of failing', () => {
    expect(render(detail({ transcript: { status: 'purged' } }))).toContain('Transcript purged: transcripts are kept 30 days.');
    expect(render(detail({ transcript: { status: 'none' } }))).toContain('No transcript recorded for this run.');
  });

  it('says what is missing rather than an empty table: no output, no gate, no finding, no check', () => {
    const html = render(detail({ output: null, gates: [], decisions: [], findings: [], checks: [] }));
    for (const text of ['No structured output: the run handed back nothing through submit_result.', 'No gate yet.', 'No human decision yet.', 'No finding yet.', 'No check yet.']) {
      expect(html, text).toContain(text);
    }
  });

  it('a run is addressed by #run/<id>; each attempt of the Measures page links to its detail', () => {
    expect(runHash('r-1')).toBe('#run/r-1');
    expect(runIdOf('#run/r-1')).toBe('r-1');
    expect(runIdOf('#measures')).toBeUndefined();
    const m = { mergedAt: null, tokens, attempts: 1, attemptsWithoutTokens: 0, firstTry: null, reworks: [], revertedWithin14Days: null, ciCost: null, messages: [], startedAt: 0, leadTimeMs: null, workMs: 60_000, costUsd: 0, reviewRounds: { ai: 0, human: 0 }, runs: [attempt()] } satisfies TicketMeasuresView;
    const t: MeasuredTicketView = { projectId: 'p', ticketId: 'REL-1', title: 'Export', logical: 'dev', blocked: false, blockCause: null, measures: m };
    const html = renderToStaticMarkup(createElement(Measures, { tickets: [t], now: 0, selected: 'p/REL-1', onSelect: () => undefined }));
    expect(html).toContain('href="#run/r1"');
  });
});
